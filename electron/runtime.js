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
    { jev: 'Jev Choice', jev_unavailable: 'local rules (Jev unreachable)' }[plan.source] || 'local rules';
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
  lines.push('', '## What was said, verbatim', '', '~~~text', command.replace(/~~~/g, '\\~\\~\\~'), '~~~', '');
  lines.push(
    'A `sent` receipt means the request left FlowMesh. `verified` means FlowMesh observed the',
    'result (a file it wrote and hashed, or a device state it read back). Anything the runtime',
    'could not do is recorded as `not_configured`, `unavailable`, `denied`, or `failed`.',
    '',
  );
  return lines.join('\n');
}

function createRuntime(options = {}) {
  const {
    webDir = path.join(__dirname, '..', 'web'),
    store = createStore(),
    openExternal = null,
    env = process.env,
    platform = process.platform,
    fetchImpl = globalThis.fetch,
  } = options;

  const sessionToken = crypto.randomBytes(24).toString('base64url');
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

  async function preparePlan(rawCommand, dictation) {
    if (!core.commandIsUsable(rawCommand) || core.isForbidden(String(rawCommand).trim())) return null;
    const command = String(rawCommand).trim();
    const decision = await jevRoute(command, Object.keys(core.WORKFLOWS));
    const route = decision.source === 'jev' ? decision.route : core.localRoute(command);
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

  async function perform(action) {
    const kind = action.kind;
    const target = action.target;
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
      let result;
      try {
        result = await perform(action);
      } catch (error) {
        result = { status: 'failed', detail: error.name };
      }
      result.duration_ms = Date.now() - started;
      slots[index] = result;
    }
    if (noteSlots.length) {
      const written = slots
        .map((slot, index) => (slot ? { action: actions[index], status: slot.status, detail: slot.detail } : null))
        .filter(Boolean);
      const receipt = writeRecord(plan, written);
      for (const index of noteSlots) slots[index] = { ...receipt };
    }
    const results = actions.map((action, index) => {
      const receipt = slots[index] || { status: 'failed', detail: 'No receipt produced' };
      const subset = {};
      for (const key of ['kind', 'target', 'label', 'surface', 'value']) {
        if (key in action) subset[key] = action[key];
      }
      const event = { at: timestamp(), action: subset, ...receipt };
      events.push(event);
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

    if (request.method === 'GET') {
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
      if (size > MAX_BODY) {
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
        const plan = await preparePlan(body.command, body.dictation);
        if (plan === null) sendJson(response, { error: 'Command is unsupported, unclear, or not allowed' }, 422);
        else sendJson(response, plan);
        return;
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
        if (Object.keys(body).some((key) => key !== 'plan_id')) {
          sendJson(response, { error: 'Invalid plan' }, 400);
          return;
        }
        const planId = body.plan_id;
        if (typeof planId !== 'string' || planId.length > 128) {
          sendJson(response, { error: 'Invalid plan' }, 400);
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

  function close() {
    if (timer) clearTimeout(timer);
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
};
