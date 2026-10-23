"""The page pilot's desktop abilities: system volume keys and window screenshots. No real key is ever pressed."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import bridge
import pilot
from tests.helpers import BridgeTestCase

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
ROOT = Path(__file__).resolve().parent.parent


class VolumeTest(unittest.TestCase):
    def run_volume(self, action, steps=None, windows=True, ok=True):
        pressed = []
        result = pilot.press_volume(action, steps, press=lambda codes, hold: pressed.append((codes, hold)) or ok, windows=windows)
        return result, pressed

    def test_up_down_and_mute_press_the_right_media_key_the_right_number_of_times(self):
        result, pressed = self.run_volume("up")
        self.assertEqual((result["ok"], len(pressed), pressed[0][0]), (True, 5, [0xAF]))
        self.assertIn("about 10%", result["detail"])
        result, pressed = self.run_volume("down", 3)
        self.assertEqual((len(pressed), pressed[0][0]), (3, [0xAE]))
        self.assertIn("about 6%", result["detail"])
        result, pressed = self.run_volume("mute", 20)
        self.assertEqual((len(pressed), pressed[0][0]), (1, [0xAD]), "mute is one press whatever the steps")

    def test_nothing_else_is_accepted(self):
        for action in ("louder", "", None, 7, ["up"], "UP", "up; rm -rf", "../up"):
            result, pressed = self.run_volume(action)
            self.assertFalse(result["ok"], repr(action))
            self.assertEqual((result["kind"], pressed), ("bad_request", []), repr(action))
        for steps in (0, -1, 26, 2.5, "3", True, [3]):
            result, pressed = self.run_volume("up", steps)
            self.assertEqual((result["ok"], result["kind"], pressed), (False, "bad_request", []), repr(steps))

    def test_other_platforms_say_so_and_press_nothing(self):
        result, pressed = self.run_volume("up", windows=False)
        self.assertEqual((result["ok"], result["kind"], pressed), (False, "unsupported", []))

    def test_a_refused_key_press_is_reported_not_hidden(self):
        result, pressed = self.run_volume("up", ok=False)
        self.assertEqual((result["ok"], result["kind"], len(pressed)), (False, "failed", 1))


class ScreenshotTest(unittest.TestCase):
    def test_a_png_is_saved_with_a_generated_name_and_a_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt = pilot.save_screenshot(PNG, Path(tmp) / "shots")
            self.assertRegex(receipt["name"], r"^flowmesh-screenshot-\d{8}-\d{6}\.png$")
            self.assertEqual(Path(receipt["path"]).read_bytes(), PNG)
            self.assertEqual(receipt["sha256"], hashlib.sha256(PNG).hexdigest())
            self.assertEqual(receipt["bytes"], len(PNG))
            self.assertEqual([p.name for p in (Path(tmp) / "shots").iterdir()], [receipt["name"]], "no temp file is left behind")

    def test_anything_that_is_not_a_png_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            for bad in (b"", b"GIF89a", b"<html>", "text", None, b"\x89PNG"):
                with self.assertRaises(ValueError, msg=repr(bad)):
                    pilot.save_screenshot(bad, Path(tmp))


class PilotBridgeTest(BridgeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.pressed = []
        patcher = patch("pilot.wake.press_keys", side_effect=lambda codes, hold: self.pressed.append(codes) or True)
        patcher.start()
        self.addCleanup(patcher.stop)
        windows = patch("pilot.os.name", "nt")
        windows.start()
        self.addCleanup(windows.stop)

    def test_the_status_says_what_this_runtime_can_do(self):
        data = self.json_of(self.call("GET", "/api/pilot")[2])
        self.assertEqual((data["enabled"], data["screenshot"]), (True, False))

    def test_volume_over_http_validates_and_presses_only_fixed_keys(self):
        status, _, body = self.call("POST", "/api/pilot/volume", {"action": "up", "steps": 2})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.pressed, [[0xAF], [0xAF]])
        for bad in ({"action": "sideways"}, {"action": "up", "steps": 99}, {"action": "up", "steps": "3"}, {}):
            self.assertEqual(self.call("POST", "/api/pilot/volume", bad)[0], 400, bad)
        self.assertEqual(self.call("POST", "/api/pilot/volume", {"action": "up", "key": 13})[0], 400)
        self.assertEqual(len(self.pressed), 2, "bad requests pressed nothing")

    def test_the_python_runtime_has_no_window_to_photograph(self):
        status, _, body = self.call("POST", "/api/pilot/screenshot", {})
        self.assertEqual(status, 501)
        self.assertEqual(self.json_of(body)["kind"], "unsupported")

    def test_it_can_be_switched_off_and_needs_the_token(self):
        self.assertEqual(self.call("GET", "/api/pilot", token=None)[0], 401)
        self.assertEqual(self.call("POST", "/api/pilot/volume", {"action": "up"}, token="bad")[0], 401)
        with patch.dict("os.environ", {"FLOWMESH_PILOT": "off"}):
            self.assertEqual(self.call("POST", "/api/pilot/volume", {"action": "up"})[0], 403)
            self.assertFalse(self.json_of(self.call("GET", "/api/pilot")[2])["enabled"])
        self.assertEqual(self.pressed, [])


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class PilotParityTest(unittest.TestCase):
    def test_volume_results_agree(self):
        cases = [("up", None), ("down", 3), ("mute", 7), ("up", 25), ("up", 26), ("sideways", None), ("up", 2.5), ("up", True)]
        for action, steps in cases:
            py_pressed = []
            py = pilot.press_volume(action, steps, press=lambda c, h: py_pressed.append(c) or True, windows=True)
            js = subprocess.run(["node", "-e", (
                "const p=require('./electron/pilot.js'); const calls=[]; "
                f"const r=p.pressVolume({json.dumps(action)}, {json.dumps(steps)}, {{platform:'win32', press:(code,n)=>{{calls.push([code,n]);return true;}}}}); "
                "process.stdout.write(JSON.stringify({r, calls}))")], cwd=ROOT, capture_output=True, encoding="utf-8", check=True).stdout
            js = json.loads(js)
            self.assertEqual(js["r"], py, (action, steps))
            self.assertEqual(sum(n for _, n in js["calls"]), len(py_pressed), (action, steps))

    def test_the_http_routes_are_the_same(self):
        bridge_text = (ROOT / "bridge.py").read_text(encoding="utf-8")
        runtime_text = (ROOT / "electron" / "runtime.js").read_text(encoding="utf-8")
        for route in ("/api/pilot", "/api/pilot/volume", "/api/pilot/screenshot"):
            self.assertIn(f'"{route}"', bridge_text)
            self.assertIn(f"'{route}'", runtime_text)

    def test_screenshots_get_the_same_hash_and_name_shape(self):
        out = subprocess.run(["node", "-e", (
            "const p=require('./electron/pilot.js'); const os=require('os'); const path=require('path'); const fs=require('fs'); "
            "const d=fs.mkdtempSync(path.join(os.tmpdir(),'fm-')); "
            f"const r=p.saveScreenshot(Buffer.from({json.dumps(list(PNG))}), d); fs.rmSync(d,{{recursive:true,force:true}}); "
            "process.stdout.write(JSON.stringify({name:r.name, sha:r.sha256, bytes:r.bytes}))")], cwd=ROOT, capture_output=True, encoding="utf-8", check=True).stdout
        got = json.loads(out)
        self.assertRegex(got["name"], r"^flowmesh-screenshot-\d{8}-\d{6}\.png$")
        self.assertEqual((got["sha"], got["bytes"]), (hashlib.sha256(PNG).hexdigest(), len(PNG)))


if __name__ == "__main__":
    unittest.main()
