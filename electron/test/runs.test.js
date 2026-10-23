'use strict';
/** History: only records FlowMesh itself wrote can be listed or read (twin of tests/test_runs.py). */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStore } = require('../config.js');
const { createRuntime } = require('../runtime.js');

async function withRuntime(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-runs-'));
  const env = { FLOWMESH_ARTIFACT_DIR: path.join(dir, 'runs') };
  const store = createStore({ dir: path.join(dir, 'cfg'), env, cipher: null });
  const runtime = createRuntime({ port: 0, host: '127.0.0.1', store, env });
  const port = await runtime.listen(0);
  const call = (route, token = runtime.sessionToken) =>
    fetch(`http://127.0.0.1:${port}${route}`, { headers: token ? { 'X-FlowMesh-Token': token } : {} });
  const post = async (route, body) => (await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'X-FlowMesh-Token': runtime.sessionToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const makeRun = async (command = 'capture: remember the quote') => {
    const plan = await post('/api/plan', { command });
    const { results } = await post('/api/execute', { plan_id: plan.id });
    return results.at(-1).path;
  };
  try {
    await fn({ call, makeRun, dir });
  } finally {
    await runtime.close();
  }
}

test('a run is listed and can be read back', async () => {
  await withRuntime(async ({ call, makeRun }) => {
    const file = await makeRun();
    const { runs } = await (await call('/api/runs')).json();
    assert.equal(runs.length, 1);
    assert.ok(file.endsWith(runs[0].name));
    assert.ok(runs[0].title);
    const res = await call(`/api/runs/${encodeURIComponent(runs[0].name)}`);
    assert.equal(res.status, 200);
    const record = await res.json();
    assert.match(record.text, /remember the quote/);
    assert.equal(record.truncated, false);
  });
});

test('only generated names are readable', async () => {
  await withRuntime(async ({ call, makeRun, dir }) => {
    await makeRun();
    fs.writeFileSync(path.join(dir, 'runs', 'notes.txt'), 'private');
    for (const name of ['notes.txt', '..%2Fcfg%2Fsettings.json', '..%5C..%5Cx.md', 'flowmesh-.md', 'flowmesh-a.txt',
      'flowmesh-../x.md', '%2e%2e%2fx', `flowmesh-${'a'.repeat(200)}.md`]) {
      assert.equal((await call(`/api/runs/${name}`)).status, 404, name);
    }
    const listed = (await (await call('/api/runs')).json()).runs.map((r) => r.name);
    assert.ok(!listed.includes('notes.txt'));
  });
});

test('the routes need the session token and the list is newest first', async () => {
  await withRuntime(async ({ call, makeRun }) => {
    for (const route of ['/api/runs', '/api/runs/flowmesh-x.md']) assert.equal((await call(route, null)).status, 401, route);
    await makeRun('capture: first');
    await new Promise((r) => setTimeout(r, 1100));
    await makeRun('capture: second');
    const { runs } = await (await call('/api/runs')).json();
    assert.equal(runs.length, 2);
    assert.ok(runs[0].modified >= runs[1].modified);
  });
});
