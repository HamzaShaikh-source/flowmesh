'use strict';
/** MCP client, risk levels, schema checks and server registry (Node twin of the Python tests). */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStore } = require('../config.js');
const mcpClient = require('../mcp_client.js');
const registry = require('../mcp_registry.js');
const { PRESETS } = require('../mcp_presets.js');

const MOCK = path.join(__dirname, 'fixtures', 'mock_mcp_server.js');
const { McpError, StdioTransport, McpSession } = mcpClient;

const openSession = (env) => new McpSession(new StdioTransport(process.execPath, [MOCK], env), 'mock').open();
const freshStore = () => createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-mcp-')), env: {}, cipher: null });
const stdio = (id = 'notes', extra = {}) => ({ id, label: 'Notes', transport: 'stdio', command: process.execPath, args: [MOCK], ...extra });

async function withSession(fn, env) {
  const session = await openSession(env);
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

test('client: initializes, lists tools and ignores non-JSON stdout', async () => {
  await withSession(async (session) => {
    assert.equal(session.serverInfo.name, 'mock-notes');
    const names = (await session.listTools()).map((t) => t.name);
    assert.ok(names.includes('echo') && names.includes('delete_note'));
  });
});

test('client: calls a tool; tool errors are flagged, protocol errors raised', async () => {
  await withSession(async (session) => {
    assert.deepEqual(
      (({ is_error, text }) => ({ is_error, text }))(await session.callTool('echo', { text: 'hello' })),
      { is_error: false, text: 'hello' },
    );
    const failed = await session.callTool('fail', {});
    assert.equal(failed.is_error, true);
    assert.equal(failed.text, 'it broke');
    await assert.rejects(() => session.callTool('nope', {}), (e) => e instanceof McpError && e.kind === 'server_error');
  });
});

test('client: output is stripped of control characters and truncated', async () => {
  await withSession(async (session) => {
    const result = await session.callTool('big_output', {});
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= mcpClient.MAX_OUTPUT_CHARS);
    assert.ok(!result.text.includes('\x00') && !result.text.includes('\x07'));
  });
});

test('client: a slow call times out without killing the session', async () => {
  await withSession(async (session) => {
    await assert.rejects(() => session.callTool('slow', { seconds: 3 }, 400), (e) => e.kind === 'timeout');
    assert.equal((await session.callTool('echo', { text: 'still here' })).text, 'still here');
  });
});

test('client: server-initiated requests are refused', async () => {
  await withSession(async (session) => {
    const result = await session.callTool('ask_sampling', {});
    assert.match(result.text, /-32601/);
    assert.match(result.text, /does not support/);
  });
});

test('client: a dead server reports unavailable, and close terminates the child', async () => {
  const session = await openSession();
  const { child } = session.transport;
  await session.close();
  assert.ok(child.exitCode !== null || child.killed || child.signalCode !== null);
  await assert.rejects(() => session.callTool('echo', { text: 'x' }), (e) => e.kind === 'unavailable');
});

