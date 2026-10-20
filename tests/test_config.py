import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import flowmesh_config as config


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {"FLOWMESH_CONFIG_DIR": self.tmp.name})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_secrets_go_to_the_credential_store_not_the_settings_file(self):
        store = MagicMock()
        store.get_password.return_value = "secret-key"
        with patch.object(config, "keyring", store):
            result = config.save({"board_url": "https://example.com/board", "jev_key": "secret-key"})
            self.assertEqual(config.settings()["board_url"], "https://example.com/board")
            self.assertTrue(result["jev_connected"])
            self.assertNotIn("secret-key", Path(self.tmp.name, "settings.json").read_text())
            store.set_password.assert_called_once_with("FlowMesh", "jev_key", "secret-key")

    def test_without_a_keyring_secrets_fall_back_to_a_private_file(self):
        with patch.object(config, "keyring", None):
            config.save({"ha_token": "local-token"})
            self.assertEqual(config.secret("ha_token"), "local-token")
            secrets_file = Path(self.tmp.name, "secrets.json")
            self.assertIn("local-token", secrets_file.read_text())
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(secrets_file.stat().st_mode), 0o600)
            self.assertIn("local file", config.secret_backend())

    def test_public_settings_never_include_secret_values(self):
        with patch.object(config, "keyring", None):
            config.save({"jev_key": "abc123", "ha_token": "def456"})
            public = config.public_settings()
            self.assertNotIn("abc123", str(public))
            self.assertNotIn("def456", str(public))
            self.assertTrue(public["jev_connected"])
            self.assertTrue(public["ha_token_connected"])

    def test_rejects_untrusted_destination_and_entity(self):
        for bad in (
            {"board_url": "file:///C:/private"},
            {"light_entity": "lock.front_door"},
            {"phone_service": "notify_everyone"},
            {"ha_url": "http://user:pass@homeassistant.local:8123"},
            {"unknown": "x"},
        ):
            with self.assertRaises(ValueError, msg=str(bad)):
                config.validate(bad)


if __name__ == "__main__":
    unittest.main()
