'use strict';
/**
 * A small, hardened MCP client: stdio and streamable-HTTP transports.
 *
 * Port of mcp_client.py; read that file's header for the full rationale. The rules are
 * the same and are enforced here, not promised:
 *   - no shell: a stdio server starts from an argument list (the one Windows exception,
 *     `.cmd`/`.bat` shims such as npx.cmd, goes through cmd.exe and therefore refuses
 *     any argument containing a shell metacharacter);
 *   - a minimal environment: FlowMesh's own secrets are never inherited by a server;
 *   - server-initiated requests (sampling, roots, elicitation) are refused, ping answered;
 *   - every request has a timeout, every line/body a size cap, and tool output is
 *     truncated and stripped of control characters;
 *   - a stdio child is terminated, then killed, when its session closes;
 *   - HTTP is HTTPS (loopback HTTP allowed), redirects are never followed.
 * Tool output is data from a third party. Nothing here interprets it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROTOCOL = '2025-06-18';
const MAX_LINE = 2_000_000;
const MAX_BODY = 4_000_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_TOOL_PAGES = 10;
const LIST_TIMEOUT = 20_000;
const CALL_TIMEOUT = 60_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const BATCH_UNSAFE = /[&|<>^%!"\r\n]/;

const SAFE_ENV = [
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'USERNAME', 'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'NVM_DIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'NODE_EXTRA_CA_CERTS',
];

class McpError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
    this.userMessage = message;
  }
}

function cleanOutput(value, limit = MAX_OUTPUT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').slice(0, limit);
}

function childEnvironment(extra = {}, base = process.env) {
  const env = {};
  for (const name of SAFE_ENV) if (name in base) env[name] = base[name];
  for (const [key, value] of Object.entries(extra)) env[String(key)] = String(value);
  return env;
}

/** Find the executable without a shell. On Windows this honours PATHEXT (npx.cmd). */
function resolveCommand(command, { platform = process.platform, env = process.env } = {}) {
  if (typeof command !== 'string' || !command || /[\0\r\n]/.test(command)) return null;
  const extensions = platform === 'win32' ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const isFile = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const candidates = /[\\/]/.test(command)
    ? [command]
    : String(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const base of candidates) {
    for (const extension of extensions) {
      if (isFile(base + extension)) return base + extension;
    }
  }
  return null;
}

function launchPlan(executable, args, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    if (BATCH_UNSAFE.test(executable) || args.some((a) => BATCH_UNSAFE.test(a))) {
      throw new McpError('bad_config', 'This server is started through cmd.exe, which cannot safely take arguments containing & | < > ^ % ! or quotes.');
    }
    const line = [executable, ...args].map((a) => `"${a}"`).join(' ');
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { file: executable, args, options: {} };
}

// ---------------------------------------------------------------- stdio

class StdioTransport {
  constructor(command, args = [], env = {}, cwd = null) {
    this.kind = 'stdio';
    this.command = command;
    this.args = [...args];
    this.env = env;
    this.cwd = cwd;
    this.child = null;
    this.pending = new Map();
    this.counter = 0;
    this.buffer = '';
    this.stderrTail = '';
    this.toolsDirty = false;
    this.closed = false;
    this.exited = false;
  }

  get alive() {
    return Boolean(this.child) && !this.exited && !this.closed;
  }

