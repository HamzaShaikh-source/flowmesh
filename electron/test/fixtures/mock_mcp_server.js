'use strict';
/* A stdio MCP server for tests, with deliberately awkward behaviour. Twin of
   tests/mock_mcp_server.py: oversized and control-character output, errors, slow
   calls, a server-initiated `sampling` request the client must refuse, and an
   environment probe that proves FlowMesh's secrets are not inherited. */

const readline = require('node:readline');

const TOOLS = [
  { name: 'echo', description: 'Return the text.', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200 } }, required: ['text'] } },
  { name: 'add_note', description: 'Save a note.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'], additionalProperties: false } },
  { name: 'delete_note', description: 'Delete a note.', annotations: { destructiveHint: true },
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'slow', description: 'Sleep.', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } } } },
  { name: 'big_output', description: 'A very long answer.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
  { name: 'env_probe', description: 'Names of secret-looking env vars.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
  { name: 'fail', description: 'Always errors.', inputSchema: { type: 'object' } },
  { name: 'ask_sampling', description: 'Ask the client to sample.', inputSchema: { type: 'object' } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError });
let waitingForSampling = null;

console.log('this log line is not JSON and must be ignored');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (waitingForSampling !== null && message.id === 9001) {
    const { id, name } = waitingForSampling;
    waitingForSampling = null;
    send({ jsonrpc: '2.0', id, result: text(`client said: ${JSON.stringify(message.error || message.result)}`) });
    void name;
    return;
  }
  const { method, id, params = {} } = message;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'mock-notes', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    let result;
    if (name === 'echo') result = text(args.text || '');
    else if (name === 'add_note') result = text(`Saved note '${args.title}'`);
    else if (name === 'delete_note') result = text(`Deleted note '${args.title}'`);
    else if (name === 'slow') {
      setTimeout(() => send({ jsonrpc: '2.0', id, result: text('done') }), Number(args.seconds || 5) * 1000);
      return;
    } else if (name === 'big_output') result = text(`x\u0000y\u0007z${'A'.repeat(100000)}`);
    else if (name === 'env_probe') {
      result = text(`leaked=${Object.keys(process.env).filter((k) => /SECRET|TOKEN|KEY/i.test(k)).sort().join(',')}`);
    } else if (name === 'fail') result = text('it broke', true);
    else if (name === 'ask_sampling') {
      waitingForSampling = { id, name };
      send({ jsonrpc: '2.0', id: 9001, method: 'sampling/createMessage', params: {} });
      return;
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
      return;
    }
    send({ jsonrpc: '2.0', id, result });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
