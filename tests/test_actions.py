"""Adapters: what each action can honestly claim, and what it refuses."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import bridge
import flowmesh_config as config


class AdapterTests(unittest.TestCase):
    def setUp(self):
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

    def test_unknown_app_target_is_denied(self):
        self.assertEqual(bridge.perform({"kind": "launch_app", "target": "cmd"})["status"], "denied")
        self.assertIsNone(bridge.app_command("powershell"))

    def test_missing_app_reports_unavailable_not_success(self):
        with patch.object(bridge, "app_command", return_value=None):
            receipt = bridge.perform({"kind": "launch_app", "target": "notepad"})
        self.assertEqual(receipt["status"], "unavailable")

    def test_unknown_action_kind_is_denied(self):
        self.assertEqual(bridge.perform({"kind": "shell", "target": "rm -rf"})["status"], "denied")
        self.assertEqual(bridge.perform({"kind": "write_note", "target": "x"})["status"], "denied")

    def test_open_url_rejects_non_http_destinations(self):
        settings = dict(config.DEFAULTS, board_url="file:///C:/private")
        with patch.object(bridge, "settings", return_value=settings):
            receipt = bridge.perform({"kind": "open_url", "target": "project_board"})
        self.assertEqual(receipt["status"], "denied")

    def test_open_url_is_sent_not_verified(self):
        settings = dict(config.DEFAULTS, board_url="https://example.com/board")
        with patch.object(bridge, "settings", return_value=settings):
            with patch.object(bridge.webbrowser, "open", return_value=True):
                receipt = bridge.perform({"kind": "open_url", "target": "project_board"})
        self.assertEqual(receipt["status"], "sent")
        self.assertIn("https://example.com/board", receipt["detail"])

    def test_home_assistant_is_not_configured_without_credentials(self):
        receipt = bridge.perform({"kind": "notify", "target": "my_phone"})
        self.assertEqual(receipt["status"], "not_configured")
        receipt = bridge.perform({"kind": "light", "target": "desk_light", "value": 40})
        self.assertEqual(receipt["status"], "not_configured")

    def test_timer_is_real_and_reports_an_end_time(self):
        receipt = bridge.perform({"kind": "timer", "target": "focus_timer", "value": 30})
        self.assertEqual(receipt["status"], "verified")
        self.assertGreater(receipt["timer_end"], 0)
        with bridge.TIMER_LOCK:
            if bridge.ACTIVE_TIMER is not None:
                bridge.ACTIVE_TIMER.cancel()

    def test_record_is_hashed_and_readable(self):
        plan = {
            "id": "abcdef1234567890",
            "route": "capture",
            "title": "Quick capture",
            "source": "local",
            "actions": [{"kind": "write_note", "target": "run_record", "label": "Save run record", "detail": "x", "surface": "pc", "note": "Ship the thing"}],
        }
        receipt = bridge.write_record(plan, [])
        self.assertEqual(receipt["status"], "verified")
        data = Path(receipt["path"]).read_bytes()
        self.assertEqual(receipt["sha256"], bridge.hashlib.sha256(data).hexdigest())
        text = data.decode("utf-8")
        self.assertIn("Ship the thing", text)
        self.assertIn("`capture` via local rules", text)
        self.assertIn("abcdef123456", text)

    def test_unwritable_artifact_directory_fails_loudly(self):
        blocker = Path(self.tmp.name, "not-a-dir")
        blocker.write_text("x")
        with patch.dict(os.environ, {"FLOWMESH_ARTIFACT_DIR": str(blocker)}):
            plan = {"id": "x" * 12, "route": "capture", "title": "Quick capture", "source": "local", "actions": []}
            receipt = bridge.write_record(plan, [])
        self.assertEqual(receipt["status"], "failed")

    def test_event_log_is_capped(self):
        with bridge.PLAN_LOCK:
            bridge.PLANS["cap"] = {
                "id": "cap",
                "route": "capture",
                "title": "Quick capture",
                "source": "local",
                "expires": 9e9,
                "actions": [{"kind": "write_note", "target": "run_record", "label": "Save run record", "detail": "x", "surface": "pc", "note": "hi"}],
            }
        bridge.EVENTS.extend({"at": "x", "action": {}, "status": "sent", "detail": ""} for _ in range(bridge.MAX_EVENTS + 50))
        bridge.execute_plan("cap")
        self.assertEqual(len(bridge.EVENTS), bridge.MAX_EVENTS)


if __name__ == "__main__":
    unittest.main()
