"""A stdio MCP server for tests, with deliberately awkward behaviour.

Run as `python tests/mock_mcp_server.py`. It speaks newline-delimited JSON-RPC and
offers tools that exercise what FlowMesh must survive: oversized and control-character
output, errors, slow calls, a server-initiated `sampling` request the client must
refuse, and an environment probe that proves FlowMesh's secrets are not inherited.
"""

import json
import os
import re
import sys
import time

TOOLS = [
    {"name": "echo", "description": "Return the text.", "annotations": {"readOnlyHint": True},
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 200}}, "required": ["text"]}},
    {"name": "add_note", "description": "Save a note.",
     "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "body": {"type": "string"}},
                     "required": ["title"], "additionalProperties": False}},
    {"name": "delete_note", "description": "Delete a note.", "annotations": {"destructiveHint": True},
     "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}},
    {"name": "slow", "description": "Sleep.", "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}}}},
    {"name": "big_output", "description": "A very long answer.", "annotations": {"readOnlyHint": True}, "inputSchema": {"type": "object"}},
    {"name": "env_probe", "description": "Names of secret-looking env vars.", "annotations": {"readOnlyHint": True}, "inputSchema": {"type": "object"}},
    {"name": "fail", "description": "Always errors.", "inputSchema": {"type": "object"}},
    {"name": "ask_sampling", "description": "Ask the client to sample.", "inputSchema": {"type": "object"}},
]


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def text_result(text, error=False):
    return {"content": [{"type": "text", "text": text}], "isError": error}


def main():
    print("this log line is not JSON and must be ignored", flush=True)
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        method, mid, params = message.get("method"), message.get("id"), message.get("params") or {}
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": "2025-06-18", "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": "mock-notes", "version": "1.0.0"}}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            name, args = params.get("name"), params.get("arguments") or {}
            if name == "echo":
                result = text_result(args.get("text", ""))
            elif name == "add_note":
                result = text_result(f"Saved note {args.get('title')!r}")
            elif name == "delete_note":
                result = text_result(f"Deleted note {args.get('title')!r}")
            elif name == "slow":
                time.sleep(float(args.get("seconds", 5)))
                result = text_result("done")
            elif name == "big_output":
                result = text_result("x\x00y\x07z" + "A" * 100_000)
            elif name == "env_probe":
                leaked = sorted(k for k in os.environ if re.search(r"SECRET|TOKEN|KEY", k, re.I))
                result = text_result("leaked=" + ",".join(leaked))
            elif name == "fail":
                result = text_result("it broke", error=True)
            elif name == "ask_sampling":
                send({"jsonrpc": "2.0", "id": 9001, "method": "sampling/createMessage", "params": {}})
                answer = json.loads(sys.stdin.readline())
                result = text_result("client said: " + json.dumps(answer.get("error", answer.get("result"))))
            else:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown tool"}})
                continue
            send({"jsonrpc": "2.0", "id": mid, "result": result})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
