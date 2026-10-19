import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import flowmesh_config as config


class ConfigTests(unittest.TestCase):
    def test_settings_round_trip_without_exposing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"FLOWMESH_CONFIG_DIR": directory}):
                with patch.object(config.keyring, "set_password") as set_password:
                    with patch.object(config.keyring, "get_password", return_value="secret-key"):
                        result = config.save({"board_url": "https://example.com/board", "jev_key": "secret-key"})
                        self.assertEqual(config.settings()["board_url"], "https://example.com/board")
                        self.assertTrue(result["jev_connected"])
                        self.assertNotIn("secret-key", Path(directory, "settings.json").read_text())
                        set_password.assert_called_once_with("FlowMesh", "jev_key", "secret-key")

    def test_rejects_untrusted_destination_and_entity(self):
        with self.assertRaises(ValueError):
            config.validate({"board_url": "file:///C:/private"})
        with self.assertRaises(ValueError):
            config.validate({"light_entity": "lock.front_door"})
        with self.assertRaises(ValueError):
            config.validate({"phone_service": "notify_everyone"})


if __name__ == "__main__":
    unittest.main()