test('client: FlowMesh secrets are not inherited, configured ones are', async () => {
  process.env.FLOWMESH_HA_TOKEN = 'x';
  process.env.TYPESAFE_API_KEY = 'y';
  process.env.ANTHROPIC_API_KEY = 'z';
  try {
    await withSession(async (session) => {
      const { text } = await session.callTool('env_probe', {});
      assert.match(text, /GITHUB_TOKEN/);
      for (const name of ['FLOWMESH_HA_TOKEN', 'TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY']) assert.ok(!text.includes(name), name);
    }, { GITHUB_TOKEN: 'configured' });
  } finally {
    delete process.env.FLOWMESH_HA_TOKEN;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('client: a missing executable and shell-looking commands are refused plainly', async () => {
  await assert.rejects(() => new McpSession(new StdioTransport('definitely-not-a-real-program-xyz', [])).open(), (e) => e.kind === 'unavailable');
  assert.equal(mcpClient.resolveCommand('node; rm -rf /'), null);
  assert.equal(mcpClient.resolveCommand('node\nx'), null);
});

test('client: cmd.exe shims refuse shell metacharacters in arguments', () => {
  const plan = mcpClient.launchPlan('C:\\tools\\npx.cmd', ['-y', 'pkg'], 'win32', { ComSpec: 'cmd.exe' });
  assert.equal(plan.file, 'cmd.exe');
  for (const bad of ['a&b', 'a|b', 'a>b', 'a^b', '%PATH%', 'a!b', 'a"b', 'a\nb']) {
    assert.throws(() => mcpClient.launchPlan('C:\\tools\\npx.cmd', [bad], 'win32'), (e) => e.kind === 'bad_config', bad);
  }
  assert.equal(mcpClient.launchPlan('C:\\tools\\node.exe', ['a&b'], 'win32').file, 'C:\\tools\\node.exe', '.exe is not run through cmd');
});

test('client: remote http, embedded credentials and odd schemes are refused', () => {
  for (const url of ['http://example.com/mcp', 'https://user:pw@example.com/mcp', 'ftp://x/y', 'not a url']) {
    assert.throws(() => new mcpClient.HttpTransport(url), (e) => e instanceof McpError, url);
  }
  new mcpClient.HttpTransport('https://example.com/mcp');
  new mcpClient.HttpTransport('http://127.0.0.1:9/mcp');
});

test('risk: derived by FlowMesh, and a name cannot be lowered by a read-only claim', () => {
  const { classify, READ, WRITE, DANGER } = registry;
  assert.equal(classify({ name: 'list_files', annotations: { readOnlyHint: true } }), READ);
  assert.equal(classify({ name: 'send_message' }), WRITE);
  assert.equal(classify({ name: 'x', annotations: { destructiveHint: true } }), DANGER);
  assert.equal(classify({ name: 'delete_repo', annotations: { readOnlyHint: true } }), DANGER);
  assert.equal(classify({ name: 'run_command' }), DANGER);
  assert.equal(classify({ name: 'git_reset' }), DANGER);
  assert.equal(classify({ name: 'remover_info', annotations: { readOnlyHint: true } }), READ);
  assert.equal(classify({ name: 'shellfish_menu', annotations: { readOnlyHint: true } }), READ);
});

test('schema: valid arguments pass and each kind of mistake is reported', () => {
  const schema = {
    type: 'object', required: ['title'], additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 5 }, count: { type: 'integer', minimum: 1, maximum: 3 },
      kind: { enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    },
  };
  assert.deepEqual(registry.validateArguments(schema, { title: 'hi', count: 2, kind: 'a', tags: ['x'] }), []);
  const bad = {
    required: {}, type: { title: 5 }, maxLength: { title: 'toolong' }, minimum: { title: 'a', count: 0 },
    maximum: { title: 'a', count: 9 }, enum: { title: 'a', kind: 'z' }, extra: { title: 'a', evil: 1 },
    items: { title: 'a', tags: [1] }, maxItems: { title: 'a', tags: ['a', 'b', 'c'] },
  };
  for (const [label, value] of Object.entries(bad)) assert.ok(registry.validateArguments(schema, value).length, label);
  const anyOf = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  assert.deepEqual(registry.validateArguments(anyOf, 'x'), []);
  assert.ok(registry.validateArguments(anyOf, [1]).length);
  assert.deepEqual(registry.validateArguments(null, { a: 1 }), []);
  assert.deepEqual(registry.validateArguments({ $ref: '#/x' }, 5), []);
});

test('registry: secrets are masked outwards and kept when the mask comes back', async () => {
  const manager = registry.createManager({ store: freshStore() });
  try {
    const saved = await manager.upsert(stdio('notes', { env: { API_TOKEN: 's3cret' } }));
    assert.deepEqual(saved.env, { API_TOKEN: registry.MASK });
    assert.ok(!JSON.stringify(manager.listServers()).includes('s3cret'));
    await manager.upsert(stdio('notes', { env: { API_TOKEN: registry.MASK, OTHER: 'v' } }));
    assert.deepEqual(manager.get('notes').env, { API_TOKEN: 's3cret', OTHER: 'v' });
    const remote = await manager.upsert({ id: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } });
    assert.deepEqual(remote.headers, { Authorization: registry.MASK });
    assert.ok(!JSON.stringify(manager.listServers()).includes('Bearer abc'));
  } finally {
    await manager.closeAll();
  }
});

test('registry: bad configs are rejected with a sentence', () => {
  const bad = [
    { id: 'Bad Id', transport: 'stdio', command: 'x' }, { id: 'a', transport: 'ftp' },
    { id: 'a', transport: 'stdio', command: '' }, { id: 'a', transport: 'stdio', command: 'x\ny' },
    { id: 'a', transport: 'stdio', command: 'x', args: new Array(40).fill('a') },
    { id: 'a', transport: 'stdio', command: 'x', env: { 'bad name': 'v' } },
    { id: 'a', transport: 'http', url: 'http://example.com/mcp' },
    { id: 'a', transport: 'http', url: 'https://u:p@example.com/mcp' },
    { id: 'a', transport: 'http', url: 'https://example.com', headers: { X: 'a\nb' } }, 'not an object',
  ];
  for (const raw of bad) assert.throws(() => registry.validateServer(raw), Error, JSON.stringify(raw));
});

test('registry: persistence, removal and the server cap', async () => {
  const store = freshStore();
  const manager = registry.createManager({ store });
  try {
    await manager.upsert(stdio());
    assert.deepEqual(registry.createManager({ store }).listServers().map((s) => s.id), ['notes']);
    assert.equal(await manager.remove('notes'), true);
    assert.equal(await manager.remove('notes'), false);
    for (let i = 0; i < registry.MAX_SERVERS; i += 1) await manager.upsert(stdio(`s${i}`));
    await assert.rejects(() => manager.upsert(stdio('one-too-many')), /At most/);
  } finally {
    await manager.closeAll();
  }
});

test('plans: catalog, reviewable actions, auto_ok needs a read tool and the opt-in', async () => {
  const manager = registry.createManager({ store: freshStore() });
  try {
    await manager.upsert(stdio());
    const catalog = await manager.catalog();
    const risks = Object.fromEntries(catalog.tools.map((t) => [t.name, t.risk]));
    assert.deepEqual([risks.echo, risks.add_note, risks.delete_note, risks.fail], ['read', 'write', 'danger', 'write']);
    const [action] = await manager.planActions([{ server: 'notes', tool: 'add_note', arguments: { title: 'Hi', body: 'there' } }]);
    assert.deepEqual([action.kind, action.risk, action.target, action.auto_ok], ['mcp_call', 'write', 'notes/add_note', false]);
    assert.match(action.detail, /title: Hi/);
    const read = [{ server: 'notes', tool: 'echo', arguments: { text: 'x' } }];
    assert.equal((await manager.planActions(read))[0].auto_ok, false);
    await manager.upsert(stdio('notes', { auto_read: true }));
    assert.equal((await manager.planActions(read))[0].auto_ok, true);
    const write = [{ server: 'notes', tool: 'add_note', arguments: { title: 'x' } }];
    assert.equal((await manager.planActions(write))[0].auto_ok, false, 'a write tool must never auto-run');
  } finally {
    await manager.closeAll();
  }
});

test('plans: invalid calls are refused before anything exists', async () => {
  const manager = registry.createManager({ store: freshStore() });
  try {
    await manager.upsert(stdio());
    const cases = [
      [], [{ server: 'notes', tool: 'add_note', arguments: {} }],
      [{ server: 'notes', tool: 'add_note', arguments: { title: 'x', evil: 1 } }], [{ server: 'notes', tool: 'nope', arguments: {} }],
      [{ server: 'ghost', tool: 'echo', arguments: { text: 'x' } }], [{ server: 'notes', tool: 'echo', arguments: { text: 'x'.repeat(500) } }],
      [{ server: 'notes', tool: 'echo', arguments: { text: 'x' }, shell: 'rm -rf /' }], [{ server: 'notes', tool: 'echo', arguments: 'text' }],
      'not a list', new Array(9).fill({ server: 'notes', tool: 'echo', arguments: { text: 'x' } }),
    ];
    for (const calls of cases) await assert.rejects(() => manager.planActions(calls), Error, JSON.stringify(calls).slice(0, 80));
    await manager.upsert(stdio('notes', { enabled: false }));
    await assert.rejects(() => manager.planActions([{ server: 'notes', tool: 'echo', arguments: { text: 'x' } }]));
  } finally {
    await manager.closeAll();
  }
});

test('registry: test() reports tool count and a broken server lands in catalog errors', async () => {
  const manager = registry.createManager({ store: freshStore() });
  try {
    await manager.upsert(stdio());
    const result = await manager.test('notes');
    assert.equal(result.ok, true);
    assert.ok(result.tools >= 6);
    await manager.upsert({ id: 'broken', transport: 'stdio', command: 'definitely-not-a-program-xyz' });
    const catalog = await manager.catalog();
    assert.ok('broken' in catalog.errors);
    assert.ok(catalog.tools.length > 0);
  } finally {
    await manager.closeAll();
  }
});

test('presets: every template is a valid server once its inputs are filled', () => {
  assert.ok(PRESETS.length >= 6);
  for (const preset of PRESETS) {
    const fill = (value) => String(value).replace(/\{(\w+)\}/g, 'x');
    const server = preset.transport === 'stdio'
      ? { id: preset.id, transport: 'stdio', command: preset.command, args: preset.args.map(fill) }
      : { id: preset.id, transport: 'http', url: preset.url, headers: Object.fromEntries(Object.entries(preset.headers || {}).map(([k, v]) => [k, fill(v)])) };
    assert.doesNotThrow(() => registry.validateServer(server), preset.id);
  }
});

test('parity: risk levels and schema checks match the shared golden fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'mcp_cases.json'), 'utf8'));
  for (const item of fixture.classify) assert.equal(registry.classify(item.tool), item.risk, JSON.stringify(item.tool));
  for (const item of fixture.validate) {
    assert.equal(registry.validateArguments(item.schema, item.value).length === 0, item.valid, JSON.stringify(item));
  }
});

test('exit: killAllNow terminates the real child process', async () => {
  const manager = registry.createManager({ store: freshStore() });
  await manager.upsert(stdio());
  let pid = 0;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    pid = Number((await manager.call('notes', 'pid', {})).text);
    assert.ok(pid > 0);
    assert.equal(alive(), true, 'the child should be running before the kill');
    manager.killAllNow();
    const deadline = Date.now() + 4000;
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(), false, 'the child survived killAllNow');
  } finally {
    // A failed assertion must never leave a server running (it would hang the runner).
    if (pid > 0 && alive()) process.kill(pid);
    await manager.closeAll();
  }
});
