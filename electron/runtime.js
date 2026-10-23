'use strict';
/**
 * The Electron runtime core: plans, approval, actions, receipts, and the
 * loopback HTTP contract.
 *
 * Deliberately free of any `require('electron')` so the whole safety surface is
 * testable under `node --test` on a bare interpreter, the same way bridge.py is
 * testable under unittest. main.js injects the two platform hooks it needs:
 * `openExternal` (Electron shell) and `cipher` (Electron safeStorage).
 *
 * Same rules as the Python bridge: the UI can name a command and an id, never
 * an action payload. Plans expire, are consumed once, and every receipt states
 * what actually happened.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const core = require('../web/core.js');
const { VERSION, createStore } = require('./config.js');
const wispr = require('./wispr.js');
const { createAccount, WisprAccountError, ACCOUNT_HTTP, CALLBACK_PATH } = require('./wispr_account.js');
const { McpError } = require('./mcp_client.js');
const { createManager } = require('./mcp_registry.js');
const { PRESETS } = require('./mcp_presets.js');
const llm = require('./llm_planner.js');
const { createWake } = require('./wake.js');
const pilotTools = require('./pilot.js');
const {
  createAgents, agentPhrase, agentById, buildCommand, publicCatalog, AgentError, withHandoff,
} = require('./agents.js');

const RUN_NAME = /^flowmesh-[A-Za-z0-9_-]{1,100}\.md$/;
const MAX_RECORD_BYTES = 300000;
const MAX_RUNS_LISTED = 100;

const PLAN_LIFETIME = 300;
const MAX_EVENTS = 200;
// Wispr connector: only a dictation this recent is actionable, and only this much of
// one will ever be typed.
const WISPR_MAX_AGE = 300;
const MAX_TYPED_CHARS = 2000;
const WISPR_HANDLED = new Map();
const MAX_BODY = 8192;
const ALLOWED_APPS = ['notepad', 'calculator'];
const ALLOWED_URLS = {
  project_board: ['board_url', 'https://github.com/HamzaShaikh-source/flowmesh/issues'],
  documentation: ['docs_url', 'https://github.com/HamzaShaikh-source/flowmesh/tree/main/docs'],
};
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Only the two allowlisted apps, on each platform, never a caller command. */
function appCommand(target, platform = process.platform) {
  if (!ALLOWED_APPS.includes(target)) return null;
  if (platform === 'win32') return target === 'notepad' ? ['notepad.exe'] : ['calc.exe'];
  if (platform === 'darwin') {
    return target === 'notepad' ? ['open', '-a', 'TextEdit'] : ['open', '-a', 'Calculator'];
  }
  const candidates =
    target === 'notepad'
      ? ['gedit', 'gnome-text-editor', 'kate', 'xed', 'mousepad']
      : ['gnome-calculator', 'kcalc', 'galculator'];
  for (const name of candidates) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return [candidate];
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function artifactDir(env = process.env) {
  const override = env.FLOWMESH_ARTIFACT_DIR;
  const directory = override || path.join(os.homedir(), 'FlowMesh', 'runs');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function recordMarkdown(plan, receipts) {
  const lastWithNote = [...plan.actions].reverse().find((action) => action.note);
  const command = (lastWithNote && lastWithNote.note) || plan.command || '';
  const source =
    {
      jev: 'Jev Choice',
      jev_unavailable: 'local rules (Jev unreachable)',
      builder: 'the tool builder',
      llm: "a language model's proposal, checked against each tool's schema",
    }[plan.source] || 'local rules';
  const lines = [
    `# FlowMesh run — ${plan.title}`,
    '',
    `- When: ${timestamp()}`,
    `- Route: \`${plan.route}\` via ${source}`,
    `- Plan: \`${plan.id.slice(0, 12)}…\` (single use)`,
    `- Platform: ${process.platform}`,
    '',
    '## Actions as approved',
    '',
  ];
  plan.actions.forEach((action, index) => {
    const value = action.value === undefined || action.value === null ? '' : ` (${action.value})`;
    lines.push(`${index + 1}. ${action.label}${value} — ${action.detail}`);
  });
  lines.push('', '## Receipts', '', '| # | Action | Surface | Status | Detail |', '| --- | --- | --- | --- | --- |');
  receipts.forEach((receipt, index) => {
    const detail = String(receipt.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| ${index + 1} | ${receipt.action.label} | ${receipt.action.surface} | ${receipt.status} | ${detail} |`,
    );
  });
  const withOutput = receipts.map((receipt, index) => [index + 1, receipt]).filter(([, receipt]) => receipt.output);
  if (withOutput.length) {
    lines.push('', '## Tool output (untrusted text from the tool, shown as received)', '');
    for (const [index, receipt] of withOutput) {
      lines.push(`### ${index}. ${receipt.action.label}`, '', '~~~text', String(receipt.output).replace(/~~~/g, '\\~\\~\\~'), '~~~', '');
    }
  }
  lines.push('', '## What was said, verbatim', '', '~~~text', command.replace(/~~~/g, '\\~\\~\\~'), '~~~', '');
  lines.push(
    'A `sent` receipt means the request left FlowMesh. `verified` means FlowMesh observed the',
    'result (a file it wrote and hashed, or a device state it read back). Anything the runtime',
    'could not do is recorded as `not_configured`, `unavailable`, `denied`, or `failed`.',
    '',
  );
  return lines.join('\n');
}

/** Run records FlowMesh itself wrote, newest first. Names only ever come from this listing. */
function listRuns(env = process.env) {
  const directory = artifactDir(env);
  const entries = [];
  for (const name of fs.readdirSync(directory)) {
    if (!RUN_NAME.test(name)) continue;
    const file = path.join(directory, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let title = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(200);
      const read = fs.readSync(fd, buffer, 0, 200, 0);
      fs.closeSync(fd);
      title = buffer.toString('utf8', 0, read).split(/\r?\n/)[0].replace(/^# FlowMesh run — /, '').replace(/^# /, '').trim().slice(0, 80);
    } catch {
      /* the listing still works without a title */
    }
    entries.push({ name, bytes: stat.size, title, modified: stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }
  entries.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return entries.slice(0, MAX_RUNS_LISTED);
}

/** One record by name. The name must match the generated pattern and resolve inside the
    artifact directory, so no path, traversal or other file can ever be read through this. */
function readRun(name, env = process.env) {
  if (typeof name !== 'string' || !RUN_NAME.test(name)) return null;
  const directory = path.resolve(artifactDir(env));
  const file = path.resolve(directory, name);
  if (path.dirname(file) !== directory) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const data = fs.readFileSync(file).subarray(0, MAX_RECORD_BYTES);
    return { name, text: data.toString('utf8'), truncated: stat.size > MAX_RECORD_BYTES };
  } catch {
    return null;
  }
}

function createRuntime(options = {}) {
  const {
    webDir = path.join(__dirname, '..', 'web'),
    store = createStore(),
    openExternal = null,
    env = process.env,
    platform = process.platform,
    fetchImpl = globalThis.fetch,
    wisprAccount = null,
    mcpManager = null,
    agentsManager = null,
    wakeManager = null,
    capturePage = null,
    pressVolumeImpl = null,
    wakeTimerMs = 3000,
    openTerminal = null,
    confirmProgram = null,
  } = options;

  const sessionToken = crypto.randomBytes(24).toString('base64url');
  const account = wisprAccount || createAccount({ store, version: VERSION });
  const mcp = mcpManager || createManager({ store, version: VERSION, fetchImpl });
  const agents = agentsManager || createAgents({ store, env, platform });
  const wake = wakeManager || createWake({ store, platform });
  const pilotEnabled = () => String(env.FLOWMESH_PILOT || '').toLowerCase() !== 'off';
  const wakeEnabled = () => String(env.FLOWMESH_WAKE || '').toLowerCase() !== 'off';
  const agentsEnabled = () => String(env.FLOWMESH_AGENTS || '').toLowerCase() !== 'off';
  const plans = new Map();
  const events = [];
  let timer = null;
  let timerEnd = null;

  const capabilities = () => {
    const s = store.settings();
    const configured = Boolean(s.ha_url && store.secret('ha_token'));
    return {
      open_url: 'ready',
      launch_app: appCommand('notepad', platform) || appCommand('calculator', platform) ? 'ready' : 'unavailable',
      timer: 'ready',
      write_note: 'ready',
      notify: configured && s.phone_service.startsWith('mobile_app_') ? 'ready' : 'not_configured',
      light: configured && s.light_entity.startsWith('light.') ? 'ready' : 'not_configured',
      tools: mcp.servers().some((server) => server.enabled) ? 'ready' : 'not_configured',
      agents: agentsEnabled() && Object.values(agents.detect().agents).some((a) => a.installed) ? 'ready' : 'not_configured',
      model: llm.configured(store) ? 'ready' : 'not_configured',
    };
  };

  async function jevRoute(command, choices) {
    const key = store.secret('jev_key');
    if (!key) return { route: null, source: 'local', confidence: null };
    const criteria = {};
    for (const name of choices) criteria[name] = `Run the ${name.replace(/_/g, ' ')} workflow`;
    criteria.none = "No registered workflow matches the user's request";
    const body = {
      model: 'jev-latest',
      state: { spoken_command: command, available_workflows: choices },
      questions: {
        route: {
          type: 'choice',
          instructions: 'Which registered workflow best matches the spoken command? Choose none when unclear.',
          criteria,
        },
      },
    };
    try {
      const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const answer = (await response.json()).answers.route;
      const confidence = answer.confidence;
      const route =
        choices.includes(answer.choice) && typeof confidence === 'number' && confidence >= 0.65
          ? answer.choice
          : null;
      return { route, source: 'jev', confidence };
    } catch (error) {
      return { route: null, source: 'jev_unavailable', error: error.name };
    }
  }

  async function preparePlan(rawCommand, dictation, forcedRoute = null) {
    if (!core.commandIsUsable(rawCommand) || core.isForbidden(String(rawCommand).trim())) return null;
    const command = String(rawCommand).trim();
    let decision;
    let route;
    if (forcedRoute && Object.prototype.hasOwnProperty.call(core.WORKFLOWS, forcedRoute)) {
      // A model chose this routine; the actions are still produced by the fixed planner,
      // so a model can pick a routine but never shape its effects.
      decision = { route: forcedRoute, source: 'llm', confidence: null };
      route = forcedRoute;
    } else {
      decision = await jevRoute(command, Object.keys(core.WORKFLOWS));
      route = decision.source === 'jev' ? decision.route : core.localRoute(command);
    }
    if (!(route in core.WORKFLOWS)) return null;
    const payload = {
      id: crypto.randomBytes(24).toString('base64url'),
      route,
      ...core.planPayload(route, command, decision.source, decision.confidence),
      command,
      expires: Date.now() + PLAN_LIFETIME * 1000,
      created: timestamp(),
    };
    // Provenance only: where these exact words came from. Retained on the plan (the
    // run record needs it) but never echoed to the client.
    if (dictation && typeof dictation === 'object') payload.dictation = dictation;
    const now = Date.now();
    for (const [key, value] of plans) if (value.expires < now) plans.delete(key);
    plans.set(payload.id, payload);
    const { expires, command: _ignored, dictation: _provenance, ...visible } = payload;
    return visible;
  }

  /** A plan whose actions are MCP tool calls. Throws Error with a sentence. */
  async function prepareToolPlan(calls, command = '', source = 'builder', note = '') {
    const actions = await mcp.planActions(calls);
    const count = actions.length;
    const worst = actions.some((a) => a.risk === 'danger') ? 'danger' : actions.some((a) => a.risk === 'write') ? 'write' : 'read';
    const autoRun = actions.every((a) => a.auto_ok);
    if (!autoRun) {
      actions.push({
        kind: 'write_note', target: 'run_record', label: 'Save run record',
        detail: "Markdown file in your FlowMesh folder, including each tool's output", surface: 'pc',
        note: command || '(built in the tool builder, not dictated)',
      });
    }
    const payload = {
      id: crypto.randomBytes(24).toString('base64url'),
      route: 'tools',
      title: count > 1 ? 'Tool run' : 'Tool call',
      description: `${count} call${count !== 1 ? 's' : ''}, highest risk: ${worst}. Each runs once, exactly as shown.`,
      source,
      confidence: null,
      also: [],
      actions,
      risk: worst,
      needs_confirm: worst === 'danger',
      auto_run: autoRun,
      expires: Date.now() + PLAN_LIFETIME * 1000,
      created: timestamp(),
      command: command || note,
    };
    const now = Date.now();
    for (const [key, value] of plans) if (value.expires < now) plans.delete(key);
    plans.set(payload.id, payload);
    const { expires, command: _command, dictation: _dictation, ...visible } = payload;
    return visible;
  }

  /** The command line that will run, with the task shown as a placeholder (it goes on stdin or a file). */
  function agentPreview(agent, mode, folder) {
    const [args, stdin] = buildCommand(agent, mode, folder, '<task>', '<task file>');
    const shown = [agent.command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    return shown + (stdin !== null ? '   (task sent on stdin)' : '');
  }

  /** Store a plan made of agent_run steps (plus the run record). Risk is the highest step's. */
  function registerAgentPlan(actions, title, description, command, source, note) {
    for (const action of actions) {
      if (action.kind === 'council_run') {
        action.about = 'Every member runs read-only. Nothing in the folder is changed.';
        action.command = action.members.map((member) => {
          const memberAgent = agentById(agents.catalog, member.agent);
          const memberMode = memberAgent.modes.find((m) => m.id === member.mode);
          return `${member.label}: ${agentPreview(memberAgent, memberMode, action.workspace_path)}`;
        }).join('\n');
        continue;
      }
      const agent = agentById(agents.catalog, action.agent);
      const mode = agent.modes.find((m) => m.id === action.mode);
      action.about = mode.about;
      action.command = agentPreview(agent, mode, action.workspace_path);
    }
    const steps = [...actions, {
      kind: 'write_note', target: 'run_record', label: 'Save run record',
      detail: "Markdown file in your FlowMesh folder, including every agent's output", surface: 'pc',
      note: command || note,
    }];
    const risk = actions.some((a) => a.risk === 'danger') ? 'danger' : actions.some((a) => a.risk === 'write') ? 'write' : 'read';
    const payload = {
      id: crypto.randomBytes(24).toString('base64url'),
      route: 'agent',
      title,
      description,
      source,
      confidence: null,
      also: [],
      actions: steps,
      risk,
      needs_confirm: risk === 'danger',
      auto_run: false,
      expires: Date.now() + PLAN_LIFETIME * 1000,
      created: timestamp(),
      command: command || actions[0].prompt,
    };
    const now = Date.now();
    for (const [key, value] of plans) if (value.expires < now) plans.delete(key);
    plans.set(payload.id, payload);
    const { expires, command: _command, dictation: _dictation, ...visible } = payload;
    return visible;
  }

  /** A plan whose one effect is a coding agent working in a project folder. Throws AgentError.
      The risk is the agent's permission mode, chosen by FlowMesh and never by a model. */
  function prepareAgentPlan(agentId, workspaceId, modeId, prompt, command = '', source = 'builder') {
    const action = agents.planAction(agentId, workspaceId, modeId, prompt);
    const agent = agentById(agents.catalog, action.agent);
    const mode = agent.modes.find((m) => m.id === action.mode);
    const description = `${action.agent_label} will work in ${action.workspace_path} (${mode.label.toLowerCase()}). ${mode.about}`;
    return registerAgentPlan([action], 'Coding task', description, command, source, `(built on the Code page: ${action.prompt.slice(0, 200)})`);
  }

  const COUNCIL_TITLES = { debate: 'Debate: propose, critique, vote', judge: 'Judge panel: blind scoring' };

  /** A council: several agents think together, read-only, and FlowMesh reports their opinions. Throws AgentError. */
  function prepareCouncilPlan(kind, workspaceId, prompt, agentIds, command = '', source = 'builder') {
    const action = agents.planCouncil(kind, workspaceId, prompt, agentIds);
    const rounds = kind === 'debate'
      ? 'Four rounds: each agent proposes, critiques the others anonymously, answers the critique, then votes (never for its own).'
      : 'Each agent scores the folder blind on a fixed rubric; the median is used and caps from measured facts apply.';
    const description = `${action.members.length} agents in ${action.workspace_path}, all read-only. ${rounds} This changes nothing, and the result is the agents' opinion that FlowMesh does not verify.`;
    return registerAgentPlan([action], COUNCIL_TITLES[kind], description, command, source, `(built on the Code page: ${action.prompt.slice(0, 200)})`);
  }

  const RELAY_TITLES = { review: 'Work, then review', chain: 'Plan, build, review', compare: 'Compare agents' };

  /** Several agents in one plan: each step is a normal, separately validated coding task, and a later step
      receives the previous step's output as quoted, untrusted data. Throws AgentError. */
  function prepareRelayPlan(kind, workspaceId, prompt, agentIds, modeId = 'edit', command = '', source = 'builder') {
    const actions = agents.planRelay(kind, workspaceId, prompt, agentIds, modeId);
    const steps = actions.map((a, i) => `${i + 1}. ${a.agent_label} (${a.role}, ${a.mode_label.toLowerCase()})`).join('; ');
    const description = `${actions.length} agents in ${actions[0].workspace_path}: ${steps}. ${kind === 'compare'
      ? 'Each answers on its own, read-only.'
      : 'Each step starts only if the one before it finished cleanly, and sees its output as untrusted text.'}`;
    return registerAgentPlan(actions, RELAY_TITLES[kind], description, command, source, `(built on the Code page: ${actions[0].prompt.slice(0, 200)})`);
  }

  /** Plan a sentence. With a model it chooses a routine or tool calls (a proposal, re-validated);
      without one the deterministic rules apply exactly as before. */
  async function planCommand(rawCommand, dictation, context) {
    const generic = 'Command is unsupported, unclear, or not allowed';
    if (!core.commandIsUsable(rawCommand) || core.isForbidden(String(rawCommand).trim())) {
      return { plan: null, message: generic, status: 422 };
    }
    const command = String(rawCommand).trim();
    const phrase = agentsEnabled() ? agentPhrase(command) : null;
    if (phrase) {
      // "ask codex to fix the failing test": the agent and the task come from the sentence; the
      // folder and mode come from your saved defaults and are shown in the plan before anything runs.
      const [agentId, task] = phrase;
      const saved = agents.config();
      const agent = agentById(agents.catalog, agentId);
      if (!agent) return { plan: null, message: 'That coding agent is not supported.', status: 422 };
      const mode = agent.modes.some((m) => m.id === saved.default_mode)
        ? saved.default_mode : agent.modes.some((m) => m.id === 'edit') ? 'edit' : agent.modes[0].id;
      try {
        return { plan: prepareAgentPlan(agentId, saved.default_workspace, mode, task, command, 'agent'), message: '', status: 200 };
      } catch (error) {
        if (error instanceof AgentError) return { plan: null, message: error.userMessage, status: 422 };
        throw error;
      }
    }
    let notice = '';
    if (llm.configured(store)) {
      const { tools } = await mcp.catalog();
      const routines = Object.fromEntries(Object.entries(core.WORKFLOWS).map(([name, [title, text]]) => [name, `${title}. ${text}`]));
      let decision = null;
      try {
        decision = await llm.decide({ store, fetchImpl }, command, routines, tools, typeof context === 'string' ? context : '');
      } catch (error) {
        if (!(error instanceof llm.LlmError)) throw error;
        notice = error.userMessage;
      }
      if (decision) {
        if (decision.kind === 'calls') {
          try {
            return { plan: await prepareToolPlan(decision.calls, command, 'llm'), message: '', status: 200 };
          } catch (error) {
            return { plan: null, message: `The model proposed a call FlowMesh rejected: ${error.message}`, status: 422 };
          }
        }
        if (decision.kind === 'routine') {
          const plan = await preparePlan(command, dictation, decision.routine);
          return plan ? { plan, message: '', status: 200 } : { plan: null, message: generic, status: 422 };
        }
        return { plan: null, message: decision.reply || generic, status: 422 };
      }
    }
    const plan = await preparePlan(command, dictation);
    if (plan === null) return { plan: null, message: `${notice ? `${notice} ` : ''}${generic}`, status: notice ? 502 : 422 };
    if (notice) plan.notice = `${notice} Planned with local rules instead.`;
    return { plan, message: '', status: 200 };
  }

  function cancelPlan(planId) {
    if (typeof planId === 'string') plans.delete(planId);
    return { cancelled: true };
  }

  function writeRecord(plan, receipts) {
    try {
      const directory = artifactDir(env);
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[-:]/g, '')
        .replace('T', '-');
      const name = `flowmesh-${stamp}-${plan.route}-${plan.id.slice(0, 6)}.md`;
      const file = path.join(directory, name);
      const data = Buffer.from(recordMarkdown(plan, receipts), 'utf8');
      const temporary = path.join(directory, `.${name}.tmp`);
      fs.writeFileSync(temporary, data);
      fs.renameSync(temporary, file);
      return {
        status: 'verified',
        detail: `Wrote ${name} (${data.length} bytes)`,
        path: file,
        bytes: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      };
    } catch (error) {
      return { status: 'failed', detail: `Could not write the record (${error.name})` };
    }
  }

  function startFocusTimer(minutes) {
    if (timer) clearTimeout(timer);
    timerEnd = Date.now() + minutes * 60 * 1000;
    timer = setTimeout(() => {
      timer = null;
      timerEnd = null;
      events.push({
        at: timestamp(),
        action: { kind: 'timer', label: 'Focus timer complete', surface: 'pc' },
        status: 'verified',
        detail: `${minutes} minute focus block finished`,
      });
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    }, minutes * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    return { status: 'verified', detail: `Timer scheduled for ${minutes} minutes`, timer_end: timerEnd };
  }

  async function homeAssistant(service, domain, data) {
    const base = store.settings().ha_url.replace(/\/+$/, '');
    const token = store.secret('ha_token');
    if (!base || !token) return { status: 'not_configured', detail: 'Home Assistant is not configured' };
    try {
      const response = await fetchImpl(`${base}/api/services/${domain}/${service}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(8000),
      });
      await response.text();
      if (!response.ok) return { status: 'failed', detail: `HTTP ${response.status}` };
      return { status: 'sent', detail: 'Home Assistant accepted the service call' };
    } catch (error) {
      return { status: 'failed', detail: error.name };
    }
  }

  async function homeState(entity) {
    const base = store.settings().ha_url.replace(/\/+$/, '');
    const token = store.secret('ha_token');
    if (!base || !token) return null;
    try {
      const response = await fetchImpl(`${base}/api/states/${entity}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      return await response.json();
    } catch {
      return null;
    }
  }

  /** Run one approved MCP call and report only what FlowMesh actually knows. A tool
      answering is not proof its effect happened, so a good answer is `returned`, never
      `verified`; a timeout is `unknown`. */
  async function performMcp(action) {
    const { server, tool, arguments: args } = action;
    if (typeof server !== 'string' || typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      return { status: 'denied', detail: 'Tool call is malformed' };
    }
    let result;
    try {
      result = await mcp.call(server, tool, args);
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      if (error.kind === 'timeout') {
        return { status: 'unknown', detail: `${error.userMessage} The effect may or may not have happened.` };
      }
      const gone = ['unavailable', 'disabled', 'unknown_server'].includes(error.kind);
      return { status: gone ? 'unavailable' : 'failed', detail: error.userMessage };
    }
    const suffix = result.truncated ? ' Output was truncated.' : '';
    if (result.is_error) return { status: 'failed', detail: `The tool reported an error.${suffix}`, output: result.text };
    return {
      status: 'returned',
      detail: `The tool returned a result. FlowMesh did not independently verify its effect.${suffix}`,
      output: result.text,
    };
  }

  async function perform(action) {
    const kind = action.kind;
    const target = action.target;
    if (kind === 'mcp_call') return performMcp(action);
    if (kind === 'council_run') {
      return agentsEnabled() ? agents.runCouncil(action) : { status: 'denied', detail: 'Coding agents are disabled on this install (FLOWMESH_AGENTS=off).' };
    }
    if (kind === 'agent_run') {
      return agentsEnabled() ? agents.run(action) : { status: 'denied', detail: 'Coding agents are disabled on this install (FLOWMESH_AGENTS=off).' };
    }
    if (kind === 'open_url' && target in ALLOWED_URLS) {
      const [field, fallback] = ALLOWED_URLS[target];
      const url = store.settings()[field] || fallback;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { status: 'denied', detail: 'Only HTTP(S) destinations are allowed' };
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { status: 'denied', detail: 'Only HTTP(S) destinations are allowed' };
      }
      if (!openExternal) return { status: 'unavailable', detail: 'No browser adapter in this runtime' };
      try {
        await openExternal(url);
        return { status: 'sent', detail: `Browser open requested for ${url}` };
      } catch (error) {
        return { status: 'failed', detail: error.name };
      }
    }
    if (kind === 'launch_app' && ALLOWED_APPS.includes(target)) {
      const command = appCommand(target, platform);
      if (!command) return { status: 'unavailable', detail: 'No allowlisted app found on this computer' };
      const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore', shell: false });
      child.unref();
      return { status: 'sent', detail: `Launch requested: ${path.basename(command[command.length - 1])}` };
    }
    if (kind === 'light' && target === 'desk_light') {
      const brightness = action.value;
      if (!Number.isInteger(brightness) || brightness < 1 || brightness > 100) {
        return { status: 'denied', detail: 'Brightness must be 1–100' };
      }
      const entity = store.settings().light_entity;
      if (!entity.startsWith('light.')) {
        return { status: 'not_configured', detail: 'No request sent — add a Home Assistant light in Settings' };
      }
      const result = await homeAssistant('turn_on', 'light', { entity_id: entity, brightness_pct: brightness });
      if (result.status !== 'sent') return result;
      const observed = await homeState(entity);
      const actual = observed && observed.attributes ? observed.attributes.brightness : undefined;
      if (
        observed &&
        observed.state === 'on' &&
        Number.isInteger(actual) &&
        Math.abs(Math.round((actual / 255) * 100) - brightness) <= 2
      ) {
        return { status: 'verified', detail: `Home Assistant read back ${brightness}% brightness` };
      }
      return { status: 'unknown', detail: 'Command sent; device state could not be verified' };
    }
    if (kind === 'notify' && target === 'my_phone') {
      const service = store.settings().phone_service;
      if (!service.startsWith('mobile_app_')) {
        return { status: 'not_configured', detail: 'No request sent — add a Companion service in Settings' };
      }
      const message = action.message;
      if (typeof message !== 'string' || message.length < 1 || message.length > 160) {
        return { status: 'denied', detail: 'Notification text must be 1–160 characters' };
      }
      return homeAssistant(service, 'notify', { title: 'FlowMesh', message });
    }
    if (kind === 'timer' && target === 'focus_timer') {
      const minutes = action.value;
      if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 180) return startFocusTimer(minutes);
    }
    return { status: 'denied', detail: 'Action is not registered' };
  }

  async function executePlan(planId) {
    const plan = plans.get(planId);
    plans.delete(planId);
    if (!plan || plan.expires < Date.now()) return null;
    // One dictation is typed or run once. Recorded at consumption time so a partial
    // run still cannot be replayed.
    if (plan.dictation && plan.dictation.id) WISPR_HANDLED.set(plan.dictation.id, plan.id);
    const actions = plan.actions;
    const slots = new Array(actions.length).fill(null);
    const noteSlots = [];
    const startedAll = Date.now();
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (action.kind === 'write_note') {
        noteSlots.push(index);
        continue;
      }
      const started = Date.now();
      const sourceIndex = action.handoff_from;
      let toRun = action;
      if (Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < index) {
        const earlier = slots[sourceIndex];
        if (!earlier || earlier.status !== 'returned') {
          slots[index] = { status: 'denied', detail: 'Skipped: the step before it did not finish cleanly.', duration_ms: 0 };
          continue;
        }
        toRun = withHandoff(action, actions[sourceIndex].label || 'the previous step', earlier.output || '');
      }
      let result;
      try {
        result = await perform(toRun);
      } catch (error) {
        result = { status: 'failed', detail: error.name };
      }
      result.duration_ms = Date.now() - started;
      slots[index] = result;
    }
    if (noteSlots.length) {
      const written = slots
        .map((slot, index) => (slot
          ? { action: actions[index], status: slot.status, detail: slot.detail, output: slot.output || '' }
          : null))
        .filter(Boolean);
      const receipt = writeRecord(plan, written);
      for (const index of noteSlots) slots[index] = { ...receipt };
    }
    const results = actions.map((action, index) => {
      const receipt = slots[index] || { status: 'failed', detail: 'No receipt produced' };
      const subset = {};
      for (const key of ['kind', 'target', 'label', 'surface', 'value', 'risk']) {
        if (key in action) subset[key] = action[key];
      }
      const event = { at: timestamp(), action: subset, ...receipt };
      // The caller gets the full output. The in-memory log keeps a short head only, so
      // 200 events can never hold 200 x 20 kB of third-party text.
      const { output, ...logged } = event;
      if (output) {
        logged.output_preview = output.slice(0, 600);
        logged.output_chars = output.length;
      }
      events.push(logged);
      return event;
    });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    void startedAll;
    return results;
  }

  /* ---------------- Wispr Flow (read-only) ----------------
     Twin of bridge.py's connector. Same states, same refusals, same honesty: this
     reads the user's own dictation history and executes nothing. */

  function wisprOverview() {
    const state = wispr.status();
    const payload = {
      state: state.state,
      path: state.path,
      detail: state.detail,
      dictations: state.rows || 0,
      usable_dictations: state.usable_rows || 0,
      newest_timestamp: state.newest_timestamp || '',
      read_only: true,
      supported_api: false,
      ignored_columns: wispr.BLOB_COLUMNS.slice(),
      handled: WISPR_HANDLED.size,
      freshness_seconds: WISPR_MAX_AGE,
    };
    if (state.state === 'connected') {
      const summary = wispr.stats();
      payload.stats = {
        dictations: summary.dictations || 0,
        words: summary.words || 0,
        corrected_words: summary.corrected_words || 0,
        avg_latency_ms: summary.avg_latency_ms,
        median_latency_ms: summary.median_latency_ms,
        dictionary_entries: summary.dictionary_entries || 0,
        snippets: summary.snippets || 0,
        apps: (summary.apps || []).slice(0, 5),
      };
      // Metadata only. The overview never carries dictation text.
      const fresh = wispr.latest(WISPR_MAX_AGE);
      payload.latest = fresh
        ? { age_seconds: fresh.age_seconds, app: fresh.app, num_words: fresh.num_words }
        : null;
    }
    return payload;
  }

  function wisprLatest() {
    const state = wispr.status();
    if (state.state !== 'connected') {
      return {
        state: state.state, detail: state.detail,
        freshness: wispr.describeFreshness(null), age_seconds: null,
      };
    }
    const transcript = wispr.latest(WISPR_MAX_AGE);
    if (transcript === null) {
      return {
        state: 'none',
        detail: 'No usable dictation inside the freshness window.',
        freshness: wispr.describeFreshness(null), age_seconds: null,
      };
    }
    const handledPlan = WISPR_HANDLED.get(transcript.id) || null;
    return {
      state: 'ready',
      text: transcript.text,
      id: transcript.id,
      transcript_id: transcript.id,
      app: transcript.app,
      dictated_into: transcript.app,
      age_seconds: transcript.age_seconds,
      num_words: transcript.num_words,
      source_column: transcript.source_column,
      freshness: wispr.describeFreshness(transcript),
      already_executed: Boolean(handledPlan),
      handled_plan: handledPlan,
      provenance: {
        source: 'wispr_history',
        id: transcript.id,
        timestamp: transcript.timestamp,
        app: transcript.app,
        edited: transcript.source_column === 'editedText',
      },
    };
  }

  function wisprDictionary() {
    // dictionary() returns a bare array, so the count is its length. Reading named
    // fields off it would throw.
    const entries = wispr.dictionary();
    return {
      state: wispr.status().state,
      entries: entries.length,
      phrases: entries.map((entry) => String(entry.phrase || '').length),
    };
  }

  // Type a transcript into whatever app currently has focus. The text is re-read
  // from the database by id, so a page can never send its own string to the keyboard.
  function typeDictation(transcriptId) {
    if (typeof transcriptId !== 'string' || !transcriptId.trim()) return null;
    const transcript = wispr.get(transcriptId.trim());
    if (transcript === null) {
      return { error: 'That dictation is no longer in your history.', status: 409 };
    }
    const text = String(transcript.text || '');
    if (!text) return { error: 'That dictation has no text to type.', status: 409 };
    if (text.length > MAX_TYPED_CHARS) {
      return { error: 'That dictation is too long to type (' + text.length + ' characters).', status: 409 };
    }
    const delivered = typeIntoFocusedApp(text);
    if (delivered.ok) WISPR_HANDLED.set(transcript.id, 'typed');
    return {
      receipt: {
        // 'sent' not 'verified': we handed keystrokes to the OS and cannot read back
        // what the focused app did with them.
        status: delivered.ok ? 'sent' : delivered.status,
        detail: delivered.detail,
        label: 'Type your last dictation into the focused app',
        surface: 'pc',
        characters: text.length,
      },
    };
  }

  function typeIntoFocusedApp(text) {
    const helper = {
      darwin: { cmd: 'osascript', args: ['-e', 'tell application "System Events" to keystroke (system attribute "FLOWMESH_TYPE_TEXT")'] },
      linux: { cmd: 'xdotool', args: ['type', '--clearmodifiers', '--', text] },
      win32: {
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command',
          '[void][System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms"); [System.Windows.Forms.SendKeys]::SendWait($env:FLOWMESH_TYPE_TEXT)'],
      },
    }[process.platform];
    if (!helper) return { ok: false, status: 'not_configured', detail: 'Typing is not implemented on ' + process.platform + '.' };
    try {
      // The text travels in the environment, never in the command line, so nothing
      // can be interpreted as a shell metacharacter.
      const result = spawnSync(helper.cmd, helper.args, {
        env: { ...process.env, FLOWMESH_TYPE_TEXT: text },
        timeout: 10000,
        windowsHide: true,
      });
      if (result.error) {
        return { ok: false, status: 'not_configured', detail: helper.cmd + ' is not available: ' + result.error.message };
      }
      if (result.status !== 0) {
        return { ok: false, status: 'failed', detail: helper.cmd + ' exited ' + result.status + '.' };
      }
      return {
        ok: true,
        status: 'sent',
        detail: 'Sent ' + text.length + ' characters as keystrokes to the focused window via ' + helper.cmd +
          '. The OS accepted them; FlowMesh cannot read back what the app did with them, so this is sent, not verified.',
      };
    } catch (error) {
      return { ok: false, status: 'failed', detail: 'Typing failed: ' + error.message };
    }
  }

  function status() {
    return {
      mode: 'desktop_app',
      version: VERSION,
      platform,
      capabilities: capabilities(),
      artifact_dir: artifactDir(env),
      jev: Boolean(store.secret('jev_key')),
      home_assistant: Boolean(store.settings().ha_url && store.secret('ha_token')),
      windows: platform === 'win32',
      timer_end: timerEnd,
    };
  }

  async function mcpPost(pathname, body, response) {
    try {
      if (pathname === '/api/mcp/servers') {
        const { server } = body;
        const existing = server && typeof server === 'object' ? mcp.get(server.id) : null;
        const changesProgram = server && typeof server === 'object' && server.transport === 'stdio' && (
          !existing || existing.command !== server.command || JSON.stringify(existing.args) !== JSON.stringify(server.args));
        if (server && typeof server === 'object' && server.transport === 'stdio' && String(env.FLOWMESH_MCP_STDIO || '').toLowerCase() === 'off') {
          sendJson(response, { error: 'Local-program MCP servers are disabled on this install (FLOWMESH_MCP_STDIO=off).', kind: 'disabled' }, 403);
          return;
        }
        if (changesProgram && body.acknowledged !== true) {
          sendJson(response, {
            error: 'Adding or changing a stdio server runs a program on this computer. Acknowledge it first.',
            needs_acknowledgement: true,
          }, 428);
          return;
        }
        if (changesProgram && confirmProgram && !(await confirmProgram(server))) {
          sendJson(response, { error: 'You declined to let FlowMesh run that program.', kind: 'declined' }, 403);
          return;
        }
        sendJson(response, { server: await mcp.upsert(server) });
      } else if (pathname === '/api/mcp/servers/remove') {
        if (typeof body.id !== 'string' || !(await mcp.remove(body.id))) sendJson(response, { error: 'No such server' }, 404);
        else sendJson(response, { removed: true });
      } else if (pathname === '/api/mcp/servers/test') {
        if (typeof body.id !== 'string') sendJson(response, { error: 'Invalid request' }, 400);
        else sendJson(response, await mcp.test(body.id));
      } else if (pathname === '/api/mcp/plan') {
        if (Object.keys(body).some((key) => key !== 'calls' && key !== 'note')) {
          sendJson(response, { error: 'Invalid request' }, 400);
          return;
        }
        const note = typeof body.note === 'string' ? body.note.slice(0, 500) : '';
        sendJson(response, await prepareToolPlan(body.calls, '', 'builder', note));
      } else {
        sendJson(response, { error: 'Not found' }, 404);
      }
    } catch (error) {
      if (error instanceof McpError) sendJson(response, { error: error.userMessage, kind: error.kind }, 502);
      else if (error instanceof Error && error.constructor === Error) sendJson(response, { error: error.message }, 422);
      else sendJson(response, { error: 'Internal error' }, 500);
    }
  }

  async function pilotPost(pathname, body, response) {
    if (!pilotEnabled()) {
      sendJson(response, { error: 'The page pilot is disabled on this install (FLOWMESH_PILOT=off).', kind: 'disabled' }, 403);
      return;
    }
    if (pathname === '/api/pilot/volume') {
      if (Object.keys(body).some((k) => !['action', 'steps'].includes(k))) {
        sendJson(response, { error: 'Invalid request' }, 400);
        return;
      }
      const result = pressVolumeImpl ? pressVolumeImpl(body.action, body.steps) : pilotTools.pressVolume(body.action, body.steps, { platform });
      const status = result.ok ? 200 : { bad_request: 400, unsupported: 501 }[result.kind] || 502;
      sendJson(response, result.ok ? result : { error: result.detail, kind: result.kind }, status);
    } else if (pathname === '/api/pilot/screenshot') {
      if (Object.keys(body).length) {
        sendJson(response, { error: 'Invalid request' }, 400);
        return;
      }
      if (!capturePage) {
        sendJson(response, { error: "This runtime has no window to photograph. In a browser, FlowMesh uses the browser's own tab capture.", kind: 'unsupported' }, 501);
        return;
      }
      try {
        const png = await capturePage();
        if (!png) throw new Error('There is no window to capture.');
        sendJson(response, pilotTools.saveScreenshot(png, artifactDir(env)));
      } catch (error) {
        sendJson(response, { error: `Could not take the screenshot (${error.message}).`, kind: 'failed' }, 502);
      }
    } else {
      sendJson(response, { error: 'Not found' }, 404);
    }
  }

  function wakePost(body, response) {
    if (!wakeEnabled()) {
      sendJson(response, { error: 'The wake word is disabled on this install (FLOWMESH_WAKE=off).', kind: 'disabled' }, 403);
      return;
    }
    const allowed = ['enabled', 'acknowledged', 'summon', 'hold_s', 'test_summon'];
    if (Object.keys(body).some((k) => !allowed.includes(k))
      || ['enabled', 'acknowledged', 'test_summon'].some((k) => k in body && typeof body[k] !== 'boolean')) {
      sendJson(response, { error: 'Invalid request' }, 400);
      return;
    }
    try {
      if ('summon' in body || 'hold_s' in body) {
        wake.setConfig(Object.fromEntries(['summon', 'hold_s'].filter((k) => k in body).map((k) => [k, body[k]])));
      }
      if (body.test_summon) {
        if (!wake.config().summon) {
          sendJson(response, { error: 'Set a Wispr shortcut first.' }, 422);
          return;
        }
        // Give the person three seconds to click into the window the shortcut should reach.
        const timer = setTimeout(() => wake.summon(), wakeTimerMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      if (body.enabled === true) {
        if (body.acknowledged !== true) {
          sendJson(response, { error: 'The wake word keeps your microphone open while it is on. Acknowledge it first.', needs_acknowledgement: true }, 428);
          return;
        }
        wake.start();
      } else if (body.enabled === false) {
        wake.stop();
      }
    } catch (error) {
      sendJson(response, { error: error.message }, 422);
      return;
    }
    sendJson(response, { enabled: true, ...wake.status() });
  }

  async function agentsPost(pathname, body, response) {
    if (!agentsEnabled()) {
      sendJson(response, { error: 'Coding agents are disabled on this install (FLOWMESH_AGENTS=off).', kind: 'disabled' }, 403);
      return;
    }
    try {
      if (pathname === '/api/agents/workspaces') {
        if (body.acknowledged !== true) {
          sendJson(response, {
            error: 'A coding agent can read and change everything in a project folder. Acknowledge it first.',
            needs_acknowledgement: true,
          }, 428);
          return;
        }
        sendJson(response, { workspace: agents.upsertWorkspace({ id: body.id, label: body.label, path: body.path }) });
      } else if (pathname === '/api/agents/workspaces/remove') {
        if (typeof body.id !== 'string' || !agents.removeWorkspace(body.id)) sendJson(response, { error: 'No such project folder' }, 404);
        else sendJson(response, { removed: true });
      } else if (pathname === '/api/agents/defaults') {
        sendJson(response, { config: agents.setDefaults(body) });
      } else if (pathname === '/api/agents/refresh') {
        sendJson(response, agents.detect(true));
      } else if (pathname === '/api/agents/plan') {
        if (Object.keys(body).some((key) => !['agent', 'workspace', 'mode', 'prompt'].includes(key))) {
          sendJson(response, { error: 'Invalid request' }, 400);
          return;
        }
        sendJson(response, prepareAgentPlan(body.agent, body.workspace, body.mode, body.prompt));
      } else if (pathname === '/api/agents/council') {
        if (Object.keys(body).some((key) => !['kind', 'workspace', 'prompt', 'agents'].includes(key))) {
          sendJson(response, { error: 'Invalid request' }, 400);
          return;
        }
        sendJson(response, prepareCouncilPlan(body.kind, body.workspace, body.prompt, body.agents));
      } else if (pathname === '/api/agents/relay') {
        if (Object.keys(body).some((key) => !['kind', 'workspace', 'prompt', 'agents', 'mode'].includes(key))) {
          sendJson(response, { error: 'Invalid request' }, 400);
          return;
        }
        sendJson(response, prepareRelayPlan(body.kind, body.workspace, body.prompt, body.agents, body.mode === undefined ? 'edit' : body.mode));
      } else if (pathname === '/api/agents/signin') {
        sendJson(response, agents.openLogin(body.agent, openTerminal || undefined));
      } else if (pathname.startsWith('/api/agents/runs/') && pathname.endsWith('/cancel')) {
        const runId = decodeURIComponent(pathname.slice('/api/agents/runs/'.length, -'/cancel'.length));
        if (agents.cancel(runId)) sendJson(response, { cancelled: true });
        else sendJson(response, { error: 'That run is not running' }, 404);
      } else {
        sendJson(response, { error: 'Not found' }, 404);
      }
    } catch (error) {
      if (error instanceof AgentError) sendJson(response, { error: error.userMessage, kind: error.kind }, 422);
      else sendJson(response, { error: 'Internal error' }, 500);
    }
  }

  async function accountCall(response, action) {
    try {
      sendJson(response, await action());
    } catch (error) {
      if (!(error instanceof WisprAccountError)) {
        sendJson(response, { error: 'Internal error' }, 500);
        return;
      }
      sendJson(response, { error: error.userMessage, kind: error.kind }, ACCOUNT_HTTP[error.kind] || 502);
    }
  }

  function sendJson(response, payload, statusCode = 200) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    response.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(data);
  }

  function serveStatic(request, response, port) {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let relative = decodeURIComponent(url.pathname);
    if (relative === '/') relative = '/index.html';
    const file = path.resolve(webDir, `.${relative}`);
    if (!file.startsWith(path.resolve(webDir) + path.sep)) {
      sendJson(response, { error: 'Not found' }, 404);
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        sendJson(response, { error: 'Not found' }, 404);
        return;
      }
      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      };
      if (relative === '/index.html') headers['Content-Security-Policy'] = CSP;
      response.writeHead(200, headers);
      response.end(data);
    });
  }

  const server = http.createServer((request, response) => {
    const port = server.address() ? server.address().port : 0;
    const host = String(request.headers.host || '');
    const trusted =
      host === `127.0.0.1:${port}` || host === `localhost:${port}` ||
      (port === 0 && /^(127\.0\.0\.1|localhost):\d+$/.test(host));
    if (!trusted) {
      sendJson(response, { error: 'Invalid host' }, 403);
      return;
    }
    const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    const authorized = () => {
      const provided = String(request.headers['x-flowmesh-token'] || '');
      if (!provided) return false;
      const a = Buffer.from(provided);
      const b = Buffer.from(sessionToken);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    const loopbackOrigin = () => {
      const origin = request.headers.origin;
      if (!origin) return true;
      return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    };

    const callbackUrl = () => `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;

    if (request.method === 'GET') {
      if (pathname === CALLBACK_PATH) {
        // Where Wispr's page sends the browser back. Unauthenticated by necessity: it is
        // protected by the one-time, unguessable `state` that only a sign-in started from
        // this app holds, and it reveals a sentence, never a token.
        const query = new URL(request.url, 'http://127.0.0.1').searchParams;
        account.complete(query.get('code') || '', query.get('state') || '', query.get('error') || '').then(({ ok, message }) => {
          const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
          const page = Buffer.from(
            '<!doctype html><meta charset=utf-8><title>FlowMesh</title>' +
            '<body style="font:16px system-ui;background:#080e0c;color:#e9f0e5;display:grid;place-items:center;height:100vh;margin:0">' +
            `<main style="max-width:30em;padding:2em;text-align:center"><h1 style="font-weight:500">${ok ? 'Connected' : 'Not connected'}</h1>` +
            `<p>${escape(message)}</p></main></body>`);
          response.writeHead(ok ? 200 : 400, {
            'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          });
          response.end(page);
        }, () => sendJson(response, { error: 'Internal error' }, 500));
        return;
      }
      if (pathname.startsWith('/api/') && !authorized()) {
        sendJson(response, { error: 'Missing or invalid session token' }, 401);
        return;
      }
      if (pathname === '/api/status') return sendJson(response, status());
      if (pathname === '/api/settings') return sendJson(response, store.publicSettings());
      if (pathname === '/api/events') return sendJson(response, { events: events.slice(-MAX_EVENTS) });
      if (pathname === '/api/wispr') return sendJson(response, wisprOverview());
      if (pathname === '/api/wispr/latest') return sendJson(response, wisprLatest());
      if (pathname === '/api/wispr/dictionary') return sendJson(response, wisprDictionary());
      if (pathname === '/api/runs') return sendJson(response, { runs: listRuns(env) });
      if (pathname.startsWith('/api/runs/')) {
        const record = readRun(decodeURIComponent(pathname.slice('/api/runs/'.length)), env);
        return sendJson(response, record || { error: 'No such record' }, record ? 200 : 404);
      }
      if (pathname === '/api/mcp/servers') return sendJson(response, { servers: mcp.listServers(), limit: 20 });
      if (pathname === '/api/mcp/tools') {
        return void mcp.catalog().then((catalog) => sendJson(response, catalog), () => sendJson(response, { error: 'Internal error' }, 500));
      }
      if (pathname === '/api/mcp/presets') return sendJson(response, { presets: PRESETS });
      if (pathname === '/api/wake') return sendJson(response, { enabled: wakeEnabled(), ...wake.status() });
      if (pathname === '/api/pilot') return sendJson(response, { enabled: pilotEnabled(), system_volume: platform === 'win32', screenshot: Boolean(capturePage) });
      if (pathname === '/api/agents') {
        return sendJson(response, {
          enabled: agentsEnabled(), catalog: publicCatalog(agents.catalog), config: agents.config(), detection: agents.detect(),
        });
      }
      if (pathname.startsWith('/api/agents/runs/')) {
        const view = agents.runView(decodeURIComponent(pathname.slice('/api/agents/runs/'.length)));
        return sendJson(response, view || { error: 'No such run' }, view ? 200 : 404);
      }
      if (pathname === '/api/wispr/account') {
        account.prefetch(callbackUrl());
        return sendJson(response, account.status());
      }
      if (pathname === '/api/wispr/account/notes') {
        return void accountCall(response, async () => ({ notes: await account.listNotes() }));
      }
      serveStatic(request, response, port);
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, { error: 'Method not allowed' }, 405);
      return;
    }
    if (!authorized()) {
      sendJson(response, { error: 'Missing or invalid session token' }, 401);
      return;
    }
    if (!loopbackOrigin()) {
      sendJson(response, { error: 'Cross-origin requests are denied' }, 403);
      return;
    }
    const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendJson(response, { error: 'JSON content type required' }, 415);
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > (pathname.startsWith('/api/mcp/') || pathname.startsWith('/api/agents/') ? 40_000 : MAX_BODY)) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', async () => {
      if (tooLarge) {
        sendJson(response, { error: 'Body too large' }, 413);
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = null;
      } catch {
        body = null;
      }
      if (!body) {
        sendJson(response, { error: 'Invalid JSON body' }, 400);
        return;
      }
      if (pathname === '/api/settings') {
        try {
          sendJson(response, store.validate(body));
        } catch (error) {
          sendJson(response, { error: error.message }, 400);
        }
        return;
      }
      if (pathname === '/api/plan') {
        const { plan, message, status: planStatus } = await planCommand(body.command, body.dictation, body.context);
        sendJson(response, plan === null ? { error: message } : plan, planStatus);
        return;
      }
      if (pathname.startsWith('/api/mcp/')) return void (await mcpPost(pathname, body, response));
      if (pathname === '/api/wake') return void wakePost(body, response);
      if (pathname.startsWith('/api/pilot/')) return void (await pilotPost(pathname, body, response));
      if (pathname.startsWith('/api/agents/')) return void (await agentsPost(pathname, body, response));
      if (pathname === '/api/wispr/account/connect') return void (await accountCall(response, () => account.begin(callbackUrl())));
      if (pathname === '/api/wispr/account/poll') return void (await accountCall(response, () => account.poll()));
      if (pathname === '/api/wispr/account/disconnect') return void (await accountCall(response, async () => account.disconnect()));
      if (pathname === '/api/wispr/account/note') {
        // Only an id is accepted; the text is fetched here, never supplied.
        if (Object.keys(body).length !== 1 || !('note_id' in body)) {
          sendJson(response, { error: 'Invalid request' }, 400);
          return;
        }
        return void (await accountCall(response, () => account.getNote(body.note_id)));
      }
      if (pathname === '/api/type') {
        // The client names a transcript id; the text is re-read from the database here,
        // so this page can never send its own string to the keyboard.
        const typed = typeDictation(body.transcript_id);
        if (typed === null) sendJson(response, { error: 'transcript_required' }, 400);
        else if (typed.error) sendJson(response, typed, typed.status || 409);
        else sendJson(response, typed);
        return;
      }
      if (pathname === '/api/execute') {
        if (Object.keys(body).some((key) => key !== 'plan_id' && key !== 'confirm')) {
          sendJson(response, { error: 'Invalid plan' }, 400);
          return;
        }
        const planId = body.plan_id;
        if (typeof planId !== 'string' || planId.length > 128 || (body.confirm !== undefined && typeof body.confirm !== 'boolean')) {
          sendJson(response, { error: 'Invalid plan' }, 400);
          return;
        }
        const pendingPlan = plans.get(planId);
        if (pendingPlan && pendingPlan.needs_confirm && body.confirm !== true) {
          // The plan stays alive: confirming is a second, deliberate gesture.
          sendJson(response, { error: 'This plan can change or destroy things. Confirm it explicitly.', needs_confirm: true }, 428);
          return;
        }
        const results = await executePlan(planId);
        if (results === null) sendJson(response, { error: 'Plan expired or already used' }, 409);
        else sendJson(response, { results });
        return;
      }
      if (pathname === '/api/cancel') {
        sendJson(response, cancelPlan(body.plan_id));
        return;
      }
      sendJson(response, { error: 'Not found' }, 404);
    });
  });

  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
  }

  async function close() {
    if (timer) clearTimeout(timer);
    await mcp.closeAll();
    agents.killAllNow();
    wake.stop();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    server,
    sessionToken,
    listen,
    close,
    status,
    capabilities,
    preparePlan,
    executePlan,
    perform,
    cancelPlan,
    plans,
    events,
    mcp,
    killMcpNow: () => mcp.killAllNow(),
    agents,
    wake,
    killAgentsNow: () => { agents.killAllNow(); wake.stop(); },
    prepareAgentPlan,
    prepareRelayPlan,
    prepareCouncilPlan,
    planCommand,
    prepareToolPlan,
  };
}

module.exports = {
  createRuntime,
  appCommand,
  artifactDir,
  recordMarkdown,
  timestamp,
  PLAN_LIFETIME,
  MAX_EVENTS,
  MAX_TYPED_CHARS,
  WISPR_MAX_AGE,
  ALLOWED_APPS,
  ALLOWED_URLS,
  CSP,
  RUN_NAME,
};