  start() {
    const executable = resolveCommand(this.command);
    if (!executable) throw new McpError('unavailable', `Could not find '${this.command}' on this computer.`);
    const plan = launchPlan(executable, this.args);
    try {
      this.child = spawn(plan.file, plan.args, {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment(this.env),
        cwd: this.cwd || undefined, windowsHide: true, ...plan.options,
      });
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError('unavailable', `Could not start the server (${error.name}).`);
    }
    this.child.on('error', () => this.fail(new McpError('unavailable', 'The server could not be started.')));
    this.child.on('exit', () => {
      this.exited = true;
      const tail = this.stderrTail.trim().split('\n').pop() || '';
      this.fail(new McpError('unavailable', `The server exited.${tail ? ` Last output: ${cleanOutput(tail, 160)}` : ''}`));
    });
    this.child.stdin.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length <= MAX_LINE && line.trim()) {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          /* servers sometimes log to stdout; ignore non-JSON lines */
        }
        if (message && typeof message === 'object') this.dispatch(message);
      }
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_LINE) this.buffer = '';
  }

  dispatch(message) {
    const { method, id } = message;
    if (method !== undefined && id !== undefined && id !== null) {
      // A request *from* the server. Answer ping; refuse everything else.
      if (method === 'ping') this.reply(id, { result: {} });
      else this.reply(id, { error: { code: -32601, message: 'FlowMesh does not support server-initiated requests.' } });
      return;
    }
    if (method === 'notifications/tools/list_changed') {
      this.toolsDirty = true;
      return;
    }
    if (method !== undefined) return;
    const slot = typeof id === 'number' ? this.pending.get(id) : null;
    if (slot) slot.resolve(message);
  }

  reply(id, body) {
    try {
      this.send({ jsonrpc: '2.0', id, ...body });
    } catch {
      /* the server is gone; nothing to answer */
    }
  }

  send(message) {
    if (!this.alive || !this.child.stdin.writable) throw new McpError('unavailable', 'The server is not running.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  fail(error) {
    for (const slot of [...this.pending.values()]) slot.reject(error);
    this.pending.clear();
  }

  request(method, params, timeout) {
    this.counter += 1;
    const id = this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError('timeout', `The server did not answer ${method} within ${Math.round(timeout / 1000)} seconds.`));
      }, timeout);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          this.pending.delete(id);
          try {
            resolve(resultOf(message));
          } catch (error) {
            reject(error);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.fail(new McpError('unavailable', 'The server was closed.'));
    if (!child || this.exited) return;
    await new Promise((resolve) => {
      const kill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3500);
      const term = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, 1500);
      child.once('exit', () => {
        clearTimeout(kill);
        clearTimeout(term);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        /* stdin already closed */
      }
    });
  }
}

// ---------------------------------------------------------------- HTTP

function checkHttpUrl(url, allowLoopbackHttp = true) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpError('bad_config', 'An HTTP MCP server must use https:// (http:// only for localhost) and no embedded credentials.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  const ok = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback && allowLoopbackHttp);
  if (!ok || !parsed.hostname || parsed.username || parsed.password) {
    throw new McpError('bad_config', 'An HTTP MCP server must use https:// (http:// only for localhost) and no embedded credentials.');
  }
}

class HttpTransport {
  constructor(url, headers = {}, { allowLoopbackHttp = true, fetchImpl = globalThis.fetch, version = '0' } = {}) {
    checkHttpUrl(url, allowLoopbackHttp);
    this.kind = 'http';
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.version = version;
    this.session = null;
    this.counter = 0;
    this.toolsDirty = false;
    this.closed = false;
    this.protocol = PROTOCOL;
  }

  get alive() {
    return !this.closed;
  }

  start() {}

  async close() {
    this.closed = true;
  }

  async post(message, timeout) {
    const headers = {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      'MCP-Protocol-Version': this.protocol, 'User-Agent': `FlowMesh/${this.version}`, ...this.headers,
    };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', signal: AbortSignal.timeout(timeout),
      });
      return { status: response.status, headers: response.headers, text: (await response.text()).slice(0, MAX_BODY) };
    } catch {
      throw new McpError('unavailable', 'Could not reach the MCP server.');
    }
  }

  async request(method, params, timeout) {
    this.counter += 1;
    const id = this.counter;
    const { status, headers, text } = await this.post({ jsonrpc: '2.0', id, method, params }, timeout);
    if (status === 401) throw new McpError('auth', 'The server rejected the credentials (401). Check the token for this server.');
    if (status === 403) throw new McpError('auth', 'The server refused access (403).');
    if (status === 429) throw new McpError('rate_limited', 'The server asked FlowMesh to slow down.');
    if (status !== 200) throw new McpError('unavailable', `The server answered HTTP ${status}.`);
    const sid = headers.get('mcp-session-id');
    if (sid) this.session = sid;
    return resultOf(findAnswer(headers.get('content-type') || '', text, id));
  }

  async notify(method, params) {
    const { status } = await this.post({ jsonrpc: '2.0', method, params }, LIST_TIMEOUT);
    if (![200, 202].includes(status)) throw new McpError('unavailable', `The server answered HTTP ${status}.`);
  }
}

