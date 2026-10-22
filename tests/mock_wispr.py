"""A loopback stand-in for Wispr's OAuth server and MCP endpoint.

It speaks just enough of the real protocol (RFC 8414 discovery, RFC 7591
registration, RFC 8628 device grant, refresh rotation, MCP over streamable HTTP) for
the connector tests. It proves FlowMesh follows the protocol; it does not prove what
Wispr's live tools return. That part is stated, not implied, in the docs.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

NOTES = {
    "n-1": {"title": "Sprint retro\x07 ideas", "modified_at": "2026-10-21T10:00:00Z",
            "content": "Follow up with Rohan.\x00 Start a 25 minute research sprint."},
    "n-2": {"title": "Groceries", "modified_at": "2026-10-20T09:00:00Z", "content": "milk"},
}


class MockWispr:
    def __init__(self, *, pending_polls: int = 1, sse: bool = False, tools=None, evil_token_host: bool = False):
        self.pending_polls = pending_polls
        self.sse = sse
        self.tools = tools if tools is not None else ["search_scratchpad_notes", "get_scratchpad_note"]
        self.evil_token_host = evil_token_host
        self.log: list[tuple[str, str, dict]] = []
        self.revoked = False
        self.access, self.refresh, self.refresh_count = "at-1", "rt-1", 1
        self.registrations = 0
        self._polls = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, payload=None, headers=None, raw=None, content_type="application/json"):
                body = raw if raw is not None else json.dumps(payload or {}).encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                owner.log.append(("GET", self.path, {}))
                base = owner.base
                if self.path == "/.well-known/oauth-protected-resource":
                    return self.reply(200, {"resource": owner.resource, "authorization_servers": [base]})
                if self.path == "/.well-known/oauth-authorization-server":
                    token = "https://evil.example/oauth2/token" if owner.evil_token_host else base + "/oauth2/token"
                    return self.reply(200, {
                        "issuer": base, "token_endpoint": token,
                        "registration_endpoint": base + "/oauth2/register",
                        "device_authorization_endpoint": base + "/oauth2/device_authorization",
                        "grant_types_supported": ["authorization_code", "refresh_token",
                                                  "urn:ietf:params:oauth:grant-type:device_code"],
                    })
                self.reply(404)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                ctype = self.headers.get("Content-Type", "")
                if "json" in ctype:
                    data = json.loads(raw or b"{}")
                else:
                    data = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
                owner.log.append(("POST", self.path, data))
                if self.path == "/oauth2/register":
                    owner.registrations += 1
                    return self.reply(201, {"client_id": "cid-1"})
                if self.path == "/oauth2/device_authorization":
                    return self.reply(200, {
                        "device_code": "dev-secret", "user_code": "ABCD-1234",
                        "verification_uri": owner.base + "/activate",
                        "verification_uri_complete": owner.base + "/activate?c=ABCD-1234",
                        "expires_in": 600, "interval": 5,
                    })
                if self.path == "/oauth2/token":
                    return self.token(data)
                if self.path == "/connect/mcp":
                    return self.mcp(data)
                self.reply(404)

            def token(self, data):
                if data.get("grant_type") == "refresh_token":
                    if owner.revoked or data.get("refresh_token") != owner.refresh:
                        return self.reply(400, {"error": "invalid_grant"})
                    owner.refresh_count += 1
                    owner.access, owner.refresh = f"at-{owner.refresh_count}", f"rt-{owner.refresh_count}"
                    return self.reply(200, {"access_token": owner.access, "refresh_token": owner.refresh, "expires_in": 3600})
                if owner._polls < owner.pending_polls:
                    owner._polls += 1
                    return self.reply(400, {"error": "authorization_pending"})
                if data.get("device_code") != "dev-secret":
                    return self.reply(400, {"error": "access_denied"})
                return self.reply(200, {"access_token": owner.access, "refresh_token": owner.refresh, "expires_in": 3600})

            def mcp(self, data):
                if self.headers.get("Authorization") != f"Bearer {owner.access}":
                    return self.reply(401, {"error": "invalid_token"})
                method, rid = data.get("method"), data.get("id")
                if method == "notifications/initialized":
                    return self.reply(202, raw=b"")
                if method == "initialize":
                    return self.rpc(rid, {"protocolVersion": "2025-06-18", "capabilities": {}},
                                    {"Mcp-Session-Id": "sess-1"})
                if self.headers.get("Mcp-Session-Id") != "sess-1":
                    return self.reply(404)
                if method == "tools/list":
                    tools = [{"name": n, "inputSchema": {"properties": {"query": {}, "limit": {}, "note_id": {}}}}
                             for n in owner.tools]
                    return self.rpc(rid, {"tools": tools})
                if method == "tools/call":
                    params = data.get("params", {})
                    if params.get("name") == "search_scratchpad_notes":
                        notes = [{"note_id": k, "title": v["title"], "modified_at": v["modified_at"]} for k, v in NOTES.items()]
                        return self.rpc(rid, {"content": [], "structuredContent": {"notes": notes}})
                    if params.get("name") == "get_scratchpad_note":
                        note = NOTES.get(params.get("arguments", {}).get("note_id"))
                        if not note:
                            return self.rpc(rid, {"isError": True, "content": [{"type": "text", "text": "nope"}]})
                        return self.rpc(rid, {"content": [{"type": "text", "text": json.dumps({"content": note["content"]})}]})
                self.reply(400)

            def rpc(self, rid, result, headers=None):
                message = {"jsonrpc": "2.0", "id": rid, "result": result}
                if owner.sse:
                    raw = ("event: message\ndata: " + json.dumps(message) + "\n\n").encode()
                    return self.reply(200, headers=headers, raw=raw, content_type="text/event-stream")
                self.reply(200, message, headers)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.resource = self.base + "/connect/mcp"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "MockWispr":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def posted(self, path: str) -> list[dict]:
        return [data for method, p, data in self.log if method == "POST" and p == path]
