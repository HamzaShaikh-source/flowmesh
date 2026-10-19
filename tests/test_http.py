import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from bridge import Handler


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_status_and_static_ui(self):
        with urllib.request.urlopen(self.origin + "/api/status") as response:
            self.assertEqual(json.load(response)["mode"], "local_bridge")
        with urllib.request.urlopen(self.origin + "/") as response:
            self.assertIn(b"FlowMesh", response.read())

    def test_cross_origin_post_is_rejected_before_execution(self):
        body = json.dumps({"action": {"kind": "launch_app", "target": "notepad"}}).encode()
        request = urllib.request.Request(self.origin + "/api/execute", data=body, headers={"Origin": "https://evil.example", "Content-Type": "application/json"})
        with patch("bridge.perform") as perform:
            with self.assertRaises(urllib.error.HTTPError) as result:
                urllib.request.urlopen(request)
            self.assertEqual(result.exception.code, 403)
            perform.assert_not_called()


if __name__ == "__main__":
    unittest.main()
