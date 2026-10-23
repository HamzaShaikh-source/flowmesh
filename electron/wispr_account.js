'use strict';
/**
 * Connect a Wispr Flow account through Wispr's own, supported interface.
 *
 * Port of wispr_account.py; read that file's header for the full rationale. The
 * rules are the same and are enforced here, not promised:
 *   - device flow only (the user types a code on Wispr's page; no password, no
 *     redirect listener), public client with no secret;
 *   - only the Scratchpad note tools are ever called, and anything whose name
 *     mentions dictation, history or transcripts is refused by name;
 *   - Wispr's text is untrusted: stripped, capped, and only ever placed in the
 *     command box for the user to read, never planned or run without approval;
 *   - tokens never leave this module; callers get state and note text;
 *   - HTTPS only (loopback HTTP solely for tests), no redirects followed, and every
 *     endpoint named by discovery must sit on the issuer's own host.
 */

const RESOURCE = 'https://api.wisprflow.ai/connect/mcp';
const SCOPE = 'openid offline_access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MCP_PROTOCOL = '2025-06-18';
const BLOB = 'wispr_account';

const TOOL_SEARCH = 'search_scratchpad_notes';
const TOOL_GET = 'get_scratchpad_note';
const FORBIDDEN_TOOL = /dictation|history|transcript/i;

const MAX_BODY = 1_000_000;
const REFRESH_SKEW_SECONDS = 120;
const SLOW_DOWN_STEP_SECONDS = 5;
const DEFAULT_POLL_SECONDS = 5;
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
      const response = await fetchImpl(url, { method, headers: out, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
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
    for (const key of ['token_endpoint', 'registration_endpoint', 'device_authorization_endpoint']) {
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
    if (Array.isArray(grants) && !grants.includes(DEVICE_GRANT)) {
      throw new WisprAccountError('unsupported', "Wispr's sign-in service does not offer device sign-in.");
    }
    meta = { issuer, ...endpoints };
    return meta;
  }

  async function clientId(found) {
    const blob = store.loadBlob(BLOB);
    if (blob.issuer === found.issuer && typeof blob.client_id === 'string' && blob.client_id) return blob.client_id;
    const { status, text } = await request('POST', found.registration_endpoint, {
      payload: {
        client_name: 'FlowMesh',
        redirect_uris: ['http://127.0.0.1/flowmesh-unused'],
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      },
    });
    const answer = parseJson(text);
    if (![200, 201].includes(status) || typeof answer.client_id !== 'string' || !answer.client_id) {
      throw new WisprAccountError('unsupported', 'Wispr declined to register FlowMesh as an app.');
    }
    store.saveBlob(BLOB, { issuer: found.issuer, client_id: answer.client_id });
    return answer.client_id;
  }

  const publicPending = (p) => ({
    user_code: p.user_code,
    verification_uri: p.verification_uri,
    verification_uri_complete: p.verification_uri_complete,
    expires_in: p.expires_in,
    interval: p.interval,
  });
  const WAITING = "Waiting for you to approve FlowMesh on Wispr's page.";
  const CONNECTED = 'Signed in to Wispr Flow. Scratchpad notes are readable.';

  function status() {
    if (pending && clock() >= pending.expires_at) pending = null;
    if (pending) return { state: 'pending', detail: WAITING, ...publicPending(pending) };
    if (store.loadBlob(BLOB).refresh_token) return { state: 'connected', detail: CONNECTED };
    return { state: 'disconnected', detail: 'Not connected. Sign in to read your Scratchpad notes.' };
  }

  async function begin() {
    const found = await discover();
    const id = await clientId(found);
    const { status: code, text } = await request('POST', found.device_authorization_endpoint, {
      form: { client_id: id, scope: SCOPE, resource },
    });
    const answer = parseJson(text);
    if (code !== 200) throw new WisprAccountError('denied', 'Wispr refused to start sign-in.');
    const { device_code: deviceCode, user_code: userCode, verification_uri: uri } = answer;
    if (![deviceCode, userCode, uri].every((v) => typeof v === 'string' && v)) {
      throw new WisprAccountError('bad_response', "Wispr's sign-in answer was incomplete.");
    }
    const complete = typeof answer.verification_uri_complete === 'string' ? answer.verification_uri_complete : '';
    [uri, complete].filter(Boolean).forEach(checkUrl);
    const expiresIn = Number(answer.expires_in) || 600;
    const interval = Math.max(1, Number(answer.interval) || DEFAULT_POLL_SECONDS);
    const now = clock();
    pending = {
      device_code: deviceCode,
      client_id: id,
      user_code: cleanText(userCode, 32),
      verification_uri: uri,
      verification_uri_complete: complete,
      expires_in: expiresIn,
      interval,
      expires_at: now + expiresIn,
      next_poll: now + interval,
    };
    return { state: 'pending', ...publicPending(pending) };
  }

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

  async function poll() {
    if (!pending) return status();
    const now = clock();
    if (now >= pending.expires_at) {
      pending = null;
      return { state: 'expired', detail: 'The sign-in code expired. Start again.' };
    }
    if (now < pending.next_poll) return { state: 'pending', detail: WAITING, ...publicPending(pending) };
    const found = await discover();
    const { status: code, text } = await request('POST', found.token_endpoint, {
      form: { grant_type: DEVICE_GRANT, client_id: pending.client_id, device_code: pending.device_code, resource },
    });
    const answer = parseJson(text);
    if (code === 200 && typeof answer.access_token === 'string') {
      const id = pending.client_id;
      pending = null;
      keepTokens(found, id, answer);
      return { state: 'connected', detail: CONNECTED };
    }
    if (answer.error === 'authorization_pending') {
      pending.next_poll = now + pending.interval;
    } else if (answer.error === 'slow_down') {
      pending.interval += SLOW_DOWN_STEP_SECONDS;
      pending.next_poll = now + pending.interval;
    } else if (answer.error === 'access_denied') {
      pending = null;
      return { state: 'denied', detail: "Sign-in was declined on Wispr's page." };
    } else if (answer.error === 'expired_token') {
      pending = null;
      return { state: 'expired', detail: 'The sign-in code expired. Start again.' };
    } else {
      pending = null;
      throw new WisprAccountError('denied', 'Wispr refused the sign-in.');
    }
    return { state: 'pending', detail: WAITING, ...publicPending(pending) };
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

  return { status, begin, poll, disconnect, listNotes, getNote };
}

// How a connector failure maps onto HTTP. 401 is deliberately absent: it means "bad
// FlowMesh session token" everywhere else in this API.
const ACCOUNT_HTTP = {
  unavailable: 502, bad_response: 502, expired: 409, denied: 403,
  rate_limited: 429, unsupported: 422, empty: 422, bad_request: 400,
};

module.exports = { createAccount, WisprAccountError, ACCOUNT_HTTP, cleanText, RESOURCE };
