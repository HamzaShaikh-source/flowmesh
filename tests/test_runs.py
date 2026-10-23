"""History: only records FlowMesh itself wrote can be listed or read."""

from __future__ import annotations

import unittest
import urllib.parse

from tests.helpers import BridgeTestCase


class RunsTest(BridgeTestCase):
    def make_run(self, text="capture: remember the quote"):
        plan = self.json_of(self.call("POST", "/api/plan", {"command": text})[2])
        results = self.json_of(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[2])["results"]
        return results[-1]["path"]

    def test_a_run_is_listed_and_can_be_read_back(self):
        path = self.make_run()
        listing = self.json_of(self.call("GET", "/api/runs")[2])["runs"]
        self.assertEqual(len(listing), 1)
        name = listing[0]["name"]
        self.assertTrue(path.endswith(name))
        self.assertTrue(listing[0]["title"])
        status, _, body = self.call("GET", "/api/runs/" + urllib.parse.quote(name))
        self.assertEqual(status, 200)
        record = self.json_of(body)
        self.assertIn("remember the quote", record["text"])
        self.assertFalse(record["truncated"])

    def test_only_generated_names_are_readable(self):
        self.make_run()
        (self.path_of("runs")).mkdir(parents=True, exist_ok=True)
        secret = self.path_of("runs") / "notes.txt"
        secret.write_text("private", encoding="utf-8")
        for name in ("notes.txt", "..%2Fconfig%2Fsettings.json", "..%5C..%5Cx.md", "flowmesh-.md", "flowmesh-a.txt",
                     "flowmesh-../x.md", "%2e%2e%2fx", "flowmesh-" + "a" * 200 + ".md"):
            status, _, _ = self.call("GET", "/api/runs/" + name)
            self.assertEqual(status, 404, name)
        listed = {r["name"] for r in self.json_of(self.call("GET", "/api/runs")[2])["runs"]}
        self.assertNotIn("notes.txt", listed)

    def test_routes_need_the_session_token(self):
        for path in ("/api/runs", "/api/runs/flowmesh-x.md"):
            self.assertEqual(self.call("GET", path, token="none")[0], 401, path)

    def test_newest_first(self):
        self.make_run("capture: first")
        self.make_run("capture: second")
        runs = self.json_of(self.call("GET", "/api/runs")[2])["runs"]
        self.assertEqual(len(runs), 2)
        self.assertGreaterEqual(runs[0]["modified"], runs[1]["modified"])


if __name__ == "__main__":
    unittest.main()
