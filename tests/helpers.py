"""Shared harness: a real server on a real port, with an isolated home dir."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import bridge


class BridgeTestCase(unittest.TestCase):
    """Starts bridge.serve() on port 0 and talks to it over HTTP."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(
            os.environ,
            {
                "FLOWMESH_CONFIG_DIR": os.path.join(self.tmp.name, "config"),
                "FLOWMESH_ARTIFACT_DIR": os.path.join(self.tmp.name, "runs"),
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        with bridge.PLAN_LOCK:
            bridge.PLANS.clear()
        del bridge.EVENTS[:]
        self.server = bridge.serve(0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def call(self, method, path, payload=None, token="valid", origin=None, content_type="application/json"):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", content_type)
        if token == "valid":
            request.add_header("X-FlowMesh-Token", bridge.SESSION_TOKEN)
        elif token == "bad":
            request.add_header("X-FlowMesh-Token", "not-the-token")
        if origin:
            request.add_header("Origin", origin)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.headers, response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read().decode("utf-8")

    def json_of(self, body):
        return json.loads(body)

    def path_of(self, value):
        path = Path(value)
        return path if path.is_absolute() else Path(self.tmp.name) / value

    def sha256(self, data):
        return hashlib.sha256(data).hexdigest()
