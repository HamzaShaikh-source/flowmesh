'use strict';
/**
 * The Electron connector must behave exactly like wispr_account.py. These run the
 * real module and the real HTTP surface against a loopback stand-in for Wispr's
 * OAuth + MCP servers (authorization code + PKCE with an exact redirect URI). They
 * prove the protocol is followed; they do not prove what Wispr's live tools return,
 * and the docs say so.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStore } = require('../config.js');
const { createAccount, WisprAccountError } = require('../wispr_account.js');
const { createRuntime } = require('../runtime.js');

const CODE = 'auth-code-1';
const REDIRECT = 'http://127.0.0.1:53682/oauth/wispr/callback';
const NOTES = {
  'n-1': { title: 'Sprint retro\x07 ideas', modified_at: '2026-10-21T10:00:00Z', content: 'Follow up with Rohan.\x00 Start a 25 minute research sprint.' },
  'n-2': { title: 'Groceries', modified_at: '2026-10-20T09:00:00Z', content: 'milk' },
};

function startMock({ sse = false, tools = ['search_scratchpad_notes', 'get_scratchpad_note'], evilTokenHost = false, deny = false, rejectCode = false } = {}) {
  const state = { log: [], revoked: false, access: 'at-1', refresh: 'rt-1', refreshCount: 1, registrations: 0, clients: {}, issued: {} };
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
      const url = new URL(req.url, base);
      let data = {};
      if (raw) data = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      state.log.push([req.method, url.pathname, req.method === 'GET' ? Object.fromEntries(url.searchParams) : data]);
      const resource = `${base}/connect/mcp`;
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
        return reply(200, { resource, authorization_servers: [base] });
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        return reply(200, {
          issuer: base,
          token_endpoint: evilTokenHost ? 'https://evil.example/oauth2/token' : `${base}/oauth2/token`,
          registration_endpoint: `${base}/oauth2/register`,
          authorization_endpoint: `${base}/oauth2/authorize`,
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
        const q = Object.fromEntries(url.searchParams);
        if (!(state.clients[q.client_id] || []).includes(q.redirect_uri)) return reply(400, { error: 'invalid_redirect_uri' });
        if (q.code_challenge_method !== 'S256' || !q.code_challenge) return reply(400, { error: 'invalid_request' });
        state.issued[CODE] = q;
        const params = deny ? { error: 'access_denied', state: q.state } : { code: CODE, state: q.state };
        return reply(302, null, { Location: `${q.redirect_uri}?${new URLSearchParams(params)}` }, '');
      }
      if (req.url === '/oauth2/register') {
        state.registrations += 1;
        const id = `cid-${state.registrations}`;
        state.clients[id] = data.redirect_uris || [];
        return reply(201, { client_id: id });
      }
      if (req.url === '/oauth2/token') {
        if (data.grant_type === 'refresh_token') {
          if (state.revoked || data.refresh_token !== state.refresh) return reply(400, { error: 'invalid_grant' });
          state.refreshCount += 1;
          state.access = `at-${state.refreshCount}`;
          state.refresh = `rt-${state.refreshCount}`;
          return reply(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 3600 });
        }
        const issued = state.issued[data.code];
        if (rejectCode || data.grant_type !== 'authorization_code' || !issued) return reply(400, { error: 'invalid_grant' });
        const challenge = crypto.createHash('sha256').update(data.code_verifier || '').digest('base64url');
        if (challenge !== issued.code_challenge || data.redirect_uri !== issued.redirect_uri || data.client_id !== issued.client_id) {
          return reply(400, { error: 'invalid_grant' });
        }
        delete state.issued[data.code]; // a code works once
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

/** What the browser does at Wispr's page: follow the authorize URL, return its redirect query. */
async function authorize(url) {
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return Object.fromEntries(new URL(response.headers.get('location')).searchParams);
}

