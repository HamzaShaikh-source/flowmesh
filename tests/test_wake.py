"""The wake word: strict shortcut grammar, an opt-in listener that never transcribes, honest states."""

from __future__ import annotations

import io
import re
import time
import unittest
from unittest.mock import patch

import bridge
import wake
from tests.helpers import BridgeTestCase


class FakeProc:
    """Stands in for the PowerShell process: emits canned lines, then blocks until killed."""

    def __init__(self, lines: list[str]):
        self.stdout = _Blocking(("\n".join(lines) + "\n").encode())
        self.killed = False

    def poll(self):
        return 0 if self.killed else None

    def kill(self):
        self.killed = True
        self.stdout.release()

    def wait(self, timeout=None):
        return 0


class _Blocking(io.BytesIO):
    def __init__(self, data: bytes):
        super().__init__(data)
        import threading

        self._done = threading.Event()

    def readline(self, *args):
        line = super().readline(*args)
        if line:
            return line
        self._done.wait(5)
        return b""

    def release(self):
        self._done.set()


def listener(lines, press=None, windows=True):
    store: dict = {}
    pressed = []
    manager = wake.WakeListener(load=lambda: store, save=lambda v: store.update(v), opener=lambda: FakeProc(lines),
                                press=press or (lambda codes, hold: pressed.append((codes, hold)) or True), windows=windows)
    return manager, pressed, store


