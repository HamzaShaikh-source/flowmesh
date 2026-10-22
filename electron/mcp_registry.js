'use strict';
/**
 * Which MCP servers FlowMesh may use, what their tools are, and how risky each call is.
 *
 * Port of mcp_registry.py; read that file's header for the policy. In short: risk is
 * derived by FlowMesh (a destructive name or hint is `danger`; `read` only on a
 * read-only claim with a non-destructive name; everything else `write`), arguments are
 * checked against the tool's own JSON schema before a plan exists, and credentials are
 * stored in the credential blob and only ever echoed back masked.
 */

const {
  McpError, StdioTransport, HttpTransport, McpSession, cleanOutput, checkHttpUrl, CALL_TIMEOUT,
} = require('./mcp_client.js');

const BLOB = 'mcp_servers';
const MASK = '********';
const MAX_SERVERS = 20;
const MAX_ARGS_BYTES = 32_000;
const MAX_TOOLS_PER_SERVER = 200;
const IDLE_MS = 15 * 60 * 1000;
const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const DANGER_NAME = /(^|[_\-. ])(delete|remove|drop|destroy|purge|wipe|erase|kill|terminate|revoke|reset|force|exec|execute|shell|run_command|rm)([_\-. ]|$)/i;
const READ = 'read';
const WRITE = 'write';
const DANGER = 'danger';

function classify(tool) {
  const annotations = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const name = String(tool.name || '');
  if (annotations.destructiveHint === true || DANGER_NAME.test(name)) return DANGER;
  if (annotations.readOnlyHint === true) return READ;
  return WRITE;
}

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Errors for `value` against the commonly used subset of JSON Schema. */
function validateArguments(schema, value, path = 'arguments', depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return [];
  for (const key of ['anyOf', 'oneOf']) {
    const options = schema[key];
    if (Array.isArray(options) && options.length) {
      if (!options.some((option) => validateArguments(option, value, path, depth + 1).length === 0)) {
        return [`${path} matches none of the allowed shapes`];
      }
    }
  }
  const errors = [];
  const expected = schema.type;
  const kinds = Array.isArray(expected) ? expected : typeof expected === 'string' ? [expected] : [];
  if (kinds.length && !kinds.some((kind) => (TYPE_CHECKS[kind] || (() => true))(value))) {
    return [`${path} must be ${kinds.join(' or ')}`];
  }
  if ('const' in schema && !deepEqual(value, schema.const)) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum).slice(0, 120)}`);
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    value.slice(0, 100).forEach((item, index) => errors.push(...validateArguments(schema.items, item, `${path}[${index}]`, depth + 1)));
  }
  if (TYPE_CHECKS.object(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!(name in value)) errors.push(`${path}.${name} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) if (!(name in properties)) errors.push(`${path}.${name} is not an accepted field`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (name in properties) errors.push(...validateArguments(properties[name], item, `${path}.${name}`, depth + 1));
    }
  }
  return errors.slice(0, 12);
}

function secretMap(raw, current, namePattern, noun, limit) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > limit) {
    throw new Error(`${noun}s must be an object with at most ${limit} entries`);
  }
  const kept = current && typeof current === 'object' ? current : {};
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!namePattern.test(name)) throw new Error(`${noun} name '${name.slice(0, 30)}' is invalid`);
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`${noun} ${name} has an invalid value`);
    out[name] = value === MASK ? kept[name] || '' : value;
  }
  return out;
}

