"""Local FlowMesh runtime. Plans and approvals are owned by this process."""

from __future__ import annotations

import json
import os
import secrets
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

from flowmesh_config import public_settings, save, secret, settings
from planner import FORBIDDEN, WORKFLOWS, actions_for, local_route

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
DIST = ROOT / "dist"
PORT = int(os.environ.get("FLOWMESH_PORT", "8765"))

ALLOWED_URLS = {
    "project_board": os.environ.get("FLOWMESH_BOARD_URL", "https://github.com/HamzaShaikh-source/flowmesh/issues"),
    "documentation": os.environ.get("FLOWMESH_DOCS_URL", "https://docs.python.org/3/"),
}
ALLOWED_APPS = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
}
EVENTS: list[dict] = []
PLANS: dict[str, dict] = {}
PLAN_LOCK = threading.Lock()
PLAN_LIFETIME = 300
TIMER_LOCK = threading.Lock()
ACTIVE_TIMER: threading.Timer | None = None
TIMER_END: float | None = None


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def prepare_plan(command: str) -> dict | None:
    """Build and retain one short-lived plan for explicit later approval."""
    if not isinstance(command, str) or not 1 <= len(command.strip()) <= 1000 or FORBIDDEN.search(command):
        return None
    command = command.strip()
    decision = jev_route(command, list(WORKFLOWS))
    if decision["source"] == "jev":
        route = decision["route"]
    else:
        route = local_route(command)
    if route not in WORKFLOWS:
        return None
    title, description = WORKFLOWS[route]
    plan = {
        "id": secrets.token_urlsafe(24),
        "route": route,
        "title": title,
        "description": description,
        "source": decision["source"],
        "confidence": decision.get("confidence"),
        "actions": actions_for(route, command),
        "expires": time.monotonic() + PLAN_LIFETIME,
    }
    with PLAN_LOCK:
        now = time.monotonic()
        for key in [key for key, value in PLANS.items() if value["expires"] < now]:
            del PLANS[key]
        PLANS[plan["id"]] = plan
    return {key: value for key, value in plan.items() if key != "expires"}


def execute_plan(plan_id: str) -> list[dict] | None:
    """Consume a plan once; the caller cannot substitute an action payload."""
    with PLAN_LOCK:
        plan = PLANS.pop(plan_id, None)
    if plan is None or plan["expires"] < time.monotonic():
        return None
    results = []
    for action in plan["actions"]:
        try:
            result = perform(action)
        except OSError as exc:
            result = {"status": "failed", "detail": type(exc).__name__}
        event = {"at": timestamp(), "action": {k: v for k, v in action.items() if k in {"kind", "target", "value", "label", "surface"}}, **result}
        EVENTS.append(event)
        results.append(event)
    return results


def start_focus_timer(minutes: int) -> dict:
    global ACTIVE_TIMER, TIMER_END

    def complete() -> None:
        global ACTIVE_TIMER, TIMER_END
        with TIMER_LOCK:
            ACTIVE_TIMER = None
            TIMER_END = None
        EVENTS.append({"at": timestamp(), "action": {"kind": "timer", "label": "Focus timer complete", "surface": "pc"}, "status": "verified", "detail": f"{minutes} minute focus block finished"})

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
        config = settings()
        url = config["board_url" if target == "project_board" else "docs_url"]
        if urlparse(url).scheme not in {"http", "https"}:
            return {"status": "denied", "detail": "Only HTTP(S) destinations are allowed"}
        opened = webbrowser.open(url, new=2)
        return {"status": "sent" if opened else "unknown", "detail": "Browser open requested"}
    if kind == "launch_app" and target in ALLOWED_APPS and os.name == "nt":
        subprocess.Popen([ALLOWED_APPS[target]], shell=False)
        return {"status": "sent", "detail": "Windows launch requested"}
    if kind == "light" and target == "desk_light":
        brightness = action.get("value")
        if not isinstance(brightness, int) or not 1 <= brightness <= 100:
            return {"status": "denied", "detail": "Brightness must be 1–100"}
        entity = settings()["light_entity"]
        if not entity.startswith("light."):
            return {"status": "not_configured", "detail": "Connect a Home Assistant light in settings"}
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
            return {"status": "not_configured", "detail": "Connect a Companion phone in settings"}
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
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def log_message(self, format: str, *args: object) -> None:
        # PyInstaller windowed builds have no stderr stream.
        if sys.stderr is not None:
            super().log_message(format, *args)

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

    def do_GET(self) -> None:
        if not self.trusted_host():
            self.send_json({"error": "Invalid host"}, 403)
            return
        if self.path == "/api/status":
            self.send_json({
                "mode": "desktop_app",
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
            self.send_json({"events": EVENTS[-100:]})
            return
        if self.path == "/":
            self.path = "/app.html"
        super().do_GET()

    def do_POST(self) -> None:
        if not self.trusted_host():
            self.send_json({"error": "Invalid host"}, 403)
            return
        origin = self.headers.get("Origin")
        port = self.server.server_port
        if origin and origin not in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}:
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
            command = body.get("command")
            plan = prepare_plan(command)
            if plan is None:
                self.send_json({"error": "Command is unsupported or needs clarification"}, 422)
            else:
                self.send_json(plan)
            return
        if self.path == "/api/execute":
            plan_id = body.get("plan_id")
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

    def trusted_host(self) -> bool:
        host = self.headers.get("Host", "")
        return host in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}


if __name__ == "__main__":
    print(f"FlowMesh local bridge: http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
