'use strict';
/**
 * The Electron connector must behave exactly like wispr_account.py. These run the
 * real module and the real HTTP surface against a loopback stand-in for Wispr's
 * OAuth + MCP servers. They prove the protocol is followed; they do not prove what
 * Wispr's live tools return, and the docs say so.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStore } = require('../config.js');
const { createAccount, WisprAccountError } = require('../wispr_account.js');
const { createRuntime } = require('../runtime.js');

const NOTES = {
  'n-1': { title: 'Sprint retro\x07 ideas', modified_at: '2026-10-21T10:00:00Z', content: 'Follow up with Rohan.\x00 Start a 25 minute research sprint.' },
  'n-2': { title: 'Groceries', modified_at: '2026-10-20T09:00:00Z', content: 'milk' },
};

function startMock({ pendingPolls = 1, sse = false, tools = ['search_scratchpad_notes', 'get_scratchpad_note'], evilTokenHost = false } = {}) {
  const state = { log: [], revoked: false, access: 'at-1', refresh: 'rt-1', refreshCount: 1, registrations: 0, polls: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const base = `http://127.0.0.1:${server.address().port}`;
      const reply = (status, payload, headers = {}, rawBody = null, type = 'application/json') => {
        const body = rawBody !== null ? rawBody : JSON.stringify(payload || {});
        res.writeHead(status, { 'Content-Type': type, ...headers });
        res.end(body);
      };
      let data = {};
      if (raw) {
        data = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      }
      state.log.push([req.method, req.url, data]);
      const resource = `${base}/connect/mcp`;
      if (req.method === 'GET' && req.url === '/.well-known/oauth-protected-resource') {
        return reply(200, { resource, authorization_servers: [base] });
      }
      if (req.method === 'GET' && req.url === '/.well-known/oauth-authorization-server') {
        return reply(200, {
          issuer: base,
          token_endpoint: evilTokenHost ? 'https://evil.example/oauth2/token' : `${base}/oauth2/token`,
          registration_endpoint: `${base}/oauth2/register`,
          device_authorization_endpoint: `${base}/oauth2/device_authorization`,
          grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
        });
      }
      if (req.url === '/oauth2/register') {
        state.registrations += 1;
        return reply(201, { client_id: 'cid-1' });
      }
      if (req.url === '/oauth2/device_authorization') {
        return reply(200, {
          device_code: 'dev-secret', user_code: 'ABCD-1234', verification_uri: `${base}/activate`,
          verification_uri_complete: `${base}/activate?c=ABCD-1234`, expires_in: 600, interval: 5,
        });
      }
      if (req.url === '/oauth2/token') {
        if (data.grant_type === 'refresh_token') {
          if (state.revoked || data.refresh_token !== state.refresh) return reply(400, { error: 'invalid_grant' });
          state.refreshCount += 1;
          state.access = `at-${state.refreshCount}`;
          state.refresh = `rt-${state.refreshCount}`;
          return reply(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 3600 });
        }
        if (state.polls < pendingPolls) {
          state.polls += 1;
          return reply(400, { error: 'authorization_pending' });
        }
        if (data.device_code !== 'dev-secret') return reply(400, { error: 'access_denied' });
        return reply(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 3600 });
      }
      if (req.url === '/connect/mcp') {
        if (req.headers.authorization !== `Bearer ${state.access}`) return reply(401, { error: 'invalid_token' });
        const rpc = (result, headers) => {
          const message = { jsonrpc: '2.0', id: data.id, result };
          if (sse) return reply(200, null, headers, `event: message\ndata: ${JSON.stringify(message)}\n\n`, 'text/event-stream');
          return reply(200, message, headers);
        };
        if (data.method === 'notifications/initialized') return reply(202, null, {}, '');
        if (data.method === 'initialize') return rpc({ protocolVersion: '2025-06-18', capabilities: {} }, { 'Mcp-Session-Id': 'sess-1' });
        if (req.headers['mcp-session-id'] !== 'sess-1') return reply(404);
        if (data.method === 'tools/list') {
          return rpc({ tools: tools.map((name) => ({ name, inputSchema: { properties: { query: {}, limit: {}, note_id: {} } } })) });
        }
        if (data.method === 'tools/call') {
          const { name, arguments: args = {} } = data.params;
          if (name === 'search_scratchpad_notes') {
            const notes = Object.entries(NOTES).map(([note_id, v]) => ({ note_id, title: v.title, modified_at: v.modified_at }));
            return rpc({ content: [], structuredContent: { notes } });
          }
          if (name === 'get_scratchpad_note') {
            const note = NOTES[args.note_id];
            if (!note) return rpc({ isError: true, content: [{ type: 'text', text: 'nope' }] });
            return rpc({ content: [{ type: 'text', text: JSON.stringify({ content: note.content }) }] });
          }
        }
        return reply(400);
      }
      return reply(404);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ state, base, resource: `${base}/connect/mcp`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function fixture(mock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-acct-'));
  const store = createStore({ dir, env: {}, cipher: null });
  const clock = { now: 1_000_000, advance(s) { this.now += s; } };
  const account = createAccount({ store, resource: mock.resource, loopbackHttp: true, clock: () => clock.now });
  const signIn = async () => {
    await account.begin();
    clock.advance(6);
    while ((await account.poll()).state === 'pending') clock.advance(6);
  };
  return { store, clock, account, signIn };
}

async function withMock(options, fn) {
  const mock = await startMock(options);
  try {
    await fn(mock, fixture(mock));
  } finally {
    await mock.close();
  }
}

const posted = (mock, url) => mock.state.log.filter(([m, u]) => m === 'POST' && u === url).map(([, , d]) => d);

test('starts disconnected and begin() never exposes the device code or client id', async () => {
  await withMock({}, async (mock, { account }) => {
    assert.equal(account.status().state, 'disconnected');
    const started = await account.begin();
    assert.equal(started.user_code, 'ABCD-1234');
    assert.ok(started.verification_uri.endsWith('/activate'));
    assert.ok(!JSON.stringify(started).includes('dev-secret'));
    assert.ok(!JSON.stringify(started).includes('cid-1'));
  });
});

test('registers once, as a public client', async () => {
  await withMock({}, async (mock, { account }) => {
    await account.begin();
    await account.begin();
    assert.equal(mock.state.registrations, 1);
    const [registration] = posted(mock, '/oauth2/register');
    assert.equal(registration.token_endpoint_auth_method, 'none');
    assert.ok(registration.grant_types.includes('urn:ietf:params:oauth:grant-type:device_code'));
  });
});

test('does not poll before the server interval and stores the refresh token on success', async () => {
  await withMock({ pendingPolls: 2 }, async (mock, { account, clock, store }) => {
    await account.begin();
    await account.poll();
    assert.equal(posted(mock, '/oauth2/token').length, 0, 'polled before the interval elapsed');
    let state = 'pending';
    while (state === 'pending') {
      clock.advance(6);
      state = (await account.poll()).state;
    }
    assert.equal(state, 'connected');
    assert.equal(posted(mock, '/oauth2/token').length, 3, 'two pending answers, then success');
    assert.equal(account.status().state, 'connected');
    assert.equal(store.loadBlob('wispr_account').refresh_token, 'rt-1');
  });
});

test('an expired code is reported, not retried forever', async () => {
  await withMock({}, async (mock, { account, clock }) => {
    await account.begin();
    clock.advance(601);
    assert.equal((await account.poll()).state, 'expired');
    assert.equal(account.status().state, 'disconnected');
  });
});

test('disconnect forgets tokens and says the grant survives at Wispr', async () => {
  await withMock({}, async (mock, { account, store, signIn }) => {
    await signIn();
    const result = account.disconnect();
    assert.equal(result.state, 'disconnected');
    assert.match(result.detail, /Revoke/);
    assert.equal(store.loadBlob('wispr_account').refresh_token, undefined);
  });
});

test('lists notes and reads one, with control characters stripped', async () => {
  await withMock({}, async (mock, { account, signIn }) => {
    await signIn();
    const notes = await account.listNotes();
    assert.deepEqual(notes.map((n) => n.id), ['n-1', 'n-2']);
    assert.ok(!notes[0].title.includes('\x07'));
    const note = await account.getNote('n-1');
    assert.match(note.text, /Follow up with Rohan/);
    assert.ok(!note.text.includes('\x00'));
  });
});

test('rejects ids that are not plain identifiers', async () => {
  await withMock({}, async (mock, { account, signIn }) => {
    await signIn();
    for (const bad of ['', '../x', 'a b', 'n-1\n', 'x'.repeat(200), null, 7]) {
      await assert.rejects(() => account.getNote(bad), (e) => e instanceof WisprAccountError && e.kind === 'bad_request');
    }
  });
});

test('parses server-sent-event answers', async () => {
  await withMock({ sse: true }, async (mock, { account, signIn }) => {
    await signIn();
    assert.equal((await account.listNotes()).length, 2);
  });
});

test('only allow-listed tools are ever called, even if a history tool exists', async () => {
  await withMock({ tools: ['search_scratchpad_notes', 'get_scratchpad_note', 'get_dictation_history'] }, async (mock, { account, signIn }) => {
    await signIn();
    await account.listNotes();
    await account.getNote('n-2');
    const called = new Set(posted(mock, '/connect/mcp').filter((d) => d.method === 'tools/call').map((d) => d.params.name));
    assert.deepEqual([...called].sort(), ['get_scratchpad_note', 'search_scratchpad_notes']);
  });
});

test('a server without the note tools is unsupported, not empty', async () => {
  await withMock({ tools: ['something_else'] }, async (mock, { account, signIn }) => {
    await signIn();
    await assert.rejects(() => account.listNotes(), (e) => e.kind === 'unsupported');
  });
});

test('refreshes an expired access token and keeps the rotated refresh token', async () => {
  await withMock({}, async (mock, { account, clock, store, signIn }) => {
    await signIn();
    clock.advance(4000);
    assert.equal((await account.listNotes()).length, 2);
    assert.equal(store.loadBlob('wispr_account').refresh_token, 'rt-2');
  });
});

test('a revoked grant becomes expired and drops the token', async () => {
  await withMock({}, async (mock, { account, clock, signIn }) => {
    await signIn();
    mock.state.revoked = true;
    clock.advance(4000);
    await assert.rejects(() => account.listNotes(), (e) => e.kind === 'expired');
    assert.equal(account.status().state, 'disconnected');
  });
});

test('a token endpoint on another host is refused before registering', async () => {
  await withMock({ evilTokenHost: true }, async (mock, { account }) => {
    await assert.rejects(() => account.begin(), (e) => e.kind === 'unsupported');
    assert.equal(mock.state.registrations, 0);
  });
});

test('plain http is refused unless loopback testing is enabled', async () => {
  await withMock({}, async (mock) => {
    const store = createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-acct-')), env: {}, cipher: null });
    const strict = createAccount({ store, resource: mock.resource, loopbackHttp: false });
    await assert.rejects(() => strict.begin(), (e) => e instanceof WisprAccountError);
  });
});

test('HTTP surface: full journey, auth required, id-only note route, 409 not 401', async () => {
  await withMock({ pendingPolls: 0 }, async (mock, { account, clock, store }) => {
    const runtime = createRuntime({ port: 0, host: '127.0.0.1', store, wisprAccount: account });
    const port = await runtime.listen(0);
    const call = (route, init = {}, token = runtime.sessionToken) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        ...init,
        headers: { ...(token ? { 'X-FlowMesh-Token': token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      });
    const post = (route, body) => call(route, { method: 'POST', body: JSON.stringify(body) });
    try {
      assert.equal((await call('/api/wispr/account/notes')).status, 409);
      const bodies = [];
      const take = async (res) => { const t = await res.text(); bodies.push(t); return JSON.parse(t); };
      assert.equal((await take(await call('/api/wispr/account'))).state, 'disconnected');
      assert.equal((await take(await post('/api/wispr/account/connect', {}))).user_code, 'ABCD-1234');
      clock.advance(6);
      assert.equal((await take(await post('/api/wispr/account/poll', {}))).state, 'connected');
      assert.equal((await take(await call('/api/wispr/account/notes'))).notes.length, 2);
      assert.match((await take(await post('/api/wispr/account/note', { note_id: 'n-1' }))).text, /research sprint/);
      for (const secret of ['at-1', 'rt-1', 'dev-secret', 'cid-1']) {
        for (const text of bodies) assert.ok(!text.includes(secret), `${secret} leaked`);
      }
      assert.equal((await post('/api/wispr/account/note', { note_id: 'n-1', text: 'rm -rf /' })).status, 400);
      for (const route of ['/api/wispr/account', '/api/wispr/account/notes']) {
        assert.equal((await call(route, {}, null)).status, 401, route);
      }
      assert.equal((await call('/api/wispr/account/connect', { method: 'POST', body: '{}' }, null)).status, 401);
    } finally {
      await runtime.close();
    }
  });
});