/** A clean server record, or throws Error with a sentence for the person. */
function validateServer(raw, existing = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Server must be an object');
  const id = raw.id;
  if (typeof id !== 'string' || !SERVER_ID.test(id)) throw new Error("Server id must be lowercase letters, digits, '-' or '_' (max 32)");
  const label = typeof raw.label === 'string' ? raw.label : id;
  const { transport } = raw;
  if (!['stdio', 'http'].includes(transport)) throw new Error("Transport must be 'stdio' or 'http'");
  const clean = {
    id, label: label.trim().slice(0, 60) || id, transport,
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    auto_read: raw.auto_read === true,
  };
  if (transport === 'stdio') {
    const { command } = raw;
    if (typeof command !== 'string' || !command.trim() || command.length > 256 || /[\r\n\0]/.test(command)) {
      throw new Error('A stdio server needs a command (a program name or path, no arguments)');
    }
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.length > 32 || args.some((a) => typeof a !== 'string' || a.length > 1024 || a.includes('\0'))) {
      throw new Error('Arguments must be up to 32 short strings');
    }
    clean.command = command.trim();
    clean.args = [...args];
    clean.env = secretMap(raw.env, existing.env, ENV_NAME, 'Environment variable', 20);
    if (raw.cwd !== undefined && raw.cwd !== null && raw.cwd !== '') {
      if (typeof raw.cwd !== 'string' || raw.cwd.length > 512 || raw.cwd.includes('\0')) throw new Error('Working directory is invalid');
      clean.cwd = raw.cwd;
    }
  } else {
    if (typeof raw.url !== 'string') throw new Error('An HTTP server needs a url');
    try {
      checkHttpUrl(raw.url);
    } catch (error) {
      throw new Error(error.userMessage || error.message);
    }
    clean.url = raw.url.trim();
    clean.headers = secretMap(raw.headers, existing.headers, HEADER_NAME, 'Header', 10);
  }
  return clean;
}

function publicServer(server) {
  const out = {};
  for (const [key, value] of Object.entries(server)) if (key !== 'env' && key !== 'headers') out[key] = value;
  for (const key of ['env', 'headers']) {
    if (server[key]) out[key] = Object.fromEntries(Object.keys(server[key]).map((name) => [name, MASK]));
  }
  return out;
}

function publicTool(serverId, tool) {
  const schema = tool.inputSchema;
  let tooBig;
  try {
    tooBig = JSON.stringify(schema).length > 20_000;
  } catch {
    tooBig = true;
  }
  return {
    server: serverId,
    name: tool.name,
    title: cleanOutput(String(tool.title || tool.name), 100),
    description: cleanOutput(String(tool.description || ''), 600).split(/\s+/).filter(Boolean).join(' '),
    risk: classify(tool),
    input_schema: tooBig || !schema || typeof schema !== 'object' || Array.isArray(schema) ? {} : schema,
  };
}

function summarizeArguments(args) {
  const entries = Object.entries(args);
  if (!entries.length) return 'no arguments';
  const parts = entries.slice(0, 4).map(([key, value]) => {
    const text = (typeof value === 'string' ? value : JSON.stringify(value)).split(/\s+/).filter(Boolean).join(' ');
    return `${key}: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`;
  });
  return parts.join('; ') + (entries.length > 4 ? ` (+${entries.length - 4} more)` : '');
}

