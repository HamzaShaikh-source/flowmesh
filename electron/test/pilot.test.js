'use strict';
/** The page pilot through the Electron runtime. Injected fakes only: no real key is ever pressed. */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStore } = require('../config.js');
const { createRuntime } = require('../runtime.js');
const pilot = require('../pilot.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);

test('volume: the right media key, the right count, nothing else accepted', () => {
  const calls = [];
  const press = (code, n) => { calls.push([code, n]); return true; };
  const opts = { platform: 'win32', press };
  assert.deepEqual(pilot.pressVolume('up', undefined, opts), { ok: true, detail: 'System volume raised by about 10%.' });
  assert.deepEqual(calls.pop(), [0xaf, 5]);
  assert.match(pilot.pressVolume('down', 3, opts).detail, /about 6%/);
  assert.deepEqual(calls.pop(), [0xae, 3]);
  assert.equal(pilot.pressVolume('mute', 20, opts).ok, true);
  assert.deepEqual(calls.pop(), [0xad, 1], 'mute is one press whatever the steps');
  for (const action of ['louder', '', null, 7, ['up'], 'UP', 'up; rm -rf', '../up', '__proto__', 'constructor']) {
    const r = pilot.pressVolume(action, undefined, opts);
    assert.deepEqual([r.ok, r.kind], [false, 'bad_request'], String(action));
  }
  for (const steps of [0, -1, 26, 2.5, '3', true, [3]]) assert.equal(pilot.pressVolume('up', steps, opts).kind, 'bad_request', String(steps));
  assert.equal(calls.length, 0, 'bad input pressed nothing');
  assert.equal(pilot.pressVolume('up', 1, { platform: 'linux', press }).kind, 'unsupported');
  assert.equal(pilot.pressVolume('up', 1, { platform: 'win32', press: () => false }).kind, 'failed');
});

test('screenshots: a PNG is saved with a generated name and a hash; anything else is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-ps-'));
  try {
    const receipt = pilot.saveScreenshot(PNG, path.join(dir, 'shots'));
    assert.match(receipt.name, /^flowmesh-screenshot-\d{8}-\d{6}\.png$/);
    assert.deepEqual(fs.readFileSync(receipt.path), PNG);
    assert.equal(receipt.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'shots')), [receipt.name]);
    for (const bad of [Buffer.alloc(0), Buffer.from('GIF89a'), Buffer.from('<html>'), null, 'text']) assert.throws(() => pilot.saveScreenshot(bad, dir), Error, String(bad));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withRuntime(fn, { env = {}, capturePage = null, platform = 'win32', pressed = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-pt-'));
  const runEnv = { ...process.env, FLOWMESH_ARTIFACT_DIR: path.join(dir, 'runs'), ...env };
  const store = createStore({ dir: path.join(dir, 'cfg'), env: runEnv, cipher: null });
  const runtime = createRuntime({
    port: 0, host: '127.0.0.1', store, env: runEnv, platform, capturePage,
    pressVolumeImpl: (action, steps) => pilot.pressVolume(action, steps, { platform, press: (code, n) => { pressed.push([code, n]); return true; } }),
  });
  const port = await runtime.listen(0);
  const call = (route, init = {}, token = runtime.sessionToken) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...init, headers: { ...(token ? { 'X-FlowMesh-Token': token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const post = async (route, body, token) => { const r = await call(route, { method: 'POST', body: JSON.stringify(body) }, token); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const get = async (route, token) => { const r = await call(route, {}, token); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    await fn({ post, get, dir, pressed });
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('http: status, volume validation and fixed keys', async () => {
  await withRuntime(async ({ post, get, pressed }) => {
    assert.deepEqual((await get('/api/pilot')).json, { enabled: true, system_volume: true, screenshot: false });
    assert.equal((await post('/api/pilot/volume', { action: 'up', steps: 2 })).status, 200);
    assert.deepEqual(pressed, [[0xaf, 2]]);
    for (const bad of [{ action: 'sideways' }, { action: 'up', steps: 99 }, { action: 'up', steps: '3' }, {}, { action: 'up', key: 13 }]) {
      assert.equal((await post('/api/pilot/volume', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(pressed.length, 1, 'bad requests pressed nothing');
  });
});

test('http: a screenshot of the app window is saved locally with a receipt; no window means 501', async () => {
  await withRuntime(async ({ post, get, dir }) => {
    assert.equal((await get('/api/pilot')).json.screenshot, true);
    const res = await post('/api/pilot/screenshot', {});
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(fs.readFileSync(res.json.path), PNG);
    assert.ok(res.json.path.startsWith(path.join(dir, 'runs')));
    assert.equal(res.json.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
    assert.equal((await post('/api/pilot/screenshot', { path: 'C:/x' })).status, 400);
  }, { capturePage: async () => PNG });
  await withRuntime(async ({ post }) => {
    const res = await post('/api/pilot/screenshot', {});
    assert.deepEqual([res.status, res.json.kind], [501, 'unsupported']);
  });
  await withRuntime(async ({ post }) => {
    assert.equal((await post('/api/pilot/screenshot', {})).status, 502, 'a window that is gone is a failure, not a success');
  }, { capturePage: async () => null });
  await withRuntime(async ({ post }) => {
    assert.equal((await post('/api/pilot/screenshot', {})).status, 502, 'garbage is not a screenshot');
  }, { capturePage: async () => Buffer.from('not a png') });
});

test('http: other platforms say so; it can be switched off; the token is required', async () => {
  await withRuntime(async ({ post, get, pressed }) => {
    assert.equal((await post('/api/pilot/volume', { action: 'up' })).status, 501);
    assert.equal((await get('/api/pilot')).json.system_volume, false);
    assert.equal(pressed.length, 0);
  }, { platform: 'linux' });
  await withRuntime(async ({ post, get, pressed }) => {
    assert.equal((await get('/api/pilot', null)).status, 401);
    assert.equal((await post('/api/pilot/volume', { action: 'up' }, 'bad')).status, 401);
    assert.equal((await post('/api/pilot/volume', { action: 'up' })).status, 403);
    assert.equal((await get('/api/pilot')).json.enabled, false);
    assert.equal(pressed.length, 0);
  }, { env: { FLOWMESH_PILOT: 'off' } });
});
