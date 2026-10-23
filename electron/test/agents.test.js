'use strict';
/** Coding agents through the real Electron HTTP surface (twin of tests/test_agents*.py). */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');

const { createStore } = require('../config.js');
const { createRuntime } = require('../runtime.js');
const { createAgents, agentPhrase, validateFolder, buildCommand, sanitize, CATALOG, AgentError } = require('../agents.js');

const MOCK = path.join(__dirname, 'fixtures', 'mock_agent.js');

function mockCatalog() {
  const base = {
    command: process.execPath, launcher_args: [MOCK], docs: 'https://example.com', version_args: ['--version'],
    status_args: ['auth', 'status'], signed_in: 'Logged in', signed_out: 'Not logged in', method: 'Logged in using (\\w+)',
    login_args: ['auth', 'login'], login_note: 'test',
  };
  return [
    {
      ...base, id: 'mock', label: 'Mock Agent', base_args: [], prompt_via: 'stdin', modes: [
        { id: 'plan', label: 'Plan', risk: 'read', args: ['--stdin', '--mode', 'plan'], about: '' },
        { id: 'edit', label: 'Edit', risk: 'write', args: ['--stdin', '--mode', 'edit'], about: '' },
        { id: 'full', label: 'Full', risk: 'danger', args: ['--stdin', '--mode', 'full'], about: '' },
      ],
    },
    {
      ...base, id: 'mockarg', label: 'Mock Arg', base_args: [], prompt_via: 'arg', modes: [
        { id: 'edit', label: 'Edit', risk: 'write', args: ['--prompt', '{prompt}'], about: '' },
      ],
    },
    {
      ...base, id: 'codex', label: 'Codex (mock)', base_args: [], prompt_via: 'stdin', modes: [
        { id: 'plan', label: 'Plan', risk: 'read', args: ['--stdin'], about: '' },
        { id: 'edit', label: 'Edit', risk: 'write', args: ['--stdin'], about: '' },
      ],
    },
    {
      ...base, id: 'ghost', label: 'Ghost', command: 'definitely-not-installed-xyz', launcher_args: [], base_args: [], prompt_via: 'stdin',
      modes: [{ id: 'edit', label: 'Edit', risk: 'write', args: ['--stdin'], about: '' }],
    },
    ...['mock2', 'mock3'].map((id) => ({
      ...base, id, label: `Mock ${id.slice(-1)}`, base_args: [], prompt_via: 'stdin', modes: [
        { id: 'plan', label: 'Plan', risk: 'read', args: ['--stdin', '--mode', 'plan'], about: '' },
        { id: 'edit', label: 'Edit', risk: 'write', args: ['--stdin', '--mode', 'edit'], about: '' },
      ],
    })),
  ];
}