function createManager({ store, version = '0', fetchImpl = globalThis.fetch } = {}) {
  const sessions = new Map();
  const used = new Map();
  const connecting = new Map();

  const servers = () => {
    const list = store.loadBlob(BLOB).servers;
    return Array.isArray(list) ? list.filter((s) => s && typeof s === 'object') : [];
  };
  const get = (id) => servers().find((s) => s.id === id) || null;

  function listServers() {
    return servers().map((s) => ({ ...publicServer(s), connected: sessions.has(s.id) && sessions.get(s.id).alive }));
  }

  async function closeOne(id) {
    const session = sessions.get(id);
    sessions.delete(id);
    used.delete(id);
    if (session) await session.close();
  }

  async function upsert(raw) {
    const list = servers();
    const current = raw && typeof raw === 'object' ? get(raw.id) : null;
    const clean = validateServer(raw, current || {});
    if (!current && list.length >= MAX_SERVERS) throw new Error(`At most ${MAX_SERVERS} servers`);
    await closeOne(clean.id);
    store.saveBlob(BLOB, { servers: [...list.filter((s) => s.id !== clean.id), clean] });
    return publicServer(clean);
  }

  async function remove(id) {
    const list = servers();
    const kept = list.filter((s) => s.id !== id);
    await closeOne(id);
    if (kept.length === list.length) return false;
    store.saveBlob(BLOB, { servers: kept });
    return true;
  }

  async function closeAll() {
    await Promise.all([...sessions.keys()].map(closeOne));
  }

  async function reap() {
    const now = Date.now();
    for (const [id, last] of [...used]) {
      const session = sessions.get(id);
      if (now - last > IDLE_MS || !session || !session.alive) await closeOne(id);
    }
  }

  async function session(id) {
    await reap();
    const server = get(id);
    if (!server) throw new McpError('unknown_server', 'That server is not registered.');
    if (!server.enabled) throw new McpError('disabled', 'That server is switched off.');
    const existing = sessions.get(id);
    if (existing && existing.alive) {
      used.set(id, Date.now());
      return existing;
    }
    if (connecting.has(id)) return connecting.get(id);
    const attempt = (async () => {
      const transport = server.transport === 'stdio'
        ? new StdioTransport(server.command, server.args || [], server.env, server.cwd)
        : new HttpTransport(server.url, server.headers, { fetchImpl, version });
      const opened = await new McpSession(transport, server.label, version).open();
      sessions.set(id, opened);
      used.set(id, Date.now());
      return opened;
    })();
    connecting.set(id, attempt);
    try {
      return await attempt;
    } finally {
      connecting.delete(id);
    }
  }

  async function tools(id, force = false) {
    const live = await session(id);
    return (await live.listTools(force)).slice(0, MAX_TOOLS_PER_SERVER).map((tool) => publicTool(id, tool));
  }

  async function catalog() {
    const out = { tools: [], errors: {} };
    for (const server of servers()) {
      if (!server.enabled) continue;
      try {
        out.tools.push(...(await tools(server.id)));
      } catch (error) {
        if (!(error instanceof McpError)) throw error;
        out.errors[server.id] = error.userMessage;
      }
    }
    return out;
  }

  async function test(id) {
    await closeOne(id);
    const live = await session(id);
    const listed = await live.listTools(true);
    return { ok: true, server_info: live.serverInfo, tools: listed.length };
  }

  async function call(id, tool, args, timeout = CALL_TIMEOUT) {
    return (await session(id)).callTool(tool, args, timeout);
  }

  /** Validate proposed calls (from a person or a model) into reviewable actions. */
  async function planActions(rawCalls) {
    if (!Array.isArray(rawCalls) || rawCalls.length < 1 || rawCalls.length > 8) throw new Error('A tool plan needs between 1 and 8 calls');
    const actions = [];
    const listed = {};
    for (const [offset, entry] of rawCalls.entries()) {
      const index = offset + 1;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((k) => !['server', 'tool', 'arguments'].includes(k))) {
        throw new Error(`Call ${index} must have only server, tool and arguments`);
      }
      const { server: serverId, tool: name } = entry;
      const args = entry.arguments === undefined ? {} : entry.arguments;
      if (typeof serverId !== 'string' || typeof name !== 'string' || !TYPE_CHECKS.object(args)) throw new Error(`Call ${index} is malformed`);
      const server = get(serverId);
      if (!server || !server.enabled) throw new Error(`Call ${index}: server '${serverId.slice(0, 32)}' is not available`);
      if (!listed[serverId]) {
        try {
          listed[serverId] = Object.fromEntries((await tools(serverId)).map((t) => [t.name, t]));
        } catch (error) {
          if (error instanceof McpError) throw new Error(`Call ${index}: ${error.userMessage}`);
          throw error;
        }
      }
      const tool = listed[serverId][name];
      if (!tool) throw new Error(`Call ${index}: server '${serverId}' has no tool '${name.slice(0, 60)}'`);
      if (JSON.stringify(args).length > MAX_ARGS_BYTES) throw new Error(`Call ${index}: arguments are too large`);
      const errors = validateArguments(tool.input_schema, args);
      if (errors.length) throw new Error(`Call ${index} (${name}): ${errors.slice(0, 4).join('; ')}`);
      actions.push({
        kind: 'mcp_call', target: `${serverId}/${name}`, label: tool.title, detail: summarizeArguments(args), surface: 'tools',
        server: serverId, server_label: server.label, tool: name, risk: tool.risk, arguments: args,
        auto_ok: tool.risk === READ && Boolean(server.auto_read),
      });
    }
    return actions;
  }

  return { listServers, get, upsert, remove, closeAll, tools, catalog, test, call, planActions, servers };
}

module.exports = {
  READ, WRITE, DANGER, MASK, MAX_SERVERS, classify, validateArguments, validateServer, publicServer, publicTool,
  summarizeArguments, createManager, DANGER_NAME,
};
