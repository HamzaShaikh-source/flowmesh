"""HTTP contract and trust boundaries. Every rejection here is a feature."""

from __future__ import annotations

from unittest.mock import patch

import bridge
from helpers import BridgeTestCase


class TrustTests(BridgeTestCase):
    def test_static_ui_needs_no_token(self):
        status, headers, body = self.call("GET", "/", token="none")
        self.assertEqual(status, 200)
        self.assertIn("Say the work", body)
        policy = headers.get("Content-Security-Policy", "")
        self.assertIn("default-src 'self'", policy)
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")

    def test_every_api_read_requires_the_session_token(self):
        for path in ("/api/status", "/api/settings", "/api/events"):
            status, _, _ = self.call("GET", path, token="none")
            self.assertEqual(status, 401, path)
            status, _, _ = self.call("GET", path, token="bad")
            self.assertEqual(status, 401, path)

    def test_unknown_host_is_refused(self):
        status, _, body = self.call("GET", "/api/status")
        self.assertEqual(status, 200)
        server, thread, base = self.server, self.thread, self.base
        try:
            import http.client
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            connection.putrequest("GET", "/api/status", skip_host=True)
            connection.putheader("Host", "evil.example")
            connection.putheader("X-FlowMesh-Token", bridge.SESSION_TOKEN)
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            self.assertIn("Invalid host", response.read().decode())
            connection.close()
        finally:
            self.assertTrue(base.startswith("http://127.0.0.1:"))
            self.assertTrue(thread.is_alive())

    def test_cross_origin_plan_is_refused(self):
        with patch.object(bridge, "perform") as perform:
            status, _, body = self.call(
                "POST", "/api/plan", {"command": "capture: hello"}, origin="https://evil.example"
            )
            self.assertEqual(status, 403)
            self.assertIn("Cross-origin", body)
            perform.assert_not_called()

    def test_wrong_content_type_is_refused(self):
        status, _, body = self.call(
            "POST", "/api/plan", {"command": "capture: hello"}, content_type="text/plain"
        )
        self.assertEqual(status, 415)
        self.assertIn("JSON content type", body)

    def test_raw_action_payload_cannot_execute(self):
        with patch.object(bridge, "perform") as perform:
            status, _, body = self.call(
                "POST",
                "/api/execute",
                {"actions": [{"kind": "open_url", "target": "https://evil.example"}]},
            )
            self.assertEqual(status, 400)
            self.assertIn("Invalid plan", body)
            perform.assert_not_called()

    def test_a_valid_plan_id_cannot_be_amended_with_actions(self):
        status, _, raw = self.call("POST", "/api/plan", {"command": "Open the project board"})
        self.assertEqual(status, 200)
        plan = self.json_of(raw)
        with patch.object(bridge, "perform") as perform:
            status, _, body = self.call(
                "POST",
                "/api/execute",
                {
                    "plan_id": plan["id"],
                    "actions": [{"kind": "open_url", "target": "https://evil.example"}],
                },
            )
            self.assertEqual(status, 400)
            self.assertIn("Invalid plan", body)
            perform.assert_not_called()

    def test_sensitive_and_unclear_commands_become_no_plan(self):
        for command in ("delete my files", "transfer 500 dollars", "make me a sandwich"):
            status, _, _ = self.call("POST", "/api/plan", {"command": command})
            self.assertEqual(status, 422, command)
        with bridge.PLAN_LOCK:
            self.assertEqual(bridge.PLANS, {})

    def test_oversized_command_is_refused(self):
        status, _, _ = self.call("POST", "/api/plan", {"command": "focus " + "x" * 1200})
        self.assertEqual(status, 422)


