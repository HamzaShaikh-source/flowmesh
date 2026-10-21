'use strict';
/**
 * The Electron runtime must answer the Wispr connector endpoints with the same
 * contract as bridge.py. These drive the real HTTP surface against a synthetic
 * database, so no test ever touches a real Wispr Flow install.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createRuntime } = require('../runtime.js');

let dir;

function syntheticDb(rows, options = {}) {
  // A fresh directory per call: reusing one path made the second test collide with
  // the first test's tables.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-wispr-api-'));
  const file = path.join(dir, 'flow.sqlite');
  const db = new DatabaseSync(file);
  // Mirrors the real table: the key column is transcriptEntityId, NOT id. Using an
  // invented `id` column here is what hid a real query bug once already.
  db.exec('CREATE TABLE History (transcriptEntityId TEXT PRIMARY KEY, timestamp TEXT, status TEXT, app TEXT, url TEXT, duration REAL, numWords INTEGER, e2eLatency INTEGER, asrText TEXT, formattedText TEXT, editedText TEXT, numWordsCorrected INTEGER, audio BLOB, screenshot BLOB, axText TEXT, axHTML TEXT)');
  db.exec('CREATE TABLE Dictionary (id TEXT, phrase TEXT, replacement TEXT, isSnippet INTEGER, isDeleted INTEGER)');
  const insert = db.prepare('INSERT INTO History (transcriptEntityId, timestamp, status, app, numWords, e2eLatency, editedText, formattedText, asrText) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const row of rows) {
    insert.run(row.id, row.timestamp, row.status || 'completed', row.app || 'notepad', row.words || 5,
      row.latency || 100, row.edited || null, row.edited || null, null);
  }
  db.close();
  process.env.FLOWMESH_WISPR_DB = options.missing ? path.join(dir, 'ghost.sqlite') : file;
  return file;
}

async function withServer(fn) {
  const runtime = createRuntime({ port: 0, host: '127.0.0.1' });
  // listen() resolves to the bound port; the token lives on the runtime object.
  const port = await runtime.listen(0);
  const token = runtime.sessionToken;
  const call = (route, init = {}) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      ...init,
      headers: {
        'X-FlowMesh-Token': token,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
  try {
    await fn(call, port);
  } finally {
    if (runtime.close) await runtime.close();
  }
}

function secondsAgo(seconds) {
  const when = new Date(Date.now() - seconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())} ` +
    `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}.000 +00:00`;
}

test('GET /api/wispr reports the connection and never carries transcript text', async () => {
  syntheticDb([{ id: 'a', timestamp: secondsAgo(30), edited: 'open my board', app: 'brave' }]);
  await withServer(async (call) => {
    const res = await call('/api/wispr');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'connected');
    assert.equal(body.read_only, true);
    assert.equal(body.supported_api, false);
    assert.equal(body.dictations, 1);
    assert.deepEqual(body.ignored_columns, ['audio', 'screenshot', 'axText', 'axHTML']);
    assert.equal(body.freshness_seconds, 300);
    assert.ok(body.stats && body.stats.dictionary_entries >= 0);
    // Metadata about the fresh dictation is fine; its words are not.
    assert.ok(body.latest && body.latest.age_seconds <= 35);
    assert.equal(body.latest.text, undefined);
    assert.equal(JSON.stringify(body).includes('open my board'), false);
  });
});

test('GET /api/wispr/latest returns a fresh dictation with provenance', async () => {
  syntheticDb([{ id: 'fresh', timestamp: secondsAgo(20), edited: 'start a 25 minute research sprint', app: 'brave', latency: 240 }]);
  await withServer(async (call) => {
    const body = await (await call('/api/wispr/latest')).json();
    assert.equal(body.state, 'ready');
    assert.equal(body.id, 'fresh');
    assert.equal(body.text, 'start a 25 minute research sprint');
    assert.equal(body.app, 'brave');
    assert.ok(body.age_seconds <= 25);
    assert.equal(body.already_executed, false);
    assert.equal(body.provenance.source, 'wispr_history');
    assert.equal(body.provenance.id, 'fresh');
    assert.equal(body.provenance.edited, true);
  });
});

test('GET /api/wispr/latest refuses a stale dictation instead of planning it', async () => {
  syntheticDb([{ id: 'old', timestamp: secondsAgo(3600), edited: 'open my board' }]);
  await withServer(async (call) => {
    const body = await (await call('/api/wispr/latest')).json();
    assert.equal(body.state, 'none');
    assert.equal(body.text, undefined);
  });
});

test('the connector reports not_found when the override points nowhere', async () => {
  syntheticDb([{ id: 'a', timestamp: secondsAgo(10), edited: 'hello' }], { missing: true });
  await withServer(async (call) => {
    const body = await (await call('/api/wispr')).json();
    assert.equal(body.state, 'not_found');
    assert.equal(body.dictations, 0);
    assert.equal(body.stats, undefined);
    const latest = await (await call('/api/wispr/latest')).json();
    assert.equal(latest.state, 'not_found');
  });
});

test('a plan can carry dictation provenance, and it is never echoed back', async () => {
  syntheticDb([{ id: 'src', timestamp: secondsAgo(15), edited: 'start a 25 minute research sprint' }]);
  await withServer(async (call) => {
    const res = await call('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'start a 25 minute research sprint',
        dictation: { source: 'wispr_history', id: 'src', timestamp: '2026-10-21 04:36:38.365 +00:00', app: 'brave', edited: true },
      }),
    });
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.ok(plan.id);
    assert.equal(plan.dictation, undefined, 'provenance is server-side only');
    assert.equal(plan.command, undefined, 'the command itself is not echoed either');
  });
});

test('POST /api/type refuses an id-free body and an unknown transcript', async () => {
  syntheticDb([{ id: 'known', timestamp: secondsAgo(10), edited: 'open my board' }]);
  await withServer(async (call) => {
    const bad = await call('/api/type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    const unknown = await call('/api/type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript_id: 'no-such-id' }),
    });
    assert.equal(unknown.status, 409);
    const body = await unknown.json();
    assert.ok(/no longer in your history/i.test(body.error));
  });
});

test('POST /api/type takes no text from the caller, only an id', async () => {
  syntheticDb([{ id: 'known', timestamp: secondsAgo(10), edited: 'open my board' }]);
  await withServer(async (call) => {
    // Smuggling a text field must be ignored: the runtime types what the id points at.
    const res = await call('/api/type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript_id: 'known', text: 'rm -rf /' }),
    });
    assert.ok([200, 409].includes(res.status), 'no crash, no 500');
    const body = await res.json();
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes('rm -rf'), false, 'caller-supplied text never reaches a receipt');
  });
});

test('the wispr endpoints require the session token', async () => {
  syntheticDb([{ id: 'a', timestamp: secondsAgo(10), edited: 'hello' }]);
  const runtime = createRuntime({ port: 0, host: '127.0.0.1' });
  const port = await runtime.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/wispr`);
    assert.equal(res.status, 401);
  } finally {
    if (runtime.close) await runtime.close();
  }
});