def wait_for(predicate, seconds=3.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class ComboTest(unittest.TestCase):
    def test_valid_shortcuts_become_virtual_key_codes(self):
        self.assertEqual(wake.parse_combo("ctrl+alt+space"), [0x11, 0x12, 0x20])
        self.assertEqual(wake.parse_combo("Ctrl + Win + W".replace(" ", "")), [0x11, 0x5B, ord("W")])
        self.assertEqual(wake.parse_combo("alt+f9"), [0x12, 0x78])
        self.assertEqual(wake.parse_combo("shift+7"), [0x10, ord("7")])

    def test_everything_else_is_refused(self):
        for bad in ("", "   ", "space", "w", "ctrl", "ctrl+ctrl+w", "ctrl+alt+shift+win+w", "ctrl+f13", "ctrl+escape", "ctrl+;",
                    "ctrl+alt+", "ctrl++w", "ctrl+w+x", "rm -rf", "ctrl+" + "a" * 50, None, 7, ["ctrl+w"]):
            with self.assertRaises(ValueError, msg=repr(bad)):
                wake.parse_combo(bad)


class ScriptTest(unittest.TestCase):
    def test_the_script_is_fixed_and_agrees_with_the_constants(self):
        self.assertNotRegex(wake.SCRIPT, r"\{\d\}|\$env:|%s|\$args")  # nothing is interpolated into it
        for phrase in wake.WAKE_PHRASES:
            self.assertIn(f"'{phrase}'", wake.SCRIPT)
        self.assertIn(f"-ge {wake.CONFIDENCE_FLOOR}", wake.SCRIPT)
        self.assertIn("DictationGrammar", wake.SCRIPT)  # a decoy, so other speech is not forced onto the wake phrase
        self.assertNotRegex(wake.SCRIPT, r"\.Text\b")

    def test_it_is_started_with_an_encoded_command_and_no_shell(self):
        with patch("wake.subprocess.Popen") as popen:
            wake.default_opener()
        args, kwargs = popen.call_args
        self.assertIn("-EncodedCommand", args[0])
        self.assertIs(kwargs["shell"], False)
        decoded = __import__("base64").b64decode(args[0][-1]).decode("utf-16-le")
        self.assertEqual(decoded, wake.SCRIPT)


class ListenerTest(unittest.TestCase):
    def test_it_listens_only_after_ready_and_counts_wakes(self):
        manager, pressed, _ = listener(["READY", "WAKE 0.93"])
        self.addCleanup(manager.stop)
        self.assertEqual(manager.status()["state"], "off")
        manager.start()
        self.assertTrue(wait_for(lambda: manager.status()["wakes"] == 1))
        status = manager.status()
        self.assertEqual(status["state"], "listening")
        self.assertTrue(status["last_wake_at"])
        self.assertEqual(pressed, [], "no shortcut is configured, so nothing is pressed")

    def test_a_configured_shortcut_is_pressed_once_and_the_cooldown_swallows_repeats(self):
        manager, pressed, _ = listener(["READY", "WAKE 0.9", "WAKE 0.9", "WAKE 0.95"])
        manager.set_config({"summon": "Ctrl+Alt+Space", "hold_s": 2})
        self.addCleanup(manager.stop)
        manager.start()
        self.assertTrue(wait_for(lambda: pressed))
        time.sleep(0.3)
        self.assertEqual(pressed, [([0x11, 0x12, 0x20], 2.0)])
        self.assertEqual(manager.status()["wakes"], 1)
        self.assertEqual(manager.config()["summon"], "ctrl+alt+space")

    def test_a_recogniser_error_is_reported_without_leaking_noise(self):
        manager, _, _ = listener(["ERROR No recognizer\x00 <script>"])
        self.addCleanup(manager.stop)
        manager.start()
        self.assertTrue(wait_for(lambda: manager.status()["state"] == "error"))
        detail = manager.status()["detail"]
        self.assertIn("No recognizer", detail)
        self.assertNotIn("<", detail)

    def test_stop_kills_the_process_and_returns_to_off(self):
        manager, _, _ = listener(["READY"])
        manager.start()
        self.assertTrue(wait_for(lambda: manager.status()["state"] == "listening"))
        proc = manager._proc
        self.assertEqual(manager.stop()["state"], "off")
        self.assertTrue(proc.killed)

    def test_other_platforms_say_so_and_start_nothing(self):
        manager, _, _ = listener(["READY"], windows=False)
        self.assertEqual(manager.start()["state"], "unsupported")
        self.assertIsNone(manager._proc)

    def test_config_validation(self):
        manager, _, _ = listener([])
        for bad in ({"summon": "w"}, {"hold_s": -1}, {"hold_s": 31}, {"hold_s": True}, {"hold_s": "3"}, {"extra": 1}, "x"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                manager.set_config(bad)
        self.assertEqual(manager.set_config({"summon": ""})["summon"], "")
        self.assertEqual(manager.set_config({"hold_s": 5})["hold_s"], 5.0)


class WakeBridgeTest(BridgeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.manager, self.pressed, _ = listener(["READY", "WAKE 0.9"])
        patcher = patch.object(bridge, "WAKE", self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.manager.stop)

    def test_turning_it_on_needs_an_acknowledgement(self):
        status, _, body = self.call("POST", "/api/wake", {"enabled": True})
        self.assertEqual(status, 428)
        self.assertTrue(self.json_of(body)["needs_acknowledgement"])
        self.assertEqual(self.json_of(self.call("GET", "/api/wake")[2])["state"], "off")

    def test_on_off_and_status(self):
        status, _, body = self.call("POST", "/api/wake", {"enabled": True, "acknowledged": True})
        self.assertEqual(status, 200, body)
        self.assertTrue(wait_for(lambda: self.json_of(self.call("GET", "/api/wake")[2])["state"] == "listening"))
        data = self.json_of(self.call("GET", "/api/wake")[2])
        self.assertEqual(data["wakes"], 1)
        self.assertEqual(data["phrases"], wake.WAKE_PHRASES)
        self.assertEqual(self.json_of(self.call("POST", "/api/wake", {"enabled": False})[2])["state"], "off")

    def test_the_shortcut_is_validated_and_never_free_text(self):
        self.assertEqual(self.call("POST", "/api/wake", {"summon": "ctrl+alt+space", "hold_s": 3})[0], 200)
        self.assertEqual(self.json_of(self.call("GET", "/api/wake")[2])["summon"], "ctrl+alt+space")
        for bad in ({"summon": "just type this"}, {"summon": "w"}, {"hold_s": 99}):
            self.assertEqual(self.call("POST", "/api/wake", bad)[0], 422, bad)
        for bad in ({"enabled": "yes"}, {"surprise": 1}, {"acknowledged": 1}):
            self.assertEqual(self.call("POST", "/api/wake", bad)[0], 400, bad)

    def test_a_summon_test_needs_a_shortcut_and_waits_before_pressing(self):
        self.assertEqual(self.call("POST", "/api/wake", {"test_summon": True})[0], 422)
        self.manager.set_config({"summon": "ctrl+alt+w"})
        with patch("bridge.threading.Timer") as timer:
            self.assertEqual(self.call("POST", "/api/wake", {"test_summon": True})[0], 200)
        self.assertEqual(timer.call_args.args[0], 3.0)
        self.assertEqual(self.pressed, [], "nothing is pressed during the request")

    def test_it_can_be_switched_off_for_an_install(self):
        with patch.dict("os.environ", {"FLOWMESH_WAKE": "off"}):
            self.assertEqual(self.call("POST", "/api/wake", {"enabled": True, "acknowledged": True})[0], 403)
            self.assertFalse(self.json_of(self.call("GET", "/api/wake")[2])["enabled"])

    def test_it_requires_the_session_token(self):
        self.assertEqual(self.call("GET", "/api/wake", token=None)[0], 401)
        self.assertEqual(self.call("POST", "/api/wake", {"enabled": False}, token="bad")[0], 401)


if __name__ == "__main__":
    unittest.main()