async function withRuntime(fn, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-ag-'));
  const runEnv = { ...process.env, FLOWMESH_ARTIFACT_DIR: path.join(dir, 'runs'), ...env };
  const store = createStore({ dir: path.join(dir, 'cfg'), env: runEnv, cipher: null });
  const agents = createAgents({ store, catalog: mockCatalog(), env: runEnv });
  const opened = [];
  const runtime = createRuntime({
    port: 0, host: '127.0.0.1', store, env: runEnv, agentsManager: agents, openTerminal: (argv) => { opened.push(argv); return true; },
  });
  const port = await runtime.listen(0);
  const call = (route, init = {}) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      ...init,
      headers: { 'X-FlowMesh-Token': runtime.sessionToken, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  const post = async (route, body) => {
    const res = await call(route, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const get = async (route) => {
    const res = await call(route);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const project = path.join(dir, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  const folder = async () => {
    const res = await post('/api/agents/workspaces', { path: project, label: 'Demo', acknowledged: true });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json.workspace;
  };
  const plan = async (space, prompt = 'hello', agent = 'mock', mode = 'edit', expected = 200) => {
    const res = await post('/api/agents/plan', { agent, workspace: space.id, mode, prompt });
    assert.equal(res.status, expected, JSON.stringify(res.json));
    return res.json;
  };
  try {
    await fn({ runtime, agents, post, get, folder, plan, project, opened, dir });
  } finally {
    runtime.killAgentsNow();
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('phrases name an agent and a task and nothing else', () => {
  const cases = {
    'Ask Codex to fix the failing test': ['codex', 'fix the failing test'],
    'tell claude code to add a unit test for the parser': ['claude', 'add a unit test for the parser'],
    'have opencode refactor the router': ['opencode', 'refactor the router'],
    'get antigravity to explain this repo': ['agy', 'explain this repo'],
    'ask chatgpt codex to bump the version': ['codex', 'bump the version'],
    'ask gemini cli to write docs': ['gemini', 'write docs'],
  };
  for (const [said, expected] of Object.entries(cases)) assert.deepEqual(agentPhrase(said), expected, said);
  for (const said of ['ask codex', 'open notepad', 'ask bob to fix it', 'codex fix the test']) assert.equal(agentPhrase(said), null, said);
});

test('folders: roots, home and system folders are refused', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-f-'));
  try {
    assert.equal(validateFolder(tmp), fs.realpathSync.native(tmp));
    for (const bad of [path.parse(tmp).root, os.homedir(), 'relative/dir', '', path.join(tmp, 'missing')]) {
      assert.throws(() => validateFolder(bad), AgentError, String(bad));
    }
    const file = path.join(tmp, 'f.txt');
    fs.writeFileSync(file, 'x');
    assert.throws(() => validateFolder(file), AgentError);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the task is delivered by stdin, never as an argument, unless the CLI needs it', () => {
  const [agent] = mockCatalog();
  const mode = agent.modes[1];
  const [args, stdin] = buildCommand(agent, mode, '/p', 'rm -rf / ; echo hi');
  assert.deepEqual(args, ['--stdin', '--mode', 'edit']);
  assert.equal(stdin, 'rm -rf / ; echo hi');
  const arg = mockCatalog()[1];
  assert.throws(() => buildCommand(arg, arg.modes[0], '/p', '--dangerous'), AgentError);
  assert.deepEqual(buildCommand(arg, arg.modes[0], '/p', 'ok')[0], ['--prompt', 'ok']);
});

test('every bypass flag in the real catalog is a danger mode and read modes carry no edit flags', () => {
  for (const agent of CATALOG) {
    for (const mode of agent.modes) {
      const joined = mode.args.join(' ');
      if (/bypass|yolo|--mode auto$|dangerously/.test(joined)) assert.equal(mode.risk, 'danger', `${agent.id}/${mode.id}`);
      if (mode.risk === 'read') assert.doesNotMatch(joined, /acceptEdits|workspace-write|auto_edit|accept-edits/, `${agent.id}/${mode.id}`);
    }
  }
});

test('sanitize strips terminal escapes and control characters', () => {
  assert.equal(sanitize('\x1b[31mred\x1b[0m \x1b]0;title\x07ok \x07 \x00end'), 'red ok    end');
});

test('adding a folder needs an acknowledgement; the listing never hands out executable paths', async () => {
  await withRuntime(async ({ post, get, folder, project }) => {
    const refused = await post('/api/agents/workspaces', { path: project });
    assert.equal(refused.status, 428);
    assert.equal((await post('/api/agents/workspaces', { path: os.homedir(), acknowledged: true })).status, 422);
    const space = await folder();
    let listing;
    for (let i = 0; i < 100; i += 1) {
      listing = (await get('/api/agents')).json;
      if (!listing.detection.checking) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(listing.config.workspaces[0].id, space.id);
    assert.equal(listing.detection.agents.mock.installed, true);
    assert.equal(listing.detection.agents.mock.auth.state, 'signed_in');
    assert.equal(listing.detection.agents.ghost.installed, false);
    assert.ok(!JSON.stringify(listing.catalog).includes(process.execPath));
  });
});

test('an edit task is a write plan that is never auto-run; a bypass mode needs the second confirmation', async () => {
  await withRuntime(async ({ post, folder, plan }) => {
    const space = await folder();
    const edit = await plan(space);
    assert.deepEqual([edit.risk, edit.route, edit.auto_run, edit.needs_confirm], ['write', 'agent', false, false]);
    assert.match(edit.actions[0].command, /task sent on stdin/);
    const full = await plan(space, 'hello', 'mock', 'full');
    assert.deepEqual([full.risk, full.needs_confirm], ['danger', true]);
    assert.equal((await post('/api/execute', { plan_id: full.id })).status, 428);
  });
});

test('approving runs the agent, returns its output and writes a hashed record', async () => {
  await withRuntime(async ({ post, folder, plan, project }) => {
    const space = await folder();
    const p = await plan(space, 'WRITE:made.txt ANSI please');
    const res = await post('/api/execute', { plan_id: p.id });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const [run, record] = res.json.results;
    assert.equal(run.status, 'returned', 'FlowMesh never claims a coding task is verified');
    assert.match(run.output, /made\.txt/);
    assert.ok(!run.output.includes('\x1b'));
    assert.deepEqual(JSON.parse(run.output.split('\n')[0]).leaked, []);
    assert.ok(fs.existsSync(path.join(project, 'made.txt')));
    assert.equal(record.status, 'verified');
    assert.equal((await post('/api/execute', { plan_id: p.id })).status, 409);
  }, { env: { FLOWMESH_SECRET_PROBE: 'x', TYPESAFE_KEY: 'y' } });
});

test('a character split across two reads stays whole', async () => {
  await withRuntime(async ({ post, folder, plan }) => {
    const p = await plan(await folder(), 'SPLIT');
    const run = (await post('/api/execute', { plan_id: p.id })).json.results[0];
    assert.match(run.output, /café ok/);
    assert.ok(!run.output.includes('�'));
  });
});

test('a failing agent is failed and keeps its output', async () => {
  await withRuntime(async ({ post, folder, plan }) => {
    const p = await plan(await folder(), 'FAIL');
    const run = (await post('/api/execute', { plan_id: p.id })).json.results[0];
    assert.equal(run.status, 'failed');
    assert.match(run.output, /something went wrong/);
  });
});

test('the client cannot name a path, an extra field or an uninstalled agent', async () => {
  await withRuntime(async ({ post, folder }) => {
    const space = await folder();
    assert.equal((await post('/api/agents/plan', { agent: 'mock', workspace: space.id, mode: 'edit', prompt: 'x', path: 'C:/Windows' })).status, 400);
    assert.equal((await post('/api/agents/plan', { agent: 'mock', workspace: 'C:/Windows', mode: 'edit', prompt: 'x' })).status, 422);
    const ghost = await post('/api/agents/plan', { agent: 'ghost', workspace: space.id, mode: 'edit', prompt: 'x' });
    assert.equal(ghost.status, 422);
    assert.match(ghost.json.error, /not installed/);
  });
});

test('progress is pollable, cancel stops the run and its child process', async () => {
  await withRuntime(async ({ post, get, folder, plan, project }) => {
    const p = await plan(await folder(), 'SLEEP:30 SPAWN');
    const runId = p.actions[0].run_id;
    const pending = post('/api/execute', { plan_id: p.id });
    let view = null;
    for (let i = 0; i < 150; i += 1) {
      const res = await get(`/api/agents/runs/${runId}`);
      if (res.status === 200 && res.json.output.includes('sleeping') && fs.existsSync(path.join(project, 'child.pid'))) {
        view = res.json;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(view, 'the run became visible');
    assert.equal(view.status, 'running');
    assert.equal((await post(`/api/agents/runs/${runId}/cancel`, {})).status, 200);
    const results = (await pending).json.results;
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].detail, /ancel/);
    assert.equal((await post(`/api/agents/runs/${runId}/cancel`, {})).status, 404);
    assert.equal((await get('/api/agents/runs/not-a-run')).status, 404);
    const pid = Number(fs.readFileSync(path.join(project, 'child.pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 500));
    let alive;
    if (process.platform === 'win32') alive = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH']).stdout.toString().includes(String(pid));
    else {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    assert.equal(alive, false, 'the whole process tree was stopped');
  });
});

test('a spoken agent sentence becomes a plan with the saved defaults; without a folder it explains what to do', async () => {
  await withRuntime(async ({ runtime, post, folder }) => {
    const none = await runtime.planCommand('ask codex to fix the build');
    assert.equal(none.status, 422);
    assert.match(none.message, /project folder/);
    const space = await folder();
    await post('/api/agents/defaults', { default_agent: 'codex', default_workspace: space.id, default_mode: 'edit' });
    const { plan, status } = await runtime.planCommand('ask codex to fix the build');
    assert.equal(status, 200);
    assert.deepEqual([plan.route, plan.auto_run, plan.risk], ['agent', false, 'write']);
    assert.equal(plan.actions[0].prompt, 'fix the build');
    const unknown = await runtime.planCommand('ask claude to fix the build');
    assert.equal(unknown.status, 422);
    assert.match(unknown.message, /not supported/);
  });
});

test('sign-in opens the vendor login in a terminal, fixed per agent', async () => {
  await withRuntime(async ({ post, opened }) => {
    const ok = await post('/api/agents/signin', { agent: 'mock' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(opened[0].slice(-2), ['auth', 'login']);
    assert.equal((await post('/api/agents/signin', { agent: '../evil' })).status, 422);
  });
});

test('the feature can be switched off', async () => {
  await withRuntime(async ({ post, get }) => {
    assert.equal((await post('/api/agents/defaults', {})).status, 403);
    assert.equal((await get('/api/agents')).json.enabled, false);
  }, { env: { FLOWMESH_AGENTS: 'off' } });
});

test('relay: work then review hands the output over as untrusted data and skips after a failure', async () => {
  await withRuntime(async ({ post, folder }) => {
    const space = await folder();
    const body = (prompt, kind = 'review', agents = ['mock', 'mock2'], mode = 'edit') => ({ kind, workspace: space.id, prompt, agents, mode });
    const planned = await post('/api/agents/relay', body('WRITE:made.txt'));
    assert.equal(planned.status, 200, JSON.stringify(planned.json));
    const steps = planned.json.actions.filter((a) => a.kind === 'agent_run');
    assert.deepEqual(steps.map((a) => [a.role, a.risk, a.handoff_from]), [['work', 'write', null], ['review', 'read', 0]]);
    assert.equal(planned.json.risk, 'write');
    assert.equal(planned.json.auto_run, false);
    const results = (await post('/api/execute', { plan_id: planned.json.id })).json.results;
    assert.deepEqual(results.slice(0, 2).map((r) => r.status), ['returned', 'returned']);
    assert.match(results[1].output, /untrusted/);
    assert.match(results[1].output, /made\.txt/);
    assert.equal(results[2].status, 'verified');

    const failing = await post('/api/agents/relay', body('FAIL'));
    const failed = (await post('/api/execute', { plan_id: failing.json.id })).json.results;
    assert.equal(failed[0].status, 'failed');
    assert.equal(failed[1].status, 'denied');
    assert.match(failed[1].detail, /Skipped/);
  });
});

test('relay: chain, compare, danger and bad shapes', async () => {
  await withRuntime(async ({ post, folder }) => {
    const space = await folder();
    const body = (kind, agents, extra = {}) => ({ kind, workspace: space.id, prompt: 'hello', agents, ...extra });
    const chain = await post('/api/agents/relay', body('chain', ['mock', 'mock2', 'mock3']));
    assert.deepEqual(chain.json.actions.filter((a) => a.kind === 'agent_run').map((a) => [a.role, a.mode]), [['plan', 'plan'], ['work', 'edit'], ['review', 'plan']]);
    const compare = await post('/api/agents/relay', body('compare', ['mock', 'mock2']));
    assert.equal(compare.json.risk, 'read');
    assert.deepEqual(compare.json.actions.filter((a) => a.kind === 'agent_run').map((a) => a.handoff_from), [null, null]);
    assert.equal((await post('/api/agents/relay', body('compare', ['mock', 'mock']))).status, 422);
    const full = await post('/api/agents/relay', body('review', ['mock', 'mock2'], { mode: 'full' }));
    assert.deepEqual([full.json.risk, full.json.needs_confirm], ['danger', true]);
    assert.equal((await post('/api/execute', { plan_id: full.json.id })).status, 428);
    const noRead = await post('/api/agents/relay', body('review', ['mock', 'mockarg']));
    assert.equal(noRead.status, 422);
    assert.match(noRead.json.error, /read-only/);
    assert.equal((await post('/api/agents/relay', body('review', ['mock']))).status, 422);
    assert.equal((await post('/api/agents/relay', body('nonsense', ['mock', 'mock2']))).status, 422);
    assert.equal((await post('/api/agents/relay', body('review', ['mock', 'mock2'], { path: 'C:/Windows' }))).status, 400);
  });
});
