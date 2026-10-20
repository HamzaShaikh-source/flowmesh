'use strict';
/**
 * The Electron runtime's whole safety surface, exercised over real HTTP.
 *
 * Nothing here mocks the server: each case starts the loopback listener on an
 * ephemeral port and talks to it the way the window does, so the token check,
 * Host check, Origin check, plan lifetime, one-use rule, and body allowlist are
 * all proven by observed behaviour rather than by reading the code.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStore } = require('../config.js');
const { createRuntime } = require('../runtime.js');

const opened = [];

function makeRuntime(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-electron-'));
  const store = createStore({ dir, env: {} });
  const runtime = createRuntime({
    store,
    env: { FLOWMESH_ARTIFACT_DIR: path.join(dir, 'runs') },
    openExternal: async (url) => {
      opened.push(url);
    },
    ...overrides,
  });
  return { dir, store, runtime };
}

async function start(overrides) {
  const made = makeRuntime(overrides);
  const port = await made.runtime.listen(0);
  return { ...made, port, base: `http://127.0.0.1:${port}` };
}

async function api(ctx, pathname, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
  const response = await fetch(`${ctx.base}${pathname}`, {
    method,
    headers: {
      'X-FlowMesh-Token': ctx.runtime.sessionToken,
      ...(method === 'POST' && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: payload,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

test('the API refuses to answer without the per-launch token', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const noToken = await fetch(`${ctx.base}/api/status`);
  assert.equal(noToken.status, 401);
  assert.deepEqual(await noToken.json(), { error: 'Missing or invalid session token' });

  const wrongToken = await fetch(`${ctx.base}/api/status`, { headers: { 'X-FlowMesh-Token': 'nope' } });
  assert.equal(wrongToken.status, 401);
});

test('a foreign Host header is rejected even with a valid token', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const answer = await new Promise((resolve) => {
    const request = http.request(
      { host: '127.0.0.1', port: ctx.port, path: '/', headers: { Host: 'evil.example' } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, data }));
      },
    );
    request.end();
  });
  assert.equal(answer.status, 403);
  assert.match(answer.data, /Invalid host/);
});

test('status reports what this machine can actually do', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const { status, json } = await api(ctx, '/api/status');
  assert.equal(status, 200);
  assert.equal(json.mode, 'desktop_app');
  assert.equal(json.platform, process.platform);
  assert.equal(json.capabilities.notify, 'not_configured');
  assert.equal(json.capabilities.light, 'not_configured');
  assert.equal(json.capabilities.write_note, 'ready');
  assert.equal(json.home_assistant, false);
  assert.ok(json.version);
});

test('a plan is minted server-side, then consumed exactly once', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const plan = await api(ctx, '/api/plan', {
    method: 'POST',
    body: { command: 'Write a note about the release checklist and open the project board' },
  });
  assert.equal(plan.status, 200);
  assert.ok(plan.json.id);
  assert.equal(plan.json.route, 'focus');
  assert.equal(plan.json.source, 'local');
  assert.ok(Array.isArray(plan.json.actions) && plan.json.actions.length >= 3);
  assert.equal('expires' in plan.json, false, 'expiry stays server-side');
  assert.equal('command' in plan.json, false, 'the utterance is not echoed back into the plan');

  const first = await api(ctx, '/api/execute', { method: 'POST', body: { plan_id: plan.json.id } });
  assert.equal(first.status, 200);
  assert.equal(first.json.results.length, plan.json.actions.length);
  assert.deepEqual(
    first.json.results.map((r) => r.action.kind),
    plan.json.actions.map((a) => a.kind),
  );

  const second = await api(ctx, '/api/execute', { method: 'POST', body: { plan_id: plan.json.id } });
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, { error: 'Plan expired or already used' });
});

test('a plan past its lifetime cannot run', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const plan = await api(ctx, '/api/plan', { method: 'POST', body: { command: 'Start a 25 minute focus sprint' } });
  ctx.runtime.plans.get(plan.json.id).expires = Date.now() - 1;
  const attempt = await api(ctx, '/api/execute', { method: 'POST', body: { plan_id: plan.json.id } });
  assert.equal(attempt.status, 409);
});

test('a client may never compose or amend actions', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const plan = await api(ctx, '/api/plan', { method: 'POST', body: { command: 'Start a 25 minute focus sprint' } });
  const amended = await api(ctx, '/api/execute', {
    method: 'POST',
    body: { plan_id: plan.json.id, actions: [{ kind: 'open_url', target: 'project_board' }] },
  });
  assert.equal(amended.status, 400);
  assert.deepEqual(amended.json, { error: 'Invalid plan' });

  const fabricated = await api(ctx, '/api/execute', { method: 'POST', body: { plan_id: 'made-up', actions: [] } });
  assert.equal(fabricated.status, 400);

  const unknown = await api(ctx, '/api/execute', { method: 'POST', body: { plan_id: 'made-up' } });
  assert.equal(unknown.status, 409);
});

test('cross-origin, wrong content type, and oversized bodies are refused', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const crossOrigin = await api(ctx, '/api/plan', {
    method: 'POST',
    body: { command: 'Start a 25 minute focus sprint' },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(crossOrigin.json, { error: 'Cross-origin requests are denied' });

  const wrongType = await api(ctx, '/api/plan', {
    method: 'POST',
    body: 'command=Start+a+25+minute+focus+sprint',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(wrongType.status, 415);

  const big = await api(ctx, '/api/plan', {
    method: 'POST',
    body: JSON.stringify({ command: 'x'.repeat(20000) }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(big.status, 413, `oversized body answered ${big.status}`);
});

test('unsupported, forbidden, and empty commands never reach a plan', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  for (const command of ['Delete the entire repo', 'asdfgh', '', null, 'buy the domain']) {
    const answer = await api(ctx, '/api/plan', { method: 'POST', body: { command } });
    assert.equal(answer.status, 422, `command should be refused: ${String(command)}`);
  }
});

test('the run record is a real hashed file on disk', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  opened.length = 0;
  const plan = await api(ctx, '/api/plan', {
    method: 'POST',
    body: { command: 'Open the project board and start a 25 minute focus sprint' },
  });
  const run = await api(ctx, '/api/execute', { method: 'POST', body: { plan_id: plan.json.id } });
  assert.equal(run.status, 200);

  const record = run.json.results.find((result) => result.path && result.sha256);
  assert.ok(record, 'expected a record receipt with a path and digest');
  const data = fs.readFileSync(record.path);
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), record.sha256);
  assert.equal(data.length, record.bytes);
  assert.match(path.basename(record.path), /^flowmesh-\d{8}-\d{6}-focus-[A-Za-z0-9_-]{6}\.md$/);
  assert.match(data.toString('utf8'), /^# FlowMesh run — Deep focus/);

  const openedReceipt = run.json.results.find((result) => result.action.kind === 'open_url');
  assert.equal(openedReceipt.status, 'sent');
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^https:\/\/github\.com\/HamzaShaikh-source\/flowmesh\/issues$/);

  const phone = run.json.results.find((result) => result.action.kind === 'notify');
  assert.equal(phone.status, 'not_configured');
  const light = run.json.results.find((result) => result.action.kind === 'light');
  assert.equal(light.status, 'not_configured');
});

test('settings reject unknown keys and never return secret values', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const bad = await api(ctx, '/api/settings', { method: 'POST', body: { nope: 'x' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'Unknown setting' });

  const saved = await api(ctx, '/api/settings', {
    method: 'POST',
    body: { board_url: 'https://example.com/board', ha_token: 'super-secret-token' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.board_url, 'https://example.com/board');
  assert.equal(saved.json.ha_token_connected, true);
  assert.equal('ha_token' in saved.json, false, 'the secret value must never be returned');
  assert.equal(saved.text.includes('super-secret-token'), false);

  const read = await api(ctx, '/api/settings');
  assert.equal(read.json.board_url, 'https://example.com/board');
  assert.equal(read.text.includes('super-secret-token'), false);

  const badUrl = await api(ctx, '/api/settings', { method: 'POST', body: { board_url: 'javascript:alert(1)' } });
  assert.equal(badUrl.status, 400);
});

test('capabilities flip to ready once Home Assistant is configured', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  await api(ctx, '/api/settings', {
    method: 'POST',
    body: { ha_url: 'http://homeassistant.local:8123', phone_service: 'mobile_app_pixel', light_entity: 'light.desk', ha_token: 't' },
  });
  const { json } = await api(ctx, '/api/status');
  assert.equal(json.capabilities.notify, 'ready');
  assert.equal(json.capabilities.light, 'ready');
  assert.equal(json.home_assistant, true);
});

test('actions outside the allowlist are denied, not attempted', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const denied = [
    { kind: 'launch_app', target: 'cmd.exe' },
    { kind: 'launch_app', target: '/bin/sh' },
    { kind: 'open_url', target: 'file:///etc/passwd' },
    { kind: 'timer', target: 'focus_timer', value: 100000 },
    { kind: 'light', target: 'desk_light', value: 500 },
    { kind: 'notify', target: 'my_phone', message: 'x'.repeat(400) },
    { kind: 'write_note', target: 'run_record' },
  ];
  for (const action of denied) {
    const receipt = await ctx.runtime.perform(action);
    assert.ok(['denied', 'not_configured', 'unavailable'].includes(receipt.status), JSON.stringify(action));
  }
});

test('a focus timer is scheduled and reports when it will end', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const receipt = await ctx.runtime.perform({ kind: 'timer', target: 'focus_timer', value: 1 });
  assert.equal(receipt.status, 'verified');
  assert.match(receipt.detail, /1 minutes/);
  assert.ok(receipt.timer_end > Date.now());
});

test('cancel removes a plan so it cannot run', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const plan = await api(ctx, '/api/plan', { method: 'POST', body: { command: 'Start a 25 minute focus sprint' } });
  const cancelled = await api(ctx, '/api/cancel', { method: 'POST', body: { plan_id: plan.json.id } });
  assert.deepEqual(cancelled.json, { cancelled: true });
  const run = await api(ctx, '/api/execute', { method: 'POST', body: { plan_id: plan.json.id } });
  assert.equal(run.status, 409);
});

test('the static surface is locked down and cannot be walked upward', async (t) => {
  const ctx = await start();
  t.after(() => ctx.runtime.close());

  const index = await fetch(`${ctx.base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');

  const traversal = await fetch(`${ctx.base}/%2e%2e/%2e%2e/package.json`);
  assert.equal(traversal.status, 404);
});
