'use strict';
/**
 * Connect a Wispr Flow account through Wispr's own, supported interface.
 *
 * Port of wispr_account.py; read that file's header for the full rationale. The
 * rules are the same and are enforced here, not promised:
 *   - browser sign-in with PKCE and a loopback callback (no password), public client
 *     with no secret. Wispr advertises a device flow, but its device page rejects
 *     third-party codes ("Missing external_auth_id"), so this is the flow that works;
 *   - only the Scratchpad note tools are ever called, and anything whose name
 *     mentions dictation, history or transcripts is refused by name;
 *   - Wispr's text is untrusted: stripped, capped, and only ever placed in the
 *     command box for the user to read, never planned or run without approval;
 *   - tokens never leave this module; callers get state and note text;
 *   - HTTPS only (loopback HTTP solely for tests), no redirects followed, and every
 *     endpoint named by discovery must sit on the issuer's own host.
 */

const crypto = require('node:crypto');

const RESOURCE = 'https://api.wisprflow.ai/connect/mcp';
const SCOPE = 'openid offline_access';
const CALLBACK_PATH = '/oauth/wispr/callback';
const SIGN_IN_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 10000;
const MCP_PROTOCOL = '2025-06-18';
const BLOB = 'wispr_account';

const TOOL_SEARCH = 'search_scratchpad_notes';
const TOOL_GET = 'get_scratchpad_note';
const FORBIDDEN_TOOL = /dictation|history|transcript/i;

const MAX_BODY = 1_000_000;
const REFRESH_SKEW_SECONDS = 120;
const MAX_NOTE_CHARS = 4000;
const MAX_TITLE_CHARS = 120;
const NOTE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

class WisprAccountError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.userMessage = message;
  }
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').trim().slice(0, limit);
}

