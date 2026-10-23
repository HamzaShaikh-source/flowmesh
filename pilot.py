"""The page pilot's two desktop abilities: the real system volume, and a screenshot of the app window.

Everything else the pilot does (zoom, voice volume, scrolling, palette actions) happens inside the
page. These two need the desktop runtime:

* **Volume** presses the Windows media keys (volume up, volume down, mute), a fixed handful of
  presses at a time. It is the real system volume, so the page says so and keeps a separate "voice
  volume" for FlowMesh's own spoken summaries and chime. Windows only; elsewhere it says so.
* **Screenshot** of the app window is taken by the Electron shell (the Python runtime has no window
  of its own, so there the page falls back to the browser's own tab capture, which asks you first).
  The PNG is saved in your FlowMesh folder with a SHA-256 and is never uploaded.

Both are fixed actions: nothing a page or a model sends can name a key, a path or a program.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime
from pathlib import Path

import wake

VOLUME_KEYS = {"up": 0xAF, "down": 0xAE, "mute": 0xAD}  # VK_VOLUME_UP, VK_VOLUME_DOWN, VK_VOLUME_MUTE
DEFAULT_STEPS = 5   # each press moves the Windows volume by 2%, so five presses is 10%
MAX_STEPS = 25


def press_volume(action: object, steps: object = None, press=None, windows: bool | None = None) -> dict:
    """Press a volume key `steps` times. Returns {"ok", "detail"}; never raises on bad input."""
    is_windows = (os.name == "nt") if windows is None else windows
    if not isinstance(action, str) or action not in VOLUME_KEYS:
        return {"ok": False, "kind": "bad_request", "detail": "Volume is up, down or mute."}
    if steps is None:
        steps = DEFAULT_STEPS
    if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= MAX_STEPS:
        return {"ok": False, "kind": "bad_request", "detail": f"Steps must be a whole number from 1 to {MAX_STEPS}."}
    if not is_windows:
        return {"ok": False, "kind": "unsupported", "detail": "System volume control uses Windows media keys, so it is Windows-only for now."}
    sender = press or wake.press_keys
    count = 1 if action == "mute" else steps
    for _ in range(count):
        if not sender([VOLUME_KEYS[action]], 0.05):
            return {"ok": False, "kind": "failed", "detail": "Windows did not accept the key press."}
    words = {"up": "raised", "down": "lowered", "mute": "toggled mute on"}[action]
    return {"ok": True, "detail": f"System volume {words}." if action == "mute" else f"System volume {words} by about {count * 2}%."}


def save_screenshot(png: bytes, directory: Path) -> dict:
    """Write a PNG into `directory` under a generated name and return its receipt."""
    if not isinstance(png, (bytes, bytearray)) or not bytes(png[:8]) == b"\x89PNG\r\n\x1a\n":
        raise ValueError("That is not a PNG image.")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    directory.mkdir(parents=True, exist_ok=True)
    name = f"flowmesh-screenshot-{stamp}.png"
    path = directory / name
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(bytes(png))
    temporary.replace(path)
    return {"name": name, "path": str(path), "bytes": len(png), "sha256": hashlib.sha256(bytes(png)).hexdigest()}
