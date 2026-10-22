"""A loopback model endpoint speaking Anthropic Messages and OpenAI chat shapes."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class MockLlm:
    def __init__(self, reply: str = '{"none": "nothing fits"}', status: int = 200):
        self.reply, self.status = reply, status
        self.requests: list[dict] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                owner.requests.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(raw or b"{}")})
                if owner.status != 200:
                    self.send_response(owner.status)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"{}")
                    return
                if self.path.endswith("/v1/messages"):
                    payload = {"content": [{"type": "text", "text": owner.reply}]}
                else:
                    payload = {"choices": [{"message": {"content": owner.reply}}]}
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "MockLlm":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