function createAccount({ store, resource = RESOURCE, loopbackHttp = false, clock = () => Date.now() / 1000, fetchImpl = globalThis.fetch, version = '0' } = {}) {
  let meta = null;
  let pending = null;
  let access = null; // { token, expiresAt }
  let outcome = null;
  const clients = new Map();
  const registering = new Map();

  function checkUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new WisprAccountError('bad_response', 'Wispr returned an endpoint that is not HTTPS.');
    }
    if (parsed.protocol === 'https:' && !parsed.username) return;
    if (loopbackHttp && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)) return;
    throw new WisprAccountError('bad_response', 'Wispr returned an endpoint that is not HTTPS.');
  }

  async function request(method, url, { form, payload, headers = {} } = {}) {
    checkUrl(url);
    const out = { Accept: 'application/json, text/event-stream', 'User-Agent': 'FlowMesh', ...headers };
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      out['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (payload) {
      body = JSON.stringify(payload);
      out['Content-Type'] = 'application/json';
    }
    try {
      const response = await fetchImpl(url, { method, headers: out, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = (await response.text()).slice(0, MAX_BODY);
      return { status: response.status, headers: response.headers, text };
    } catch {
      throw new WisprAccountError('unavailable', 'Could not reach Wispr. Check your connection and try again.');
    }
  }

  function parseJson(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new WisprAccountError('bad_response', 'Wispr sent an answer FlowMesh could not read.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WisprAccountError('bad_response', 'Wispr sent an unexpected answer.');
    }
    return value;
  }

  async function discover() {
    if (meta) return meta;
    const root = new URL(resource);
    const first = await request('GET', `${root.origin}/.well-known/oauth-protected-resource`);
    if (first.status !== 200) throw new WisprAccountError('unavailable', "Wispr's sign-in service did not answer.");
    const protectedResource = parseJson(first.text);
    if (protectedResource.resource !== resource) {
      throw new WisprAccountError('bad_response', "Wispr's sign-in service names a different resource.");
    }
    const issuers = protectedResource.authorization_servers;
    if (!Array.isArray(issuers) || typeof issuers[0] !== 'string' || !issuers[0]) {
      throw new WisprAccountError('bad_response', "Wispr's sign-in service lists no issuer.");
    }
    const issuer = issuers[0].replace(/\/+$/, '');
    checkUrl(issuer);
    const second = await request('GET', `${issuer}/.well-known/oauth-authorization-server`);
    if (second.status !== 200) throw new WisprAccountError('unavailable', "Wispr's sign-in service did not answer.");
    const document = parseJson(second.text);
    if (String(document.issuer || '').replace(/\/+$/, '') !== issuer) {
      throw new WisprAccountError('bad_response', "Wispr's sign-in metadata names a different issuer.");
    }
    const host = new URL(issuer).host;
    const endpoints = {};
    for (const key of ['token_endpoint', 'registration_endpoint', 'authorization_endpoint']) {
      const value = document[key];
      let sameHost = false;
      try {
        sameHost = typeof value === 'string' && new URL(value).host === host;
      } catch {
        sameHost = false;
      }
      if (!sameHost) {
        throw new WisprAccountError('unsupported', `Wispr's sign-in service does not offer ${key.replace(/_/g, ' ')}.`);
      }
      checkUrl(value);
      endpoints[key] = value;
    }
    const grants = document.grant_types_supported;
    if (Array.isArray(grants) && !grants.includes('authorization_code')) {
      throw new WisprAccountError('unsupported', "Wispr's sign-in service does not offer browser sign-in.");
    }
    const methods = document.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) {
      throw new WisprAccountError('unsupported', "Wispr's sign-in service does not support PKCE.");
    }
    meta = { issuer, ...endpoints };
    return meta;
  }

  /** A public client for this exact redirect URI, registered once per launch. */
  async function register(found, redirectUri) {
    if (clients.has(redirectUri)) return clients.get(redirectUri);
    // One registration at a time: the background prefetch and a click on Connect can arrive
    // together, and both must end up with the same client.
    if (registering.has(redirectUri)) return registering.get(redirectUri);
    const attempt = registerOnce(found, redirectUri);
    registering.set(redirectUri, attempt);
    try {
      return await attempt;
    } finally {
      registering.delete(redirectUri);
    }
  }

  async function registerOnce(found, redirectUri) {
    const { status, text } = await request('POST', found.registration_endpoint, {
      payload: {
        client_name: 'FlowMesh',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      },
    });
    const answer = parseJson(text);
    if (![200, 201].includes(status) || typeof answer.client_id !== 'string' || !answer.client_id) {
      throw new WisprAccountError('unsupported', 'Wispr declined to register FlowMesh as an app.');
    }
    clients.set(redirectUri, answer.client_id);
    return answer.client_id;
  }

  function checkRedirect(redirectUri) {
    let parsed;
    try {
      parsed = new URL(redirectUri);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port
        || parsed.pathname !== CALLBACK_PATH || parsed.search || parsed.hash) {
      throw new WisprAccountError('bad_request', "The sign-in return address must be this app's own loopback callback.");
    }
  }

  /** Warm discovery and registration in the background so Connect is instant. */
  function prefetch(redirectUri) {
    (async () => {
      try {
        checkRedirect(redirectUri);
        await register(await discover(), redirectUri);
      } catch {
        /* begin() reports a real error when the person actually clicks Connect */
      }
    })();
  }

  const b64url = (buffer) => buffer.toString('base64url');

  function status() {
    if (outcome) {
      const result = outcome;
      outcome = null;
      return result;
    }
    if (pending && clock() >= pending.expires_at) {
      pending = null;
      return { state: 'expired', detail: 'The sign-in link expired. Start again.' };
    }
    if (pending) {
      return {
        state: 'pending', detail: "Finish signing in on Wispr's page. This updates by itself.",
        authorization_url: pending.url, expires_in: Math.max(0, Math.floor(pending.expires_at - clock())),
      };
    }
    if (store.loadBlob(BLOB).refresh_token) return { state: 'connected', detail: CONNECTED };
    return { state: 'disconnected', detail: 'Not connected. Sign in to read your Scratchpad notes.' };
  }

  /** Prepare a sign-in. Returns the Wispr URL the person must open. */
  async function begin(redirectUri) {
    checkRedirect(redirectUri);
    const found = await discover();
    const id = await register(found, redirectUri);
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));
    const url = `${found.authorization_endpoint}?${new URLSearchParams({
      response_type: 'code', client_id: id, redirect_uri: redirectUri, scope: SCOPE, state,
      code_challenge: challenge, code_challenge_method: 'S256', resource,
    })}`;
    outcome = null;
    pending = { state, verifier, client_id: id, redirect_uri: redirectUri, url, expires_at: clock() + SIGN_IN_SECONDS };
    return status();
  }

  /** What the page polls while the person signs in: local state only, no network. */
  async function poll() {
    return status();
  }

  /** Handle the browser coming back to the loopback callback. Returns { ok, message }. */
  async function complete(code, state, error = '') {
    const current = pending;
    const given = Buffer.from(String(state || ''));
    const want = Buffer.from(current ? current.state : '');
    if (!current || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      // Not ours (or a replay): ignore it without disturbing a sign-in in progress.
      return { ok: false, message: 'This sign-in link is not valid any more. Start again from FlowMesh.' };
    }
    pending = null; // single use, whatever happens next
    if (clock() >= current.expires_at) {
      outcome = { state: 'expired', detail: 'The sign-in link expired. Start again.' };
      return { ok: false, message: 'The sign-in link expired. Start again from FlowMesh.' };
    }
    if (error) {
      outcome = { state: 'denied', detail: "Sign-in was declined on Wispr's page." };
      return { ok: false, message: 'Sign-in was declined.' };
    }
    if (typeof code !== 'string' || !code || code.length > 2048) {
      outcome = { state: 'denied', detail: 'Wispr did not return a sign-in code.' };
      return { ok: false, message: 'Wispr did not return a sign-in code.' };
    }
    try {
      const found = await discover();
      const { status: httpStatus, text } = await request('POST', found.token_endpoint, {
        form: {
          grant_type: 'authorization_code', client_id: current.client_id, code, redirect_uri: current.redirect_uri,
          code_verifier: current.verifier, resource,
        },
      });
      const answer = parseJson(text);
      if (httpStatus !== 200 || typeof answer.access_token !== 'string') {
        throw new WisprAccountError('denied', 'Wispr refused the sign-in.');
      }
      keepTokens(found, current.client_id, answer);
    } catch (error_) {
      if (!(error_ instanceof WisprAccountError)) throw error_;
      outcome = { state: 'denied', detail: error_.userMessage };
      return { ok: false, message: error_.userMessage };
    }
    return { ok: true, message: 'Signed in. You can close this tab and return to FlowMesh.' };
  }

  const CONNECTED = 'Signed in to Wispr Flow. Scratchpad notes are readable.';

  function keepTokens(found, id, answer) {
    let refresh = answer.refresh_token;
    if (typeof refresh !== 'string' || !refresh) refresh = store.loadBlob(BLOB).refresh_token; // not rotated
    if (typeof refresh !== 'string' || !refresh) {
      throw new WisprAccountError('unsupported', 'Wispr did not grant lasting access (no refresh token).');
    }
    store.saveBlob(BLOB, { issuer: found.issuer, client_id: id, refresh_token: refresh });
    const lifetime = typeof answer.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : 300;
    access = { token: answer.access_token, expiresAt: clock() + lifetime };
  }

  function disconnect() {
    pending = null;
    access = null;
    const blob = store.loadBlob(BLOB);
    if (blob.client_id) store.saveBlob(BLOB, { issuer: blob.issuer, client_id: blob.client_id });
    else store.clearBlob(BLOB);
    return {
      ...status(),
      detail: "Disconnected on this machine. Revoke the app in Wispr's settings to end the grant there.",
    };
  }

  async function accessToken() {
    if (access && access.expiresAt - REFRESH_SKEW_SECONDS > clock()) return access.token;
    const blob = store.loadBlob(BLOB);
    if (!blob.refresh_token) throw new WisprAccountError('expired', 'Not connected to Wispr Flow.');
    const found = await discover();
    const { status: code, text } = await request('POST', found.token_endpoint, {
      form: { grant_type: 'refresh_token', client_id: blob.client_id, refresh_token: blob.refresh_token, resource },
    });
    const answer = parseJson(text);
    if (code !== 200 || typeof answer.access_token !== 'string') {
      if (['invalid_grant', 'invalid_token'].includes(answer.error) || [400, 401].includes(code)) {
        store.saveBlob(BLOB, { issuer: blob.issuer, client_id: blob.client_id });
        access = null;
        throw new WisprAccountError('expired', 'Wispr sign-in expired. Connect again.');
      }
      throw new WisprAccountError('unavailable', 'Wispr could not refresh the sign-in right now.');
    }
    keepTokens(found, blob.client_id, answer);
    return access.token;
  }

  function mcpAnswer(contentType, text, requestId) {
    const messages = [];
    if (contentType.includes('text/event-stream')) {
      for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
        const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try {
          messages.push(JSON.parse(data));
        } catch {
          /* ignore a non-JSON event */
        }
      }
    } else {
      try {
        messages.push(JSON.parse(text));
      } catch {
        /* handled below */
      }
    }
    for (const message of messages) {
      if (message && message.id === requestId) {
        if (message.error) throw new WisprAccountError('bad_response', "Wispr's notes service reported an error.");
        if (message.result && typeof message.result === 'object') return message.result;
      }
    }
    throw new WisprAccountError('bad_response', "Wispr's notes service sent an unexpected answer.");
  }

  /** One short MCP session: initialize, run `calls`, return each result. */
  async function mcp(calls) {
    const token = await accessToken();
    const session = {};
    let counter = 0;
    async function send(method, params, expect = true) {
      const message = { jsonrpc: '2.0', method, params };
      let requestId = null;
      if (expect) {
        counter += 1;
        requestId = counter;
        message.id = requestId;
      }
      const headers = { Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': MCP_PROTOCOL, ...session };
      const { status: code, headers: responseHeaders, text } = await request('POST', resource, { payload: message, headers });
      if (code === 401) {
        access = null;
        throw new WisprAccountError('expired', 'Wispr sign-in expired. Connect again.');
      }
      if (code === 403) throw new WisprAccountError('denied', 'Wispr did not allow FlowMesh to read notes.');
      if (code === 429) throw new WisprAccountError('rate_limited', 'Wispr asked FlowMesh to slow down. Try again in a minute.');
      if (!expect) return {};
      if (code !== 200) throw new WisprAccountError('unavailable', "Wispr's notes service is not available right now.");
      const sid = responseHeaders.get('mcp-session-id');
      if (sid) session['Mcp-Session-Id'] = sid;
      return mcpAnswer(responseHeaders.get('content-type') || '', text, requestId);
    }
    await send('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'flowmesh', version } });
    await send('notifications/initialized', {}, false);
    const results = [];
    for (const [method, params] of calls) results.push(await send(method, params));
    return results;
  }

  function toolPayload(result) {
    if (result.isError) throw new WisprAccountError('bad_response', "Wispr's notes tool reported an error.");
    if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
    const text = (result.content || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function wantedArgs(tool, wanted) {
    const properties = tool.inputSchema && tool.inputSchema.properties;
    if (!properties || typeof properties !== 'object') return wanted;
    return Object.fromEntries(Object.entries(wanted).filter(([key]) => key in properties));
  }

  async function tools() {
    const [listed] = await mcp([['tools/list', {}]]);
    const found = {};
    for (const tool of listed.tools || []) {
      const name = tool && tool.name;
      if ((name === TOOL_SEARCH || name === TOOL_GET) && !FORBIDDEN_TOOL.test(name)) found[name] = tool;
    }
    if (!found[TOOL_SEARCH] || !found[TOOL_GET]) {
      throw new WisprAccountError('unsupported', "Wispr's server does not offer the Scratchpad note tools.");
    }
    return found;
  }

  async function listNotes(limit = 15) {
    const bounded = Math.max(1, Math.min(Number(limit) || 15, 25));
    const found = await tools();
    const [called] = await mcp([['tools/call', { name: TOOL_SEARCH, arguments: wantedArgs(found[TOOL_SEARCH], { query: '', limit: bounded }) }]]);
    const payload = toolPayload(called);
    const items = payload && !Array.isArray(payload) && typeof payload === 'object' ? payload.notes : payload;
    const notes = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      const id = ['note_id', 'id'].map((k) => (item[k] ? String(item[k]) : '')).find(Boolean) || '';
      if (!NOTE_ID.test(id)) continue;
      const title = cleanText(item.title || item.name || 'Untitled note', MAX_TITLE_CHARS).replace(/\s+/g, ' ') || 'Untitled note';
      const stamp = ['modified_at', 'updated_at', 'created_at'].map((k) => (item[k] ? String(item[k]) : '')).find(Boolean) || '';
      notes.push({ id, title, modified_at: cleanText(stamp, 40) });
    }
    return notes.slice(0, bounded);
  }

  async function getNote(noteId) {
    if (typeof noteId !== 'string' || !NOTE_ID.test(noteId)) {
      throw new WisprAccountError('bad_request', 'That is not a valid note id.');
    }
    await tools();
    const [called] = await mcp([['tools/call', { name: TOOL_GET, arguments: { note_id: noteId } }]]);
    const payload = toolPayload(called);
    let body = '';
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const holders = [payload, payload.note, payload.data].filter((h) => h && typeof h === 'object');
      for (const holder of holders) {
        body = ['content', 'text', 'markdown'].map((k) => holder[k]).find((v) => typeof v === 'string' && v.trim()) || '';
        if (body) break;
      }
    } else if (typeof payload === 'string') {
      body = payload;
    }
    const text = cleanText(body, MAX_NOTE_CHARS);
    if (!text) throw new WisprAccountError('empty', 'That note is empty.');
    return { id: noteId, text, truncated: body.trim().length > MAX_NOTE_CHARS };
  }

  return { status, begin, poll, complete, prefetch, disconnect, listNotes, getNote };
}

// How a connector failure maps onto HTTP. 401 is deliberately absent: it means "bad
// FlowMesh session token" everywhere else in this API.
const ACCOUNT_HTTP = {
  unavailable: 502, bad_response: 502, expired: 409, denied: 403,
  rate_limited: 429, unsupported: 422, empty: 422, bad_request: 400,
};

module.exports = { createAccount, WisprAccountError, ACCOUNT_HTTP, cleanText, RESOURCE, CALLBACK_PATH };
