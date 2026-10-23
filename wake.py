"""A local wake word ("Hey FlowMesh") that can press your Wispr Flow hotkey for you.

Why it is built this way
------------------------
* **Offline.** Detection uses the speech recogniser that ships with Windows (System.Speech),
  driven by a small fixed PowerShell script. No audio leaves the computer and no cloud speech
  service is involved. (A browser speech API would stream everything you say to a third party,
  and the Electron build has none.) Windows only for now; elsewhere it says so.
* **Opt-in, every launch.** It never starts by itself. Turning it on needs an explicit
  acknowledgement, a visible indicator stays on while it listens, and it stops when FlowMesh exits.
* **A wake word only wakes.** It matches one short phrase. It does not transcribe, store or
  forward anything you say. What happens next is a fixed action: show a cue, and (only if you
  configured it) press your own Wispr Flow shortcut so Wispr takes over the dictation.
* **The keystroke is yours and fixed.** The shortcut is parsed from a strict grammar
  (modifiers plus one key, at most four keys), never free text, and only ever sent to whatever
  window has focus. Tap it, or hold it for a few seconds if your Wispr shortcut is push-to-talk.
* **Honest limits.** The recogniser is constrained to a few phrases plus general dictation as a
  decoy, with a confidence floor, but false wakes and missed wakes both happen. Wispr's own
  shortcut may be a key combination Windows cannot synthesise (for example Fn).
"""

from __future__ import annotations

import base64
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone

import flowmesh_config

BLOB = "wake"
CONFIDENCE_FLOOR = 0.82
COOLDOWN_S = 6.0
MAX_HOLD_S = 30
WAKE_PHRASES = ["hey flow mesh", "hey flowmesh", "okay flow mesh"]

# The whole script is fixed: nothing from a user, a page or a model is ever interpolated into it.
SCRIPT = """$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $choices = New-Object System.Speech.Recognition.Choices
  foreach ($p in @('hey flow mesh', 'hey flowmesh', 'okay flow mesh')) { [void]$choices.Add($p) }
  $wake = New-Object System.Speech.Recognition.Grammar((New-Object System.Speech.Recognition.GrammarBuilder($choices)))
  $wake.Name = 'wake'
  $engine.LoadGrammar($wake)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToDefaultAudioDevice()
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  while ($true) {
    $r = $engine.Recognize([TimeSpan]::FromSeconds(5))
    if ($r -ne $null -and $r.Grammar.Name -eq 'wake' -and $r.Confidence -ge 0.82) {
      [Console]::Out.WriteLine('WAKE ' + [math]::Round($r.Confidence, 2))
      [Console]::Out.Flush()
    }
  }
} catch {
  [Console]::Out.WriteLine('ERROR ' + $_.Exception.Message)
  [Console]::Out.Flush()
}
"""

_MODIFIERS = {"ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B, "windows": 0x5B, "super": 0x5B}
_NAMED = {"space": 0x20, "enter": 0x0D, "return": 0x0D, "tab": 0x09}


def parse_combo(text: object) -> list[int]:
    """`ctrl+alt+space` -> [0x11, 0x12, 0x20] (virtual-key codes), or ValueError.

    Modifiers plus exactly one key, at most four keys; letters, digits, F1-F12, space, enter, tab.
    At least one modifier is required so a stray key never types into the window that has focus.
    """
    if not isinstance(text, str) or not text.strip() or len(text) > 40:
        raise ValueError("Enter a shortcut such as ctrl+alt+space.")
    parts = [p.strip().lower() for p in text.split("+")]
    if len(parts) > 4 or any(not p for p in parts):
        raise ValueError("Use at most three modifiers and one key, joined with +.")
    mods = [p for p in parts[:-1]]
    key = parts[-1]
    if not mods or any(m not in _MODIFIERS for m in mods) or len({_MODIFIERS[m] for m in mods}) != len(mods):
        raise ValueError("Start with one or more of ctrl, alt, shift, win.")
    if key in _MODIFIERS:
        raise ValueError("End with a key (a letter, digit, F1-F12, space, enter or tab).")
    if key in _NAMED:
        code = _NAMED[key]
    elif re.fullmatch(r"[a-z0-9]", key):
        code = ord(key.upper())
    elif re.fullmatch(r"f([1-9]|1[0-2])", key):
        code = 0x6F + int(key[1:])
    else:
        raise ValueError("End with a key (a letter, digit, F1-F12, space, enter or tab).")
    return [_MODIFIERS[m] for m in mods] + [code]


def press_keys(codes: list[int], hold_s: float = 0.0) -> bool:
    """Press the keys together, hold them, release in reverse. Windows only; False elsewhere."""
    if os.name != "nt":
        return False
    import ctypes

    user32 = ctypes.windll.user32
    KEYUP = 0x0002
    for code in codes:
        user32.keybd_event(code, 0, 0, 0)
    time.sleep(max(0.05, min(float(hold_s), MAX_HOLD_S)))
    for code in reversed(codes):
        user32.keybd_event(code, 0, KEYUP, 0)
    return True


def encoded_script() -> str:
    return base64.b64encode(SCRIPT.encode("utf-16-le")).decode("ascii")


def default_opener() -> subprocess.Popen:
    return subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded_script()],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