function fixture(mock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-acct-'));
  const store = createStore({ dir, env: {}, cipher: null });
  const clock = { now: 1_000_000, advance(s) { this.now += s; } };
  const account = createAccount({ store, resource: mock.resource, loopbackHttp: true, clock: () => clock.now });
  const signIn = async () => {
    const { authorization_url: url } = await account.begin(REDIRECT);
    const { code, state } = await authorize(url);
    const result = await account.complete(code, state);
    assert.equal(result.ok, true, result.message);
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

test('starts disconnected; begin() returns the Wispr URL with PKCE and never the verifier', async () => {
  await withMock({}, async (mock, { account }) => {
    assert.equal(account.status().state, 'disconnected');
    const started = await account.begin(REDIRECT);
    const url = new URL(started.authorization_url);
    assert.equal(url.pathname, '/oauth2/authorize');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(url.searchParams.get('resource'), mock.resource);
    assert.equal(started.state, 'pending');
    assert.ok(!started.authorization_url.includes('code_verifier'));
    assert.ok(!JSON.stringify(started).includes('verifier'));
  });
});

test('registers once as a public client for the exact redirect', async () => {
  await withMock({}, async (mock, { account }) => {
    await account.begin(REDIRECT);
    await account.begin(REDIRECT);
    assert.equal(mock.state.registrations, 1);
    const [registration] = posted(mock, '/oauth2/register');
    assert.equal(registration.token_endpoint_auth_method, 'none');
    assert.deepEqual(registration.redirect_uris, [REDIRECT]);
    assert.deepEqual(registration.grant_types, ['authorization_code', 'refresh_token']);
  });
});

test('a good callback connects and stores only the refresh token and client', async () => {
  await withMock({}, async (mock, { account, store, signIn }) => {
    await signIn();
    assert.equal(account.status().state, 'connected');
    const blob = store.loadBlob('wispr_account');
    assert.equal(blob.refresh_token, 'rt-1');
    assert.equal(blob.access_token, undefined);
    const exchange = posted(mock, '/oauth2/token').at(-1);
    assert.deepEqual([exchange.grant_type, exchange.resource], ['authorization_code', mock.resource]);
    assert.ok(exchange.code_verifier);
  });
});

test('a callback with the wrong state is ignored and does not disturb the sign-in', async () => {
  await withMock({}, async (mock, { account }) => {
    const { authorization_url: url } = await account.begin(REDIRECT);
    const { code, state } = await authorize(url);
    assert.equal((await account.complete(code, 'attacker-state')).ok, false);
    assert.equal(account.status().state, 'pending', 'a forged callback must not cancel the real sign-in');
    assert.equal(posted(mock, '/oauth2/token').length, 0, 'no code may be exchanged for a wrong state');
    assert.equal((await account.complete(code, state)).ok, true);
  });
});

test('state is single use', async () => {
  await withMock({}, async (mock, { account }) => {
    const { code, state } = await authorize((await account.begin(REDIRECT)).authorization_url);
    assert.equal((await account.complete(code, state)).ok, true);
    assert.equal((await account.complete(code, state)).ok, false, 'a replayed callback must be refused');
  });
});

test('declined, rejected-code and expired sign-ins are reported once, never as connected', async () => {
  await withMock({ deny: true }, async (mock, { account }) => {
    const { state } = await authorize((await account.begin(REDIRECT)).authorization_url);
    assert.equal((await account.complete('', state, 'access_denied')).ok, false);
    assert.equal(account.status().state, 'denied');
    assert.equal(account.status().state, 'disconnected');
  });
  await withMock({ rejectCode: true }, async (mock, { account }) => {
    const { code, state } = await authorize((await account.begin(REDIRECT)).authorization_url);
    assert.equal((await account.complete(code, state)).ok, false);
    assert.equal(account.status().state, 'denied');
    assert.equal(account.status().state, 'disconnected');
  });
  await withMock({}, async (mock, { account, clock }) => {
    const { code, state } = await authorize((await account.begin(REDIRECT)).authorization_url);
    clock.advance(601);
    assert.equal((await account.complete(code, state)).ok, false);
    assert.equal(account.status().state, 'expired');
  });
});

test('only this app\'s own loopback callback is accepted as a return address', async () => {
  await withMock({}, async (mock, { account }) => {
    for (const bad of ['https://evil.example/oauth/wispr/callback', 'http://127.0.0.1/oauth/wispr/callback', 'http://127.0.0.1:1/other',
      'http://example.com:80/oauth/wispr/callback', 'http://127.0.0.1:1/oauth/wispr/callback?x=1', 'not a url']) {
      await assert.rejects(() => account.begin(bad), (e) => e instanceof WisprAccountError && e.kind === 'bad_request', bad);
    }
    assert.equal(mock.state.registrations, 0);
  });
});

test('prefetch registers in the background so connect is instant', async () => {
  await withMock({}, async (mock, { account }) => {
    account.prefetch(REDIRECT);
    const deadline = Date.now() + 5000;
    while (mock.state.registrations < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(mock.state.registrations, 1);
    const before = mock.state.log.length;
    await account.begin(REDIRECT);
    assert.equal(mock.state.log.length, before, 'begin() should need no network after prefetch');
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
    assert.equal(notes[0].title, 'Sprint retro ideas');
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
    await assert.rejects(() => account.begin(REDIRECT), (e) => e.kind === 'unsupported');
    assert.equal(mock.state.registrations, 0);
  });
});

test('plain http is refused unless loopback testing is enabled', async () => {
  await withMock({}, async (mock) => {
    const store = createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-acct-')), env: {}, cipher: null });
    const strict = createAccount({ store, resource: mock.resource, loopbackHttp: false });
    await assert.rejects(() => strict.begin(REDIRECT), (e) => e instanceof WisprAccountError);
  });
});

test('HTTP surface: full journey via the loopback callback, no secret leaks, forged callbacks refused', async () => {
  await withMock({}, async (mock, { account, store }) => {
    const runtime = createRuntime({ port: 0, host: '127.0.0.1', store, wisprAccount: account });
    const port = await runtime.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const call = (route, init = {}, token = runtime.sessionToken) =>
      fetch(`${base}${route}`, {
        ...init,
        headers: { ...(token ? { 'X-FlowMesh-Token': token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      });
    const post = (route, body) => call(route, { method: 'POST', body: JSON.stringify(body) });
    try {
      assert.equal((await call('/api/wispr/account/notes')).status, 409);
      const bodies = [];
      const take = async (res) => { const t = await res.text(); bodies.push(t); return JSON.parse(t); };
      assert.equal((await take(await call('/api/wispr/account'))).state, 'disconnected');
      const started = await take(await post('/api/wispr/account/connect', {}));
      assert.equal(started.state, 'pending');
      assert.equal(new URL(started.authorization_url).searchParams.get('redirect_uri'), `${base}/oauth/wispr/callback`);
      // A forged callback is refused, needs no token, and leaves the real sign-in alone.
      const forged = await fetch(`${base}/oauth/wispr/callback?code=x&state=nope`);
      assert.equal(forged.status, 400);
      assert.match(await forged.text(), /not valid/);
      assert.equal((await take(await call('/api/wispr/account'))).state, 'pending');
      // The real browser trip.
      const returned = await authorize(started.authorization_url);
      const ok = await fetch(`${base}/oauth/wispr/callback?${new URLSearchParams(returned)}`);
      const page = await ok.text();
      assert.equal(ok.status, 200);
      assert.match(page, /Connected/);
      assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
      assert.equal((await take(await post('/api/wispr/account/poll', {}))).state, 'connected');
      assert.equal((await take(await call('/api/wispr/account/notes'))).notes.length, 2);
      assert.match((await take(await post('/api/wispr/account/note', { note_id: 'n-1' }))).text, /research sprint/);
      for (const secret of ['at-1', 'rt-1', CODE, 'code_verifier']) {
        for (const text of [...bodies, page]) assert.ok(!text.includes(secret), `${secret} leaked`);
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