function findAnswer(contentType, text, requestId) {
  const messages = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* skip */
      }
    }
  } else {
    try {
      messages.push(JSON.parse(text));
    } catch {
      /* handled below */
    }
  }
  const found = messages.find((m) => m && typeof m === 'object' && m.id === requestId);
  if (!found) throw new McpError('bad_response', 'The server sent an answer FlowMesh could not read.');
  return found;
}

function resultOf(message) {
  if (message.error) {
    const error = typeof message.error === 'object' ? message.error : {};
    throw new McpError('server_error', cleanOutput(String(error.message || 'The server reported an error.'), 300));
  }
  if (!message.result || typeof message.result !== 'object') throw new McpError('bad_response', 'The server sent an unexpected answer.');
  return message.result;
}

// ---------------------------------------------------------------- session

function normalizeResult(result) {
  const parts = [];
  const texts = [];
  for (const part of Array.isArray(result.content) ? result.content : []) {
    if (!part || typeof part !== 'object') continue;
    const kind = String(part.type || 'unknown');
    parts.push(kind);
    if (kind === 'text') texts.push(cleanOutput(part.text || ''));
    else if (kind === 'image' || kind === 'audio') {
      const size = Math.floor(((part.data || '').length * 3) / 4);
      texts.push(`[${kind} ${part.mimeType || ''}, about ${size} bytes, not displayed]`);
    } else if (kind === 'resource_link') texts.push(`[resource link: ${cleanOutput(String(part.uri || ''), 300)}]`);
    else if (kind === 'resource') {
      const res = part.resource && typeof part.resource === 'object' ? part.resource : {};
      texts.push(cleanOutput(res.text || `[embedded resource ${cleanOutput(String(res.uri || ''), 200)}]`));
    }
  }
  let text = texts.filter(Boolean).join('\n');
  if (!text && result.structuredContent !== undefined && result.structuredContent !== null) {
    try {
      text = cleanOutput(JSON.stringify(result.structuredContent, null, 2));
    } catch {
      text = '';
    }
  }
  return { is_error: Boolean(result.isError), text: text.slice(0, MAX_OUTPUT_CHARS), parts, truncated: text.length >= MAX_OUTPUT_CHARS };
}

class McpSession {
  constructor(transport, label = '', version = '0') {
    this.transport = transport;
    this.label = label;
    this.version = version;
    this.serverInfo = {};
    this.toolsCache = null;
  }

  async open() {
    this.transport.start();
    try {
      const result = await this.transport.request('initialize', {
        protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'flowmesh', version: this.version },
      }, LIST_TIMEOUT);
      if ('protocol' in this.transport && typeof result.protocolVersion === 'string') this.transport.protocol = result.protocolVersion;
      const info = result.serverInfo && typeof result.serverInfo === 'object' ? result.serverInfo : {};
      for (const key of ['name', 'version', 'title']) if (key in info) this.serverInfo[key] = cleanOutput(String(info[key]), 80);
      await this.transport.notify('notifications/initialized', {});
    } catch (error) {
      await this.transport.close();
      throw error;
    }
    return this;
  }

  close() {
    return this.transport.close();
  }

  get alive() {
    return this.transport.alive;
  }

  async listTools(force = false, ttl = 300_000) {
    if (!force && !this.transport.toolsDirty && this.toolsCache && Date.now() - this.toolsCache.at < ttl) {
      return this.toolsCache.tools;
    }
    const tools = [];
    let cursor = null;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT);
      for (const tool of Array.isArray(result.tools) ? result.tools : []) {
        if (tool && typeof tool === 'object' && typeof tool.name === 'string') tools.push(tool);
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    this.transport.toolsDirty = false;
    this.toolsCache = { at: Date.now(), tools };
    return tools;
  }

  async callTool(name, args, timeout = CALL_TIMEOUT) {
    return normalizeResult(await this.transport.request('tools/call', { name, arguments: args }, timeout));
  }
}

module.exports = {
  PROTOCOL, MAX_OUTPUT_CHARS, CALL_TIMEOUT, LIST_TIMEOUT, SAFE_ENV, BATCH_UNSAFE,
  McpError, StdioTransport, HttpTransport, McpSession,
  cleanOutput, childEnvironment, resolveCommand, launchPlan, normalizeResult, checkHttpUrl,
};