class LifecycleTests(BridgeTestCase):
    def test_status_is_honest_about_capabilities(self):
        status, _, body = self.call("GET", "/api/status")
        self.assertEqual(status, 200)
        data = self.json_of(body)
        self.assertEqual(data["mode"], "desktop_app")
        self.assertEqual(data["version"], "1.5.0")
        self.assertEqual(data["capabilities"]["write_note"], "ready")
        self.assertEqual(data["capabilities"]["notify"], "not_configured")
        self.assertEqual(data["capabilities"]["light"], "not_configured")
        self.assertTrue(data["artifact_dir"].endswith("runs"))

    def test_approval_runs_each_action_once_and_writes_a_record(self):
        command = "I finished the pricing call. Follow-up: send Rohan the revised quote."
        status, _, body = self.call("POST", "/api/plan", {"command": command})
        self.assertEqual(status, 200)
        plan = self.json_of(body)
        self.assertEqual(plan["route"], "meeting")
        self.assertEqual([a["kind"] for a in plan["actions"]], ["open_url", "notify", "light", "write_note"])
        self.assertNotIn("expires", plan)

        with patch.object(bridge, "perform", return_value={"status": "sent", "detail": "test"}) as perform:
            status, _, body = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
            self.assertEqual(status, 200)
            results = self.json_of(body)["results"]
            self.assertEqual(perform.call_count, len(plan["actions"]) - 1)
            self.assertEqual(len(results), len(plan["actions"]))
            status, _, body = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
            self.assertEqual(status, 409)
            self.assertIn("expired or already used", body)
            self.assertEqual(perform.call_count, len(plan["actions"]) - 1)

        record = results[-1]
        self.assertEqual(record["status"], "verified")
        self.assertEqual(record["action"]["kind"], "write_note")
        path = self.path_of(record["path"])
        data = path.read_bytes()
        self.assertEqual(record["bytes"], len(data))
        self.assertEqual(record["sha256"], self.sha256(data))
        text = data.decode("utf-8")
        self.assertIn("FlowMesh run", text)
        self.assertIn("single use", text)
        self.assertIn(command, text)
        self.assertIn("| sent | test |", text)

    def test_cancelled_plan_cannot_run(self):
        _, _, body = self.call("POST", "/api/plan", {"command": "start a 25 minute research sprint"})
        plan = self.json_of(body)
        with patch.object(bridge, "perform") as perform:
            status, _, _ = self.call("POST", "/api/cancel", {"plan_id": plan["id"]})
            self.assertEqual(status, 200)
            status, _, _ = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
            self.assertEqual(status, 409)
            perform.assert_not_called()

    def test_capture_needs_no_integrations(self):
        _, _, body = self.call("POST", "/api/plan", {"command": "capture: the judges page hides the weights"})
        plan = self.json_of(body)
        self.assertEqual([a["kind"] for a in plan["actions"]], ["write_note"])
        self.assertEqual(plan["actions"][0]["note"], "the judges page hides the weights")
        status, _, body = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
        self.assertEqual(status, 200)
        results = self.json_of(body)["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["status"], "verified")
        self.assertTrue(self.path_of(results[0]["path"]).is_file())

    def test_settings_round_trip_never_returns_secrets(self):
        token = "ha-token-should-not-come-back"
        status, _, body = self.call(
            "POST",
            "/api/settings",
            {
                "board_url": "https://example.com/board",
                "ha_url": "http://homeassistant.local:8123",
                "ha_token": token,
                "light_entity": "light.desk_lamp",
                "phone_service": "mobile_app_pixel",
            },
        )
        self.assertEqual(status, 200)
        self.assertNotIn(token, body)
        data = self.json_of(body)
        self.assertTrue(data["ha_token_connected"])
        status, _, body = self.call("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertNotIn(token, body)
        self.assertEqual(self.json_of(body)["board_url"], "https://example.com/board")
        settings_file = self.path_of("config/settings.json")
        self.assertNotIn(token, settings_file.read_text(encoding="utf-8"))

    def test_bad_settings_are_rejected_without_writing(self):
        status, _, body = self.call("POST", "/api/settings", {"board_url": "file:///C:/private"})
        self.assertEqual(status, 400)
        self.assertIn("HTTP(S)", body)
        self.assertFalse(self.path_of("config/settings.json").exists())

    def test_events_expose_receipts_after_a_run(self):
        _, _, body = self.call("POST", "/api/plan", {"command": "capture: receipt test"})
        plan = self.json_of(body)
        self.call("POST", "/api/execute", {"plan_id": plan["id"]})
        status, _, body = self.call("GET", "/api/events")
        self.assertEqual(status, 200)
        events = self.json_of(body)["events"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["status"], "verified")
        self.assertTrue(events[0]["at"].endswith("+00:00"))

    def test_unknown_api_path_is_404(self):
        status, _, _ = self.call("GET", "/api/nope")
        self.assertEqual(status, 404)


class SecondIntentHttpTests(BridgeTestCase):
    def test_plan_reports_a_second_intent_it_will_not_run(self):
        status, _, raw = self.call(
            "POST",
            "/api/plan",
            {"command": "Capture the release link. Start a 20 minute research sprint."},
        )
        self.assertEqual(status, 200)
        plan = self.json_of(raw)
        self.assertEqual(plan["route"], "capture")
        self.assertEqual(plan["also"], ["Research sprint"])
        self.assertEqual(len(plan["actions"]), 1)
        self.assertEqual(plan["actions"][0]["kind"], "write_note")
