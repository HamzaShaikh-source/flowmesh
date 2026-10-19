import os
import io
import json
import tempfile
import unittest
from unittest.mock import patch

import bridge


class BridgeTests(unittest.TestCase):
    def test_unregistered_action_is_denied(self):
        result = bridge.perform({"kind": "shell", "target": "powershell", "value": "Remove-Item"})
        self.assertEqual(result["status"], "denied")

    def test_light_requires_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"FLOWMESH_CONFIG_DIR": directory}, clear=True):
                result = bridge.perform({"kind": "light", "target": "desk_light", "value": 30})
        self.assertEqual(result["status"], "not_configured")

    def test_brightness_bounds_are_enforced(self):
        result = bridge.perform({"kind": "light", "target": "desk_light", "value": 101})
        self.assertEqual(result["status"], "denied")

    def test_browser_url_scheme_is_bounded(self):
        with patch.object(bridge, "settings", return_value={"board_url": "file:///C:/secret"}):
            result = bridge.perform({"kind": "open_url", "target": "project_board"})
        self.assertEqual(result["status"], "denied")

    def test_light_reports_verified_only_after_readback(self):
        with patch.dict(os.environ, {"FLOWMESH_LIGHT_ENTITY": "light.desk"}):
            with patch.object(bridge, "home_assistant", return_value={"status": "sent"}):
                with patch.object(bridge, "home_state", return_value={"state": "on", "attributes": {"brightness": 77}}):
                    result = bridge.perform({"kind": "light", "target": "desk_light", "value": 30})
        self.assertEqual(result["status"], "verified")

    def test_notification_requires_registered_mobile_service(self):
        with patch.dict(os.environ, {"FLOWMESH_PHONE_NOTIFY_SERVICE": "send_anywhere"}):
            result = bridge.perform({"kind": "notify", "target": "my_phone", "message": "Hello"})
        self.assertEqual(result["status"], "not_configured")

    def test_jev_without_key_uses_local_route(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(bridge, "secret", return_value=""):
                result = bridge.jev_route("focus", ["focus", "meeting"])
        self.assertEqual(result["source"], "local")

    def test_jev_choice_stays_with_registered_workflow(self):
        reply = io.BytesIO(json.dumps({"answers": {"route": {"choice": "focus", "confidence": 0.92}}}).encode())
        with patch.object(bridge, "secret", return_value="test-key"):
            with patch.object(bridge.urllib.request, "urlopen", return_value=reply):
                result = bridge.jev_route("Start a focus block", ["focus", "meeting"])
        self.assertEqual(result, {"route": "focus", "source": "jev", "confidence": 0.92})

    def test_jev_rejects_unregistered_choice(self):
        reply = io.BytesIO(json.dumps({"answers": {"route": {"choice": "delete_files", "confidence": 1.0}}}).encode())
        with patch.object(bridge, "secret", return_value="test-key"):
            with patch.object(bridge.urllib.request, "urlopen", return_value=reply):
                result = bridge.jev_route("Delete files", ["focus", "meeting"])
        self.assertIsNone(result["route"])


if __name__ == "__main__":
    unittest.main()