class WakeListener:
    def __init__(self, load=None, save=None, opener=None, press=None, windows: bool | None = None):
        self._load = load or (lambda: flowmesh_config.load_blob(BLOB))
        self._save = save or (lambda value: flowmesh_config.save_blob(BLOB, value))
        self._opener = opener or default_opener
        self._press = press or press_keys
        self._windows = (os.name == "nt") if windows is None else windows
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._state = "off"
        self._detail = ""
        self._wakes = 0
        self._last_wake = ""
        self._last_wake_mono = -COOLDOWN_S
        self._summoned = 0

    # -- configuration (the shortcut and how long to hold it; no secrets)

    def config(self) -> dict:
        data = self._load()
        data = data if isinstance(data, dict) else {}
        summon = data.get("summon") if isinstance(data.get("summon"), str) else ""
        try:
            hold = float(data.get("hold_s", 0))
        except (TypeError, ValueError):
            hold = 0.0
        return {"summon": summon, "hold_s": max(0.0, min(hold, MAX_HOLD_S))}

    def set_config(self, raw: object) -> dict:
        if not isinstance(raw, dict) or set(raw) - {"summon", "hold_s"}:
            raise ValueError("Unknown setting.")
        current = self.config()
        if "summon" in raw:
            if raw["summon"] in ("", None):
                current["summon"] = ""
            else:
                parse_combo(raw["summon"])
                current["summon"] = "+".join(p.strip().lower() for p in str(raw["summon"]).split("+"))
        if "hold_s" in raw:
            if isinstance(raw["hold_s"], bool) or not isinstance(raw["hold_s"], (int, float)) or not 0 <= raw["hold_s"] <= MAX_HOLD_S:
                raise ValueError(f"Hold time must be between 0 and {MAX_HOLD_S} seconds.")
            current["hold_s"] = float(raw["hold_s"])
        self._save(current)
        return current

    # -- listening

    def status(self) -> dict:
        with self._lock:
            state, detail = self._state, self._detail
        if not self._windows:
            state, detail = "unsupported", "The wake word uses the speech recogniser built into Windows, so it is Windows-only for now."
        return {"state": state, "detail": detail, "wakes": self._wakes, "last_wake_at": self._last_wake,
                "summoned": self._summoned, "phrases": WAKE_PHRASES, **self.config()}

    def start(self) -> dict:
        if not self._windows:
            return self.status()
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return self.status()
            self._state, self._detail = "starting", ""
            try:
                self._proc = self._opener()
            except OSError as exc:
                self._proc = None
                self._state, self._detail = "error", f"Could not start the recogniser ({type(exc).__name__})."
                return self.status()
            proc = self._proc
        threading.Thread(target=self._read, args=(proc,), daemon=True).start()
        return self.status()

    def stop(self) -> dict:
        with self._lock:
            proc, self._proc = self._proc, None
            self._state, self._detail = "off", ""
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                pass
            try:
                if proc.stdout:
                    proc.stdout.close()
            except OSError:
                pass
        return self.status()

    def _read(self, proc: subprocess.Popen) -> None:
        try:
            for raw in iter(proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").strip()
                if line == "READY":
                    with self._lock:
                        if self._proc is proc:
                            self._state, self._detail = "listening", ""
                elif line.startswith("WAKE "):
                    self._wake(proc, line[5:])
                elif line.startswith("ERROR "):
                    with self._lock:
                        if self._proc is proc:
                            self._state = "error"
                            self._detail = "The Windows speech recogniser could not start: " + re.sub(r"[^\w .,:'-]", " ", line[6:])[:160]
        except (OSError, ValueError):
            pass
        with self._lock:
            if self._proc is proc:
                self._proc = None
                if self._state != "error":
                    self._state, self._detail = "off", "The recogniser stopped."

    def _wake(self, proc: subprocess.Popen, confidence: str) -> None:
        now = time.monotonic()
        with self._lock:
            if self._proc is not proc or now - self._last_wake_mono < COOLDOWN_S:
                return
            self._last_wake_mono = now
            self._wakes += 1
            self._last_wake = datetime.now(timezone.utc).isoformat(timespec="seconds")
        config = self.config()
        if config["summon"]:
            threading.Thread(target=self.summon, daemon=True).start()  # a held shortcut must not stall the reader

    def summon(self) -> bool:
        """Press the configured Wispr shortcut. False when none is configured or it cannot be sent."""
        config = self.config()
        if not config["summon"]:
            return False
        sent = bool(self._press(parse_combo(config["summon"]), config["hold_s"]))
        if sent:
            self._summoned += 1
        return sent

    def simulate_wake(self) -> None:
        """For tests: behave as if the recogniser heard the phrase."""
        proc = self._proc
        if proc is not None:
            self._wake(proc, "1.0")


MANAGER = WakeListener()
