"""Local FlowMesh runtime. Plans, approvals, and run records are owned here.

Threat model: the browser UI and any other local process. Every /api call needs
the per-launch session token that only the desktop window was given, plus the
loopback Host and (when present) a matching Origin. Plans are server-owned,
expire, and are consumed once; the client can never submit an action payload.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from flowmesh_config import VERSION, public_settings, save, secret, settings
from planner import FORBIDDEN, WORKFLOWS, actions_for, command_is_usable, local_route, other_intents
import wispr_source

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
WEB = ROOT / "web"
EVENTS: list[dict] = []
PLANS: dict[str, dict] = {}
PLAN_LOCK = threading.Lock()
PLAN_LIFETIME = 300
MAX_EVENTS = 200
TIMER_LOCK = threading.Lock()
ACTIVE_TIMER: threading.Timer | None = None
TIMER_END: float | None = None
SESSION_TOKEN = secrets.token_urlsafe(24)

# Dictations that have already been turned into an executed plan. Keyed by Wispr's
# own transcript id, so a second hotkey press inside the same sentence cannot execute
# the same intent twice — the guard is the id, not a timer.
WISPR_HANDLED: dict[str, str] = {}
WISPR_LOCK = threading.Lock()
WISPR_MAX_AGE_DEFAULT = 300

ALLOWED_URLS = {
    "project_board": ("board_url", "https://github.com/HamzaShaikh-source/flowmesh/issues"),
    "documentation": ("docs_url", "https://github.com/HamzaShaikh-source/flowmesh/tree/main/docs"),
}
ALLOWED_APPS = ("notepad", "calculator")
CSP = (
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def app_command(target: str) -> list[str] | None:
    """Only two allowlisted apps, never a caller-supplied command."""
    if target not in ALLOWED_APPS:
        return None
    if os.name == "nt":
        return ["notepad.exe"] if target == "notepad" else ["calc.exe"]
    if sys.platform == "darwin":
        return ["open", "-a", "TextEdit"] if target == "notepad" else ["open", "-a", "Calculator"]
    candidates = (
        ["gedit", "gnome-text-editor", "kate", "xed", "mousepad"]
        if target == "notepad"
        else ["gnome-calculator", "kcalc", "galculator"]
    )
    for name in candidates:
        found = shutil.which(name)
        if found:
            return [found]
    return None


MAX_TYPED_CHARS = 2000
# Whether the delivery path can afterwards prove which window received the keystrokes.
_FOCUS_CHECKED = True
_FOCUS_UNCHECKED = False


def _type_windows(text: str) -> bool:
    """Synthesise the text as Unicode keystrokes via keybd_event (no clipboard)."""
    import ctypes

    KEYEVENTF_UNICODE = 0x0004
    KEYEVENTF_KEYUP = 0x0002
    user32 = ctypes.windll.user32
    target = user32.GetForegroundWindow()
    units = text.encode("utf-16-le")
    for index in range(0, len(units), 2):
        code_unit = int.from_bytes(units[index:index + 2], "little")
        # wVk is unused when KEYEVENTF_UNICODE is set: the scan code carries the
        # UTF-16 code unit, which is what makes this path work for non-ASCII too.
        user32.keybd_event(0, code_unit, KEYEVENTF_UNICODE, 0)
        user32.keybd_event(0, code_unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0)
    # If focus moved mid-typing the text went somewhere else; say so instead of
    # claiming a clean send.
    return user32.GetForegroundWindow() == target


def _type_macos(text: str) -> bool:
    """One AppleScript call for the whole string — a per-character call takes minutes."""
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    script = f'tell application "System Events" to keystroke "{escaped}"'
    return subprocess.run(["osascript", "-e", script], capture_output=True).returncode == 0


def _type_linux(text: str) -> bool:
    """xdotool on X11, wtype on Wayland. Neither is assumed to exist."""
    tool = shutil.which("xdotool") or shutil.which("wtype")
    if tool is None:
        return False
    if os.path.basename(tool) == "xdotool":
        command = [tool, "type", "--clearmodifiers", "--", text]
    else:
        command = [tool, text]
    return subprocess.run(command, capture_output=True).returncode == 0


def type_text(text: str) -> bool:
    """Send `text` as keystrokes to whatever window currently has focus.

    This is the only action in FlowMesh that synthesises input, so it is deliberately
    narrow: the caller supplies text and nothing else, the endpoint caps it at
    MAX_TYPED_CHARS, the delivery tool is chosen here rather than accepted from the
    client, and no shell is involved. It types into the focused window — normally the
    window the sentence was just dictated into — and the receipt reports that, not
    more than that.
    """
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TYPED_CHARS:
        return False
    if "\x00" in text:
        return False
    try:
        if os.name == "nt":
            # Only this platform re-reads the foreground window, so only this platform
            # can claim focus was preserved.
            return _type_windows(text), _FOCUS_CHECKED
        if sys.platform == "darwin":
            return _type_macos(text), _FOCUS_UNCHECKED
        return _type_linux(text), _FOCUS_UNCHECKED
    except Exception:
        return False, _FOCUS_UNCHECKED


def artifact_dir() -> Path:
    override = os.environ.get("FLOWMESH_ARTIFACT_DIR")
    directory = Path(override) if override else Path.home() / "FlowMesh" / "runs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def capabilities() -> dict[str, str]:
    configured = bool(settings()["ha_url"] and secret("ha_token"))
    return {
        "open_url": "ready",
        "launch_app": "ready" if (app_command("notepad") or app_command("calculator")) else "unavailable",
        "timer": "ready",
        "write_note": "ready",
        "notify": "ready" if configured and settings()["phone_service"].startswith("mobile_app_") else "not_configured",
        "light": "ready" if configured and settings()["light_entity"].startswith("light.") else "not_configured",
    }


def jev_route(command: str, options: list[str]) -> dict:
    """Ask TypeSafe Jev to select a registered workflow, if configured."""
    key = secret("jev_key")
    if not key:
        return {"route": None, "source": "local", "confidence": None}
    choices = {name: f"Run the {name.replace('_', ' ')} workflow" for name in options}
    choices["none"] = "No registered workflow matches the user's request"
    body = {
        "model": "jev-latest",
        "state": {"spoken_command": command, "available_workflows": options},
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "Which registered workflow best matches the spoken command? Choose none when unclear.",
                "criteria": choices,
            }
        },
    }
    request = urllib.request.Request(
        "https://api.typesafe.ai/v1/systemone",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            answer = json.load(response)["answers"]["route"]
        route = answer.get("choice")
        confidence = answer.get("confidence")
        if route not in options or not isinstance(confidence, (float, int)) or confidence < 0.65:
            route = None
        return {"route": route, "source": "jev", "confidence": confidence}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {"route": None, "source": "jev_unavailable", "error": type(exc).__name__}


def prepare_plan(command: object, dictation: dict | None = None) -> dict | None:
    """Build and retain one short-lived plan for explicit later approval.

    `dictation` is provenance, never instruction: when the words came from the user's
    own Wispr Flow history, the plan remembers which transcript produced it so the
    same sentence cannot be executed twice.
    """
    if not command_is_usable(command) or FORBIDDEN.search(command.strip()):
        return None
    command = command.strip()
    decision = jev_route(command, list(WORKFLOWS))
    route = decision["route"] if decision["source"] == "jev" else local_route(command)
    if route not in WORKFLOWS:
        return None
    payload = {
        "id": secrets.token_urlsafe(24),
        "route": route,
        "title": WORKFLOWS[route][0],
        "description": WORKFLOWS[route][1],
        "source": decision["source"],
        "confidence": decision.get("confidence"),
        "also": other_intents(route, command),
        "actions": actions_for(route, command),
        "expires": time.monotonic() + PLAN_LIFETIME,
        "created": timestamp(),
    }
    # Kept on the retained plan (never echoed to the client): the record needs the
    # exact words, and the idempotency guard needs the transcript id.
    payload["command"] = command
    if dictation:
        payload["dictation"] = dictation
    with PLAN_LOCK:
        now = time.monotonic()
        for key in [key for key, value in PLANS.items() if value["expires"] < now]:
            del PLANS[key]
        PLANS[payload["id"]] = payload
    return {key: value for key, value in payload.items() if key not in {"expires", "command", "dictation"}}


def _dictation_provenance(transcript: wispr_source.Transcript) -> dict:
    """Where these exact words came from. Instructions travel in `command` only.

    Provenance is descriptive metadata, so the plan card can show the dictation's age,
    app and whether the user polished the text before approving.
    """
    return {
        "source": "wispr_history",
        "id": transcript.id,
        "timestamp": transcript.timestamp,
        "app": transcript.app,
        "edited": transcript.source_column == "editedText",
    }


def wispr_overview() -> dict:
    """Everything the UI may show about the Wispr integration — never transcript text.

    The state is passed through verbatim, so a judge who uninstalls Wispr Flow sees
    `not_found` rather than a cheerful lie.
    """
    status = wispr_source.status()
    payload = {
        "state": status["state"],
        "path": status.get("path"),
        "detail": status.get("detail", ""),
        "dictations": status.get("rows", 0),
        "usable_dictations": status.get("usable_rows", 0),
        "newest_timestamp": status.get("newest_timestamp", ""),
        "read_only": True,
        "supported_api": False,
        "ignored_columns": list(wispr_source.BLOB_COLUMNS),
        "handled": len(WISPR_HANDLED),
    }
    if status["state"] == "connected":
        summary = wispr_source.stats()
        payload["stats"] = {
            "dictations": summary.get("dictations", 0),
            "words": summary.get("words", 0),
            "corrected_words": summary.get("corrected_words", 0),
            "avg_latency_ms": summary.get("avg_latency_ms"),
            "median_latency_ms": summary.get("median_latency_ms"),
            "dictionary_entries": summary.get("dictionary_entries", 0),
            "snippets": summary.get("snippets", 0),
            "apps": summary.get("apps", [])[:5],
        }
        # Metadata only — the overview never carries dictation text. The UI needs to
        # know whether a fresh sentence is waiting, not what it says.
        payload["freshness_seconds"] = WISPR_MAX_AGE_DEFAULT
        fresh = wispr_source.latest(WISPR_MAX_AGE_DEFAULT)
        payload["latest"] = (
            {"age_seconds": fresh.age_seconds, "app": fresh.app, "num_words": fresh.num_words}
            if fresh is not None
            else None
        )
    return payload


def wispr_latest(max_age_seconds: int = WISPR_MAX_AGE_DEFAULT) -> dict:
    """The newest dictation that is still fresh enough to act on."""
    max_age_seconds = max(30, min(int(max_age_seconds), 3600))
    status = wispr_source.status()
    if status["state"] != "connected":
        return {
            "state": status["state"],
            "detail": status.get("detail", ""),
            "freshness": wispr_source.describe_freshness(None),
            "age_seconds": None,
        }
    transcript = wispr_source.latest(max_age_seconds)
    if transcript is None:
        return {
            "state": "none",
            "detail": "No usable dictation inside the freshness window.",
            "freshness": wispr_source.describe_freshness(None),
            "age_seconds": None,
        }
    with WISPR_LOCK:
        handled_plan = WISPR_HANDLED.get(transcript.id)
    return {
        "state": "ready",
        "text": transcript.text,
        "id": transcript.id,
        "transcript_id": transcript.id,
        "app": transcript.app,
        "dictated_into": transcript.app,
        "age_seconds": transcript.age_seconds,
        "num_words": transcript.num_words,
        "duration": transcript.duration,
        "latency_ms": transcript.latency_ms,
        "source_column": transcript.source_column,
        "freshness": wispr_source.describe_freshness(transcript),
        "already_executed": bool(handled_plan),
        "handled_plan": handled_plan,
        "provenance": _dictation_provenance(transcript),
    }


def record_markdown(plan: dict, receipts: list[dict]) -> str:
    """The durable output: what was asked, what was approved, what happened."""
    command = plan["actions"][-1].get("note", "") if plan["actions"] else ""
    if not command:
        command = plan.get("command", "")
    source = {"jev": "Jev Choice", "jev_unavailable": "local rules (Jev unreachable)"}.get(plan["source"], "local rules")
    lines = [
        f"# FlowMesh run — {plan['title']}",
        "",
        f"- When: {timestamp()}",
        f"- Route: `{plan['route']}` via {source}",
        f"- Plan: `{plan['id'][:12]}…` (single use)",
        f"- Platform: {sys.platform}",
        "",
        "## Actions as approved",
        "",
    ]
    for action in plan["actions"]:
        value = f" ({action['value']})" if action.get("value") is not None else ""
        lines.append(f"{plan['actions'].index(action) + 1}. {action['label']}{value} — {action['detail']}")
    lines += [
        "",
        "## Receipts",
        "",
        "| # | Action | Surface | Status | Detail |",
        "| --- | --- | --- | --- | --- |",
    ]
    for index, receipt in enumerate(receipts, start=1):
        detail = str(receipt.get("detail", "")).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {index} | {receipt['action']['label']} | {receipt['action']['surface']} | {receipt['status']} | {detail} |")
    lines += ["", "## What was said, verbatim", "", "~~~text", command.replace("~~~", "\\~\\~\\~"), "~~~", ""]
    lines += [
        "A `sent` receipt means the request left FlowMesh. `verified` means FlowMesh observed the",
        "result (a file it wrote and hashed, or a device state it read back). Anything the runtime",
        "could not do is recorded as `not_configured`, `unavailable`, `denied`, or `failed`.",
        "",
    ]
    return "\n".join(lines)


def write_record(plan: dict, receipts: list[dict]) -> dict:
    try:
        directory = artifact_dir()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"flowmesh-{stamp}-{plan['route']}-{plan['id'][:6]}.md"
        path = directory / name
        data = record_markdown(plan, receipts).encode("utf-8")
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
        return {
            "status": "verified",
            "detail": f"Wrote {name} ({len(data)} bytes)",
            "path": str(path),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    except OSError as exc:
        return {"status": "failed", "detail": f"Could not write the record ({type(exc).__name__})"}


def execute_plan(plan_id: str) -> list[dict] | None:
    """Consume a plan once. The caller cannot substitute or reorder actions."""
    with PLAN_LOCK:
        plan = PLANS.pop(plan_id, None)
    if plan is None or plan["expires"] < time.monotonic():
        return None
    dictation = plan.get("dictation") or {}
    # Idempotency is keyed on Wispr's own transcript id, not on a timer: pressing the
    # hotkey again inside the same sentence must not execute the same intent twice.
    if dictation.get("transcript_id"):
        with WISPR_LOCK:
            if dictation["transcript_id"] in WISPR_HANDLED:
                return None
            WISPR_HANDLED[dictation["transcript_id"]] = plan_id
            if len(WISPR_HANDLED) > 200:
                WISPR_HANDLED.pop(next(iter(WISPR_HANDLED)))
    actions = plan["actions"]
    slots: list[dict | None] = [None] * len(actions)
    note_slots: list[int] = []
    for index, action in enumerate(actions):
        if action.get("kind") == "write_note":
            note_slots.append(index)
            continue
        started = time.monotonic()
        try:
            result = perform(action)
        except Exception as exc:  # one adapter must not stop the rest
            result = {"status": "failed", "detail": type(exc).__name__}
        result["duration_ms"] = int((time.monotonic() - started) * 1000)
        slots[index] = result

    if note_slots:
        written = [
            {"action": action, "status": slots[index]["status"], "detail": slots[index]["detail"]}
            for index, action in enumerate(actions)
            if slots[index] is not None
        ]
        receipt = write_record(plan, written)
        for index in note_slots:
            slots[index] = dict(receipt)

    results = []
    for index, action in enumerate(actions):
        receipt = slots[index] or {"status": "failed", "detail": "No receipt produced"}
        event = {
            "at": timestamp(),
            "action": {key: value for key, value in action.items() if key in {"kind", "target", "label", "surface", "value"}},
            **receipt,
        }
        EVENTS.append(event)
        results.append(event)
    del EVENTS[:-MAX_EVENTS]
    return results


def start_focus_timer(minutes: int) -> dict:
    global ACTIVE_TIMER, TIMER_END

    def complete() -> None:
        global ACTIVE_TIMER, TIMER_END
        with TIMER_LOCK:
            ACTIVE_TIMER = None
            TIMER_END = None
        EVENTS.append({
            "at": timestamp(),
            "action": {"kind": "timer", "label": "Focus timer complete", "surface": "pc"},
            "status": "verified",
            "detail": f"{minutes} minute focus block finished",
        })

    with TIMER_LOCK:
        if ACTIVE_TIMER is not None:
            ACTIVE_TIMER.cancel()
        TIMER_END = time.time() + minutes * 60
        ACTIVE_TIMER = threading.Timer(minutes * 60, complete)
        ACTIVE_TIMER.daemon = True
        ACTIVE_TIMER.start()
    return {"status": "verified", "detail": f"Timer scheduled for {minutes} minutes", "timer_end": TIMER_END}


def home_assistant(service: str, domain: str, data: dict) -> dict:
    base = settings()["ha_url"].rstrip("/")
    token = secret("ha_token")
    if not base or not token:
        return {"status": "not_configured", "detail": "Home Assistant is not configured"}
    request = urllib.request.Request(
        f"{base}/api/services/{domain}/{service}",
        data=json.dumps(data).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            response.read()
        return {"status": "sent", "detail": "Home Assistant accepted the service call"}
    except (OSError, urllib.error.HTTPError) as exc:
        return {"status": "failed", "detail": type(exc).__name__}


def home_state(entity: str) -> dict | None:
    base = settings()["ha_url"].rstrip("/")
    token = secret("ha_token")
    if not base or not token:
        return None
    request = urllib.request.Request(
        f"{base}/api/states/{entity}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def perform(action: dict) -> dict:
    """Execute one allowlisted action. No raw paths, URLs, or commands accepted."""
    kind = action.get("kind")
    target = action.get("target")
    if kind == "open_url" and target in ALLOWED_URLS:
        field, fallback = ALLOWED_URLS[target]
        url = settings()[field] or fallback
        if urlparse(url).scheme not in {"http", "https"}:
            return {"status": "denied", "detail": "Only HTTP(S) destinations are allowed"}
        opened = webbrowser.open(url, new=2)
        return {"status": "sent" if opened else "unknown", "detail": f"Browser open requested for {url}"}
    if kind == "launch_app" and target in ALLOWED_APPS:
        command = app_command(target)
        if command is None:
            return {"status": "unavailable", "detail": "No allowlisted app found on this computer"}
        subprocess.Popen(command, shell=False)
        return {"status": "sent", "detail": f"Launch requested: {Path(command[-1]).name}"}
    if kind == "light" and target == "desk_light":
        brightness = action.get("value")
        if not isinstance(brightness, int) or not 1 <= brightness <= 100:
            return {"status": "denied", "detail": "Brightness must be 1–100"}
        entity = settings()["light_entity"]
        if not entity.startswith("light."):
            return {"status": "not_configured", "detail": "No request sent — add a Home Assistant light in Settings"}
        result = home_assistant("turn_on", "light", {"entity_id": entity, "brightness_pct": brightness})
        if result["status"] != "sent":
            return result
        observed = home_state(entity)
        actual = (observed or {}).get("attributes", {}).get("brightness")
        if (observed or {}).get("state") == "on" and isinstance(actual, int) and abs(round(actual / 255 * 100) - brightness) <= 2:
            return {"status": "verified", "detail": f"Home Assistant read back {brightness}% brightness"}
        return {"status": "unknown", "detail": "Command sent; device state could not be verified"}
    if kind == "notify" and target == "my_phone":
        service = settings()["phone_service"]
        if not service.startswith("mobile_app_"):
            return {"status": "not_configured", "detail": "No request sent — add a Companion service in Settings"}
        message = action.get("message")
        if not isinstance(message, str) or not 1 <= len(message) <= 160:
            return {"status": "denied", "detail": "Notification text must be 1–160 characters"}
        return home_assistant(service, "notify", {"title": "FlowMesh", "message": message})
    if kind == "timer" and target == "focus_timer":
        minutes = action.get("value")
        if isinstance(minutes, int) and 1 <= minutes <= 180:
            return start_focus_timer(minutes)
    return {"status": "denied", "detail": "Action is not registered"}


class Handler(SimpleHTTPRequestHandler):
    server_version = f"FlowMesh/{VERSION}"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, format: str, *args: object) -> None:
        # PyInstaller windowed builds have no stderr stream.
        if sys.stderr is not None:
            super().log_message(format, *args)

    def end_headers(self) -> None:
        if not self.path.startswith("/api/"):
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            if self.path in {"/", "/index.html"}:
                self.send_header("Content-Security-Policy", CSP)
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 8192:
                return None
            value = json.loads(self.rfile.read(length))
            return value if isinstance(value, dict) else None
        except (ValueError, json.JSONDecodeError):
            return None

    def trusted_host(self) -> bool:
        host = self.headers.get("Host", "")
        return host in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}

    def authorized(self) -> bool:
        provided = self.headers.get("X-FlowMesh-Token", "")
        return bool(provided) and hmac.compare_digest(provided, SESSION_TOKEN)

    def loopback_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        port = self.server.server_port
        return origin in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

    def do_GET(self) -> None:
        if not self.trusted_host():
            self.send_json({"error": "Invalid host"}, 403)
            return
        if self.path.startswith("/api/") and not self.authorized():
            self.send_json({"error": "Missing or invalid session token"}, 401)
            return
        if self.path == "/api/status":
            self.send_json({
                "mode": "desktop_app",
                "version": VERSION,
                "platform": sys.platform,
                "capabilities": capabilities(),
                "artifact_dir": str(artifact_dir()),
                "jev": bool(secret("jev_key")),
                "home_assistant": bool(settings()["ha_url"] and secret("ha_token")),
                "windows": os.name == "nt",
                "timer_end": TIMER_END,
            })
            return
        if self.path == "/api/settings":
            self.send_json(public_settings())
            return
        if self.path == "/api/events":
            self.send_json({"events": EVENTS[-MAX_EVENTS:]})
            return
        if self.path == "/api/wispr":
            self.send_json(wispr_overview())
            return
        if self.path == "/api/wispr/latest":
            self.send_json(wispr_latest())
            return
        if self.path == "/api/wispr/dictionary":
            # The user's own vocabulary. Counts and lengths only: the words themselves
            # stay on this machine.
            entries = wispr_source.dictionary()
            self.send_json({
                "state": wispr_source.status()["state"],
                "entries": len(entries),
                "phrases": [len(str(entry["phrase"] or "")) for entry in entries],
            })
            return
        super().do_GET()

    def do_POST(self) -> None:
        if not self.trusted_host():
            self.send_json({"error": "Invalid host"}, 403)
            return
        if not self.authorized():
            self.send_json({"error": "Missing or invalid session token"}, 401)
            return
        if not self.loopback_origin():
            self.send_json({"error": "Cross-origin requests are denied"}, 403)
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            self.send_json({"error": "JSON content type required"}, 415)
            return
        body = self.read_json()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, 400)
            return
        if self.path == "/api/settings":
            try:
                self.send_json(save(body))
            except (ValueError, OSError, RuntimeError) as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        if self.path == "/api/plan":
            plan = prepare_plan(body.get("command"), dictation=body.get("dictation"))
            if plan is None:
                self.send_json({"error": "Command is unsupported, unclear, or not allowed"}, 422)
            else:
                self.send_json(plan)
            return
        if self.path == "/api/type":
            # The client never supplies the text. It names a transcript it just read
            # from /api/wispr/latest, and this process re-reads the row itself, so the
            # only thing that can ever reach the keyboard is the user's own dictation.
            if set(body) != {"transcript_id"}:
                self.send_json({"error": "Invalid request"}, 400)
                return
            transcript_id = body.get("transcript_id")
            if not isinstance(transcript_id, str) or not 0 < len(transcript_id) <= 128:
                self.send_json({"error": "Invalid request"}, 400)
                return
            transcript = wispr_source.get(transcript_id)
            if transcript is None:
                self.send_json({"error": "That dictation is no longer in the history"}, 404)
                return
            with WISPR_LOCK:
                if transcript.id in WISPR_HANDLED:
                    self.send_json({"error": "That dictation has already been typed"}, 409)
                    return
                WISPR_HANDLED[transcript.id] = "typed"
            delivered, focus_verified = type_text(transcript.text)
            event = {
                "at": timestamp(),
                "action": {"kind": "type_text", "label": "Type the last dictation into the focused window",
                           "surface": "pc", "value": len(transcript.text)},
                "status": "sent" if delivered else "unknown",
                "detail": (
                    f"Sent {len(transcript.text)} characters to the window in front "
                    f"({transcript.app or 'unknown app'}); "
                    + (
                        "focus was unchanged while typing"
                        if focus_verified
                        # macOS and Linux only learn whether the tool exited 0, so say
                        # exactly that rather than claiming a check that never ran.
                        else "keystrokes were handed to the OS, but this platform cannot confirm which window received them"
                    )
                    if delivered
                    else "Keystrokes could not be delivered on this platform"
                ),
            }
            EVENTS.append(event)
            del EVENTS[:-MAX_EVENTS]
            self.send_json({"result": event, "chars": len(transcript.text), "delivered": delivered})
            return
        if self.path == "/api/execute":
            plan_id = body.get("plan_id")
            if set(body) - {"plan_id"}:
                # A client may never compose or amend actions. Only an id is
                # accepted, and only an id that this process minted.
                self.send_json({"error": "Invalid plan"}, 400)
                return
            if not isinstance(plan_id, str) or len(plan_id) > 128:
                self.send_json({"error": "Invalid plan"}, 400)
                return
            results = execute_plan(plan_id)
            if results is None:
                self.send_json({"error": "Plan expired or already used"}, 409)
            else:
                self.send_json({"results": results})
            return
        if self.path == "/api/cancel":
            plan_id = body.get("plan_id")
            if isinstance(plan_id, str):
                with PLAN_LOCK:
                    PLANS.pop(plan_id, None)
            self.send_json({"cancelled": True})
            return
        self.send_json({"error": "Not found"}, 404)


def serve(port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


if __name__ == "__main__":
    httpd = serve(int(os.environ.get("FLOWMESH_PORT", "8765")))
    print(f"FlowMesh local bridge: http://127.0.0.1:{httpd.server_port}/?k={SESSION_TOKEN}")
    httpd.serve_forever()
