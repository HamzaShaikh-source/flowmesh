'use strict';
/** The wake word through the Electron runtime (twin of tests/test_wake.py). */
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const { createStore } = require('../config.js');
const { createRuntime } = require('../runtime.js');
const { createWake, parseCombo, SCRIPT, WAKE_PHRASES, CONFIDENCE_FLOOR } = require('../wake.js');

class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.stdout.end();
    this.emit('close', 0);
  }
}

const wait = async (predicate, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

function make({ platform = 'win32' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-wk-'));
  const store = createStore({ dir, env: {}, cipher: null });
  const procs = [];
  const pressed = [];
  const wake = createWake({
    store, platform, opener: () => { const p = new FakeProc(); procs.push(p); return p; },
    press: (codes, hold) => { pressed.push([codes, hold]); return true; },
  });
  return { wake, procs, pressed, dir };
}

test('shortcuts: valid ones become key codes, everything else is refused', () => {
  assert.deepEqual(parseCombo('ctrl+alt+space'), [0x11, 0x12, 0x20]);
  assert.deepEqual(parseCombo('Ctrl+Win+W'), [0x11, 0x5b, 'W'.charCodeAt(0)]);
  assert.deepEqual(parseCombo('alt+f9'), [0x12, 0x78]);
  for (const bad of ['', '   ', 'space', 'w', 'ctrl', 'ctrl+ctrl+w', 'ctrl+alt+shift+win+w', 'ctrl+f13', 'ctrl+escape', 'ctrl+;',
    'ctrl+alt+', 'ctrl++w', 'ctrl+w+x', 'rm -rf', `ctrl+${'a'.repeat(50)}`, null, 7, ['ctrl+w']]) {
    assert.throws(() => parseCombo(bad), Error, JSON.stringify(bad));
  }
});

test('the script is fixed and agrees with its constants', () => {
  assert.doesNotMatch(SCRIPT, /\$env:|\$args/);
  for (const phrase of WAKE_PHRASES) assert.ok(SCRIPT.includes(`'${phrase}'`));
  assert.ok(SCRIPT.includes(`-ge ${CONFIDENCE_FLOOR}`));
  assert.ok(SCRIPT.includes('DictationGrammar'));
  assert.doesNotMatch(SCRIPT, /\.Text\b/);
});

test('it listens only after READY, counts a wake, and presses nothing without a shortcut', async () => {
  const { wake, procs, pressed, dir } = make();
  try {
    assert.equal(wake.status().state, 'off');
    wake.start();
    procs[0].stdout.write('READY\nWAKE 0.93\n');
    assert.ok(await wait(() => wake.status().wakes === 1));
    assert.equal(wake.status().state, 'listening');
    assert.deepEqual(pressed, []);
  } finally {
    wake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a configured shortcut is pressed once and the cooldown swallows repeats', async () => {
  const { wake, procs, pressed, dir } = make();
  try {
    wake.setConfig({ summon: 'Ctrl+Alt+Space', hold_s: 2 });
    wake.start();
    procs[0].stdout.write('READY\nWAKE 0.9\nWAKE 0.9\nWAKE 0.95\n');
    assert.ok(await wait(() => pressed.length === 1));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(pressed, [[[0x11, 0x12, 0x20], 2]]);
    assert.equal(wake.status().wakes, 1);
    assert.equal(wake.config().summon, 'ctrl+alt+space');
  } finally {
    wake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an error is reported without leaking noise; stop kills the process; other platforms start nothing', async () => {
  const a = make();
  try {
    a.wake.start();
    a.procs[0].stdout.write('ERROR No recognizer <script>\n');
    assert.ok(await wait(() => a.wake.status().state === 'error'));
    assert.match(a.wake.status().detail, /No recognizer/);
    assert.doesNotMatch(a.wake.status().detail, /</);
    a.wake.stop();
    assert.equal(a.procs[0].killed, true);
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
  }
  const b = make({ platform: 'linux' });
  try {
    assert.equal(b.wake.start().state, 'unsupported');
    assert.equal(b.procs.length, 0);
  } finally {
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
});

test('config validation', () => {
  const { wake, dir } = make();
  try {
    for (const bad of [{ summon: 'w' }, { hold_s: -1 }, { hold_s: 31 }, { hold_s: true }, { hold_s: '3' }, { extra: 1 }, 'x']) {
      assert.throws(() => wake.setConfig(bad), Error, JSON.stringify(bad));
    }
    assert.equal(wake.setConfig({ summon: '' }).summon, '');
    assert.equal(wake.setConfig({ hold_s: 5 }).hold_s, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withRuntime(fn, { env = {} } = {}) {
  const { wake, procs, pressed, dir } = make();
  const runEnv = { ...process.env, FLOWMESH_ARTIFACT_DIR: path.join(dir, 'runs'), ...env };
  const store = createStore({ dir: path.join(dir, 'cfg'), env: runEnv, cipher: null });
  const runtime = createRuntime({ port: 0, host: '127.0.0.1', store, env: runEnv, wakeManager: wake, wakeTimerMs: 60 });
  const port = await runtime.listen(0);
  const call = (route, init = {}, token = runtime.sessionToken) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      ...init,
      headers: { ...(token ? { 'X-FlowMesh-Token': token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  const post = async (route, body, token) => {
    const res = await call(route, { method: 'POST', body: JSON.stringify(body) }, token);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const get = async (route, token) => {
    const res = await call(route, {}, token);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  try {
    await fn({ post, get, wake, procs, pressed });
  } finally {
    wake.stop();
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('http: turning it on needs an acknowledgement; on, status and off', async () => {
  await withRuntime(async ({ post, get, procs }) => {
    const refused = await post('/api/wake', { enabled: true });
    assert.equal(refused.status, 428);
    assert.equal(refused.json.needs_acknowledgement, true);
    assert.equal((await get('/api/wake')).json.state, 'off');
    assert.equal((await post('/api/wake', { enabled: true, acknowledged: true })).status, 200);
    procs[0].stdout.write('READY\nWAKE 0.9\n');
    assert.ok(await wait(() => procs.length === 1));
    let data;
    for (let i = 0; i < 100; i += 1) {
      data = (await get('/api/wake')).json;
      if (data.wakes === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(data.state, 'listening');
    assert.deepEqual(data.phrases, WAKE_PHRASES);
    assert.equal((await post('/api/wake', { enabled: false })).json.state, 'off');
  });
});

test('http: the shortcut is validated, never free text; a summon test waits before pressing', async () => {
  await withRuntime(async ({ post, get, pressed }) => {
    assert.equal((await post('/api/wake', { summon: 'ctrl+alt+space', hold_s: 3 })).status, 200);
    assert.equal((await get('/api/wake')).json.summon, 'ctrl+alt+space');
    for (const bad of [{ summon: 'just type this' }, { summon: 'w' }, { hold_s: 99 }]) assert.equal((await post('/api/wake', bad)).status, 422, JSON.stringify(bad));
    for (const bad of [{ enabled: 'yes' }, { surprise: 1 }, { acknowledged: 1 }]) assert.equal((await post('/api/wake', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post('/api/wake', { test_summon: true })).status, 200);
    assert.deepEqual(pressed, [], 'nothing is pressed during the request');
    assert.ok(await wait(() => pressed.length === 1));
  });
});

test('http: a summon test needs a shortcut; it can be switched off; the token is required', async () => {
  await withRuntime(async ({ post, get }) => {
    assert.equal((await post('/api/wake', { test_summon: true })).status, 422);
    assert.equal((await get('/api/wake', null)).status, 401);
    assert.equal((await post('/api/wake', { enabled: false }, 'bad')).status, 401);
  });
  await withRuntime(async ({ post, get }) => {
    assert.equal((await post('/api/wake', { enabled: true, acknowledged: true })).status, 403);
    assert.equal((await get('/api/wake')).json.enabled, false);
  }, { env: { FLOWMESH_WAKE: 'off' } });
});
