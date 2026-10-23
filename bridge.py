"""Local FlowMesh runtime. Plans, approvals, and run records are owned here.

Threat model: the browser UI and any other local process. Every /api call needs
the per-launch session token that only the desktop window was given, plus the
loopback Host and (when present) a matching Origin. Plans are server-owned,
expire, and are consumed once; the client can never submit an action payload.
"""

from __future__ import annotations

import hashlib
import html
import hmac
import json
import os
import re
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
from urllib.parse import unquote, urlparse

from flowmesh_config import VERSION, public_settings, save, secret, settings
from planner import FORBIDDEN, WORKFLOWS, actions_for, command_is_usable, local_route, other_intents
import atexit
import wispr_source
from wispr_account import ACCOUNT, CALLBACK_PATH, WisprAccountError
from urllib.parse import parse_qs
from mcp_client import McpError
import llm_planner
from mcp_registry import MANAGER, public_tool
from wake import MANAGER as WAKE
from agents import MANAGER as AGENTS, AgentError, agent_by_id, agent_phrase, public_catalog, with_handoff
import mcp_presets

# How a connector failure maps onto HTTP. 401 is deliberately absent: it means "bad
# FlowMesh session token" everywhere else in this API, and must not also mean
# "your Wispr sign-in lapsed".
ACCOUNT_HTTP = {"unavailable": 502, "bad_response": 502, "expired": 409, "denied": 403,
                "rate_limited": 429, "unsupported": 422, "empty": 422, "bad_request": 400}

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


RUN_NAME = re.compile(r"flowmesh-[A-Za-z0-9_\-]{1,100}\.md")
MAX_RECORD_BYTES = 300_000
MAX_RUNS_LISTED = 100


def list_runs() -> list[dict]:
    """Run records FlowMesh itself wrote, newest first. Names only ever come from this listing."""
    entries = []
    for path in artifact_dir().glob("flowmesh-*.md"):
        if not RUN_NAME.fullmatch(path.name) or not path.is_file():
            continue
        stat = path.stat()
        title = ""
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                first = handle.readline(200).strip()
            title = first.removeprefix("# FlowMesh run — ").removeprefix("# ").strip()[:80]
        except OSError:
            pass
        entries.append({"name": path.name, "bytes": stat.st_size, "title": title,
                        "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds")})
    entries.sort(key=lambda e: e["modified"], reverse=True)
    return entries[:MAX_RUNS_LISTED]


def read_run(name: str) -> dict | None:
    """One record by name. The name must match the generated pattern and resolve inside the
    artifact directory, so no path, traversal or other file can ever be read through this."""
    if not isinstance(name, str) or not RUN_NAME.fullmatch(name):
        return None
    directory = artifact_dir().resolve()
    path = (directory / name).resolve()
    if path.parent != directory or not path.is_file():
        return None
    try:
        data = path.read_bytes()[:MAX_RECORD_BYTES]
    except OSError:
        return None
    return {"name": name, "text": data.decode("utf-8", "replace"), "truncated": path.stat().st_size > MAX_RECORD_BYTES}


def capabilities() -> dict[str, str]:
    configured = bool(settings()["ha_url"] and secret("ha_token"))
    return {
        "open_url": "ready",
        "launch_app": "ready" if (app_command("notepad") or app_command("calculator")) else "unavailable",
        "timer": "ready",
        "write_note": "ready",
        "notify": "ready" if configured and settings()["phone_service"].startswith("mobile_app_") else "not_configured",
        "light": "ready" if configured and settings()["light_entity"].startswith("light.") else "not_configured",
        "tools": "ready" if any(s.get("enabled") for s in MANAGER._servers()) else "not_configured",
        "agents": "ready" if agents_enabled() and any(a.get("installed") for a in AGENTS.detect()["agents"].values()) else "not_configured",
        "model": "ready" if llm_planner.configured() else "not_configured",
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


def prepare_plan(command: object, dictation: dict | None = None, forced_route: str | None = None) -> dict | None:
    """Build and retain one short-lived plan for explicit later approval.

    `dictation` is provenance, never instruction: when the words came from the user's
    own Wispr Flow history, the plan remembers which transcript produced it so the
    same sentence cannot be executed twice.
    """
    if not command_is_usable(command) or FORBIDDEN.search(command.strip()):
        return None
    command = command.strip()
    if forced_route in WORKFLOWS:
        # A model chose this routine; the actions below are still produced by the fixed
        # planner, so a model can pick a routine but never shape its effects.
        decision = {"route": forced_route, "source": "llm", "confidence": None}
        route = forced_route
    else:
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


def plan_command(command: object, dictation: dict | None = None, context: object = "") -> tuple[dict | None, str, int]:
    """Plan a sentence: (plan, message, http status).

    With a model configured it chooses between a routine and tool calls; its answer is
    only a proposal and is re-validated. Without one, the deterministic rules apply
    exactly as before. A model outage falls back to those rules and says so.
    """
    generic = "Command is unsupported, unclear, or not allowed"
    if not command_is_usable(command) or FORBIDDEN.search(command.strip()):
        return None, generic, 422
    command = command.strip()
    phrase = agent_phrase(command) if agents_enabled() else None
    if phrase is not None:
        # "ask codex to fix the failing test": the agent and the task come from the sentence; the
        # folder and mode come from your saved defaults and are shown in the plan before anything runs.
        agent_id, task = phrase
        config = AGENTS.config()
        agent = agent_by_id(AGENTS.catalog, agent_id)
        if agent is None:
            return None, "That coding agent is not supported.", 422
        mode = config["default_mode"] if any(m["id"] == config["default_mode"] for m in agent["modes"]) else (
            "edit" if any(m["id"] == "edit" for m in agent["modes"]) else agent["modes"][0]["id"])
        try:
            return prepare_agent_plan(agent_id, config["default_workspace"], mode, task, command=command, source="agent"), "", 200
        except AgentError as exc:
            return None, exc.message, 422
    notice = ""
    if llm_planner.configured():
        tools = MANAGER.catalog()["tools"]
        routines = {name: f"{title}. {text}" for name, (title, text) in WORKFLOWS.items()}
        try:
            decision = llm_planner.decide(command, routines, tools, context if isinstance(context, str) else "")
        except llm_planner.LlmError as exc:
            decision, notice = None, exc.message
        if decision is not None:
            if decision["kind"] == "calls":
                try:
                    return prepare_tool_plan(decision["calls"], command, source="llm"), "", 200
                except ValueError as exc:
                    return None, f"The model proposed a call FlowMesh rejected: {exc}", 422
            if decision["kind"] == "routine":
                plan = prepare_plan(command, dictation, forced_route=decision["routine"])
                return (plan, "", 200) if plan else (None, generic, 422)
            return None, decision["reply"] or generic, 422
    plan = prepare_plan(command, dictation)
    if plan is None:
        return None, (f"{notice} " if notice else "") + generic, 502 if notice else 422
    if notice:
        plan["notice"] = f"{notice} Planned with local rules instead."
    return plan, "", 200


def wake_enabled() -> bool:
    return os.environ.get("FLOWMESH_WAKE", "").lower() != "off"


def agents_enabled() -> bool:
    return os.environ.get("FLOWMESH_AGENTS", "").lower() != "off"


def register_agent_plan(actions: list[dict], title: str, description: str, command: str, source: str, note: str) -> dict:
    """Store a plan made of agent_run steps (plus the run record). Risk is the highest step's."""
    for action in actions:
        agent = agent_by_id(AGENTS.catalog, action["agent"])
        mode = next(m for m in agent["modes"] if m["id"] == action["mode"])
        action["about"] = mode["about"]
        action["command"] = agents_preview(agent, mode, action["workspace_path"])
    steps = [*actions, {"kind": "write_note", "target": "run_record", "label": "Save run record",
                        "detail": "Markdown file in your FlowMesh folder, including every agent's output", "surface": "pc",
                        "note": command or note}]
    risk = "danger" if any(a["risk"] == "danger" for a in actions) else "write" if any(a["risk"] == "write" for a in actions) else "read"
    payload = {
        "id": secrets.token_urlsafe(24), "route": "agent", "title": title, "description": description,
        "source": source, "confidence": None, "also": [], "actions": steps, "risk": risk,
        "needs_confirm": risk == "danger", "auto_run": False,
        "expires": time.monotonic() + PLAN_LIFETIME, "created": timestamp(), "command": command or actions[0]["prompt"],
    }
    with PLAN_LOCK:
        now = time.monotonic()
        for key in [key for key, value in PLANS.items() if value["expires"] < now]:
            del PLANS[key]
        PLANS[payload["id"]] = payload
    return {key: value for key, value in payload.items() if key not in {"expires", "command", "dictation"}}


def prepare_agent_plan(agent_id: object, workspace_id: object, mode_id: object, prompt: object,
                       command: str = "", source: str = "builder") -> dict:
    """A plan whose one effect is a coding agent working in a project folder. Raises AgentError.

    The risk is the agent's permission mode (plan = read, edit = write, anything that bypasses
    the agent's own approvals = danger), chosen by FlowMesh and never by a model.
    """
    action = AGENTS.plan_action(agent_id, workspace_id, mode_id, prompt)
    agent = agent_by_id(AGENTS.catalog, action["agent"])
    mode = next(m for m in agent["modes"] if m["id"] == action["mode"])
    description = f"{action['agent_label']} will work in {action['workspace_path']} ({mode['label'].lower()}). {mode['about']}"
    return register_agent_plan([action], "Coding task", description, command, source,
                               f"(built on the Code page: {action['prompt'][:200]})")


RELAY_TITLES = {"review": "Work, then review", "chain": "Plan, build, review", "compare": "Compare agents"}


def prepare_relay_plan(kind: object, workspace_id: object, prompt: object, agent_ids: object, mode_id: object = "edit",
                       command: str = "", source: str = "builder") -> dict:
    """Several agents in one plan: each step is a normal, separately validated coding task, and a later
    step receives the previous step's output as quoted, untrusted data. Raises AgentError."""
    actions = AGENTS.plan_relay(kind, workspace_id, prompt, agent_ids, mode_id)
    steps = "; ".join(f"{i + 1}. {a['agent_label']} ({a['role']}, {a['mode_label'].lower()})" for i, a in enumerate(actions))
    description = (f"{len(actions)} agents in {actions[0]['workspace_path']}: {steps}. "
                   + ("Each answers on its own, read-only." if kind == "compare" else
                      "Each step starts only if the one before it finished cleanly, and sees its output as untrusted text."))
    return register_agent_plan(actions, RELAY_TITLES[kind], description, command, source,
                               f"(built on the Code page: {actions[0]['prompt'][:200]})")


def agents_preview(agent: dict, mode: dict, folder: str) -> str:
    """The command line that will run, with the task shown as a placeholder (it goes on stdin or a file)."""
    from pathlib import Path as _Path

    args, stdin = agents_mod_build(agent, mode, _Path(folder))
    shown = " ".join(f'"{a}"' if " " in a else a for a in [agent["command"], *args])
    return shown + ("   (task sent on stdin)" if stdin is not None else "")


def agents_mod_build(agent: dict, mode: dict, folder):
    import agents as agents_module

    return agents_module.build_command(agent, mode, folder, "<task>", "<task file>")


def prepare_tool_plan(calls: object, command: str = "", source: str = "builder", confidence: float | None = None,
                      note: str = "") -> dict:
    """A plan whose actions are MCP tool calls. Raises ValueError with a sentence.

    Every call has already been checked against its tool's own schema and given a
    FlowMesh-derived risk level. The client later references the plan by id only, so
    the arguments reviewed on screen are the arguments that run.
    """
    actions = MANAGER.plan_actions(calls)
    count = len(actions)
    worst = "danger" if any(a["risk"] == "danger" for a in actions) else "write" if any(a["risk"] == "write" for a in actions) else "read"
    auto_run = all(a["auto_ok"] for a in actions)
    if not auto_run:
        actions.append({"kind": "write_note", "target": "run_record", "label": "Save run record",
                        "detail": "Markdown file in your FlowMesh folder, including each tool's output", "surface": "pc",
                        "note": command or "(built in the tool builder, not dictated)"})
    payload = {
        "id": secrets.token_urlsafe(24),
        "route": "tools",
        "title": "Tool run" if count > 1 else "Tool call",
        "description": f"{count} call{'s' if count != 1 else ''}, highest risk: {worst}. Each runs once, exactly as shown.",
        "source": source,
        "confidence": confidence,
        "also": [],
        "actions": actions,
        "risk": worst,
        "needs_confirm": worst == "danger",
        "auto_run": auto_run,
        "expires": time.monotonic() + PLAN_LIFETIME,
        "created": timestamp(),
        "command": command or note,
    }
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
    source = {"jev": "Jev Choice", "jev_unavailable": "local rules (Jev unreachable)", "builder": "the tool builder",
              "llm": "a language model's proposal, checked against each tool's schema"}.get(plan["source"], "local rules")
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
    outputs = [(i, r) for i, r in enumerate(receipts, start=1) if r.get("output")]
    if outputs:
        lines += ["", "## Tool output (untrusted text from the tool, shown as received)", ""]
        for index, receipt in outputs:
            lines += [f"### {index}. {receipt['action']['label']}", "", "~~~text",
                      str(receipt["output"]).replace("~~~", "\\~\\~\\~"), "~~~", ""]
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
        source_index = action.get("handoff_from")
        if isinstance(source_index, int) and 0 <= source_index < index:
            earlier = slots[source_index]
            if earlier is None or earlier.get("status") != "returned":
                slots[index] = {"status": "denied", "detail": "Skipped: the step before it did not finish cleanly.", "duration_ms": 0}
                continue
            action = with_handoff(action, actions[source_index].get("label", "the previous step"), earlier.get("output", ""))
        try:
            result = perform(action)
        except Exception as exc:  # one adapter must not stop the rest
            result = {"status": "failed", "detail": type(exc).__name__}
        result["duration_ms"] = int((time.monotonic() - started) * 1000)
        slots[index] = result

    if note_slots:
        written = [
            {"action": action, "status": slots[index]["status"], "detail": slots[index]["detail"],
             "output": slots[index].get("output", "")}
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
            "action": {key: value for key, value in action.items() if key in {"kind", "target", "label", "surface", "value", "risk"}},
            **receipt,
        }
        # The caller gets the full output. The in-memory log keeps a short head only, so
        # 200 events can never hold 200 x 20 kB of third-party text.
        logged = {key: value for key, value in event.items() if key != "output"}
        if event.get("output"):
            logged["output_preview"] = event["output"][:600]
            logged["output_chars"] = len(event["output"])
        EVENTS.append(logged)
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


def perform_mcp(action: dict) -> dict:
    """Run one approved MCP call and report only what FlowMesh actually knows.

    A tool answering is not proof its effect happened, so a good answer is `returned`,
    never `verified`. A timeout is `unknown`: the call may or may not have landed.
    """
    server, tool, arguments = action.get("server"), action.get("tool"), action.get("arguments")
    if not isinstance(server, str) or not isinstance(tool, str) or not isinstance(arguments, dict):
        return {"status": "denied", "detail": "Tool call is malformed"}
    try:
        result = MANAGER.call(server, tool, arguments)
    except McpError as exc:
        if exc.kind == "timeout":
            return {"status": "unknown", "detail": exc.message + " The effect may or may not have happened."}
        gone = exc.kind in {"unavailable", "disabled", "unknown_server"}
        return {"status": "unavailable" if gone else "failed", "detail": exc.message}
    suffix = " Output was truncated." if result["truncated"] else ""
    if result["is_error"]:
        return {"status": "failed", "detail": "The tool reported an error." + suffix, "output": result["text"]}
    return {"status": "returned",
            "detail": "The tool returned a result. FlowMesh did not independently verify its effect." + suffix,
            "output": result["text"]}


def perform(action: dict) -> dict:
    """Execute one allowlisted action. No raw paths, URLs, or commands accepted."""
    kind = action.get("kind")
    target = action.get("target")
    if kind == "agent_run":
        return AGENTS.run(action) if agents_enabled() else {"status": "denied", "detail": "Coding agents are disabled on this install (FLOWMESH_AGENTS=off)."}
    if kind == "mcp_call":
        return perform_mcp(action)
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
            # The sign-in callback carries a one-time code in its query string; never log it.
            safe = tuple(a.split("?", 1)[0] + (" ?[redacted]" if "?" in a else "") if isinstance(a, str) and CALLBACK_PATH in a else a for a in args)
            super().log_message(format, *safe)

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

    def wake_post(self, body: dict) -> None:
        """Turn the wake word on or off, and set the Wispr shortcut it presses."""
        if not wake_enabled():
            self.send_json({"error": "The wake word is disabled on this install (FLOWMESH_WAKE=off).", "kind": "disabled"}, 403)
            return
        allowed = {"enabled", "acknowledged", "summon", "hold_s", "test_summon"}
        if set(body) - allowed or any(key in body and not isinstance(body[key], bool) for key in ("enabled", "acknowledged", "test_summon")):
            self.send_json({"error": "Invalid request"}, 400)
            return
        try:
            if "summon" in body or "hold_s" in body:
                WAKE.set_config({key: body[key] for key in ("summon", "hold_s") if key in body})
            if body.get("test_summon"):
                if not WAKE.config()["summon"]:
                    self.send_json({"error": "Set a Wispr shortcut first."}, 422)
                    return
                # Give the person three seconds to click into the window the shortcut should reach.
                threading.Timer(3.0, WAKE.summon).start()
            if body.get("enabled") is True:
                if body.get("acknowledged") is not True:
                    self.send_json({"error": "The wake word keeps your microphone open while it is on. Acknowledge it first.",
                                    "needs_acknowledgement": True}, 428)
                    return
                WAKE.start()
            elif body.get("enabled") is False:
                WAKE.stop()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 422)
            return
        self.send_json({"enabled": True, **WAKE.status()})

    def agents_post(self, body: dict) -> None:
        """Project folders, defaults, coding-task plans, cancel and sign-in."""
        path = self.path
        if not agents_enabled():
            self.send_json({"error": "Coding agents are disabled on this install (FLOWMESH_AGENTS=off).", "kind": "disabled"}, 403)
            return
        try:
            if path == "/api/agents/workspaces":
                if body.get("acknowledged") is not True:
                    self.send_json({"error": "A coding agent can read and change everything in a project folder. Acknowledge it first.",
                                    "needs_acknowledgement": True}, 428)
                    return
                self.send_json({"workspace": AGENTS.upsert_workspace({k: body.get(k) for k in ("id", "label", "path")})})
            elif path == "/api/agents/workspaces/remove":
                if not isinstance(body.get("id"), str) or not AGENTS.remove_workspace(body["id"]):
                    self.send_json({"error": "No such project folder"}, 404)
                else:
                    self.send_json({"removed": True})
            elif path == "/api/agents/defaults":
                self.send_json({"config": AGENTS.set_defaults(body)})
            elif path == "/api/agents/refresh":
                self.send_json(AGENTS.detect(refresh=True))
            elif path == "/api/agents/plan":
                if set(body) - {"agent", "workspace", "mode", "prompt"}:
                    self.send_json({"error": "Invalid request"}, 400)
                    return
                self.send_json(prepare_agent_plan(body.get("agent"), body.get("workspace"), body.get("mode"), body.get("prompt")))
            elif path == "/api/agents/relay":
                if set(body) - {"kind", "workspace", "prompt", "agents", "mode"}:
                    self.send_json({"error": "Invalid request"}, 400)
                    return
                self.send_json(prepare_relay_plan(body.get("kind"), body.get("workspace"), body.get("prompt"), body.get("agents"),
                                                  body.get("mode", "edit")))
            elif path == "/api/agents/signin":
                self.send_json(AGENTS.open_login(body.get("agent")))
            elif path.startswith("/api/agents/runs/") and path.endswith("/cancel"):
                run_id = unquote(path[len("/api/agents/runs/"):-len("/cancel")])
                if AGENTS.cancel(run_id):
                    self.send_json({"cancelled": True})
                else:
                    self.send_json({"error": "That run is not running"}, 404)
            else:
                self.send_json({"error": "Not found"}, 404)
        except AgentError as exc:
            self.send_json({"error": exc.message, "kind": exc.kind}, 422)

    def mcp_post(self, body: dict) -> None:
        """Server registry and tool plans. Needs the session token like everything else."""
        path = self.path
        try:
            if path == "/api/mcp/servers":
                server = body.get("server")
                existing = MANAGER.get(server.get("id")) if isinstance(server, dict) else None
                changes_program = isinstance(server, dict) and server.get("transport") == "stdio" and (
                    existing is None or existing.get("command") != server.get("command") or existing.get("args") != server.get("args"))
                if isinstance(server, dict) and server.get("transport") == "stdio" and os.environ.get("FLOWMESH_MCP_STDIO", "").lower() == "off":
                    self.send_json({"error": "Local-program MCP servers are disabled on this install (FLOWMESH_MCP_STDIO=off).", "kind": "disabled"}, 403)
                    return
                if changes_program and body.get("acknowledged") is not True:
                    self.send_json({"error": "Adding or changing a stdio server runs a program on this computer. Acknowledge it first.",
                                    "needs_acknowledgement": True}, 428)
                    return
                self.send_json({"server": MANAGER.upsert(server)})
            elif path == "/api/mcp/servers/remove":
                if not isinstance(body.get("id"), str) or not MANAGER.remove(body["id"]):
                    self.send_json({"error": "No such server"}, 404)
                else:
                    self.send_json({"removed": True})
            elif path == "/api/mcp/servers/test":
                if not isinstance(body.get("id"), str):
                    self.send_json({"error": "Invalid request"}, 400)
                    return
                self.send_json(MANAGER.test(body["id"]))
            elif path == "/api/mcp/plan":
                if set(body) - {"calls", "note"}:
                    self.send_json({"error": "Invalid request"}, 400)
                    return
                note = body.get("note") if isinstance(body.get("note"), str) else ""
                self.send_json(prepare_tool_plan(body.get("calls"), note=note[:500]))
            else:
                self.send_json({"error": "Not found"}, 404)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 422)
        except McpError as exc:
            self.send_json({"error": exc.message, "kind": exc.kind}, 502)

    def callback_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}{CALLBACK_PATH}"

    def wispr_callback(self) -> None:
        """Where Wispr's page sends the browser back. Unauthenticated by necessity: it is
        protected by the one-time, unguessable `state` that only a sign-in started from this
        app holds. It never reveals tokens, only a sentence."""
        query = parse_qs(urlparse(self.path).query)
        first = lambda key: (query.get(key) or [""])[0]
        ok, message = ACCOUNT.complete(first("code"), first("state"), first("error"))
        page = (
            "<!doctype html><meta charset=utf-8><title>FlowMesh</title>"
            "<body style=\"font:16px system-ui;background:#080e0c;color:#e9f0e5;display:grid;place-items:center;height:100vh;margin:0\">"
            f"<main style=\"max-width:30em;padding:2em;text-align:center\"><h1 style=\"font-weight:500\">{'Connected' if ok else 'Not connected'}</h1>"
            f"<p>{html.escape(message)}</p></main></body>"
        ).encode()
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
        self.end_headers()
        self.wfile.write(page)

    def account_call(self, action) -> None:
        try:
            self.send_json(action())
        except WisprAccountError as exc:
            self.send_json({"error": exc.message, "kind": exc.kind}, ACCOUNT_HTTP.get(exc.kind, 502))

    def read_raw_body(self) -> None:
        """Consume the request body up front, so an early 401/403/415 never leaves
        unread bytes on the socket (which resets the client's connection mid-send)."""
        self._raw = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        limit = 40_000 if self.path.startswith(("/api/mcp/", "/api/agents/")) else 8192
        if 0 < length < limit:
            self._raw = self.rfile.read(length)
        elif length >= limit:
            self.close_connection = True  # refuse to read an oversized body at all

    def read_json(self) -> dict | None:
        try:
            if not getattr(self, "_raw", None):
                return None
            value = json.loads(self._raw)
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
        if urlparse(self.path).path == CALLBACK_PATH:
            self.wispr_callback()
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
        if self.path == "/api/wake":
            self.send_json({"enabled": wake_enabled(), **WAKE.status()})
            return
        if self.path == "/api/agents":
            self.send_json({"enabled": agents_enabled(), "catalog": public_catalog(AGENTS.catalog), "config": AGENTS.config(),
                            "detection": AGENTS.detect()})
            return
        if self.path.startswith("/api/agents/runs/"):
            view = AGENTS.run_view(unquote(self.path[len("/api/agents/runs/"):]))
            self.send_json(view if view is not None else {"error": "No such run"}, 200 if view is not None else 404)
            return
        if self.path == "/api/runs":
            self.send_json({"runs": list_runs()})
            return
        if self.path.startswith("/api/runs/"):
            record = read_run(unquote(self.path[len("/api/runs/"):]))
            self.send_json(record if record is not None else {"error": "No such record"}, 200 if record is not None else 404)
            return
        if self.path == "/api/mcp/servers":
            self.send_json({"servers": MANAGER.list_servers(), "limit": 20})
            return
        if self.path == "/api/mcp/tools":
            self.send_json(MANAGER.catalog())
            return
        if self.path == "/api/mcp/presets":
            self.send_json({"presets": mcp_presets.PRESETS})
            return
        if self.path == "/api/wispr/account":
            ACCOUNT.prefetch(self.callback_url())
            self.send_json(ACCOUNT.status())
            return
        if self.path == "/api/wispr/account/notes":
            self.account_call(lambda: {"notes": ACCOUNT.list_notes()})
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
        self.read_raw_body()
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
            plan, message, status = plan_command(body.get("command"), body.get("dictation"), body.get("context", ""))
            self.send_json(plan if plan is not None else {"error": message}, status)
            return
        if self.path.startswith("/api/mcp/"):
            self.mcp_post(body)
            return
        if self.path == "/api/wake":
            self.wake_post(body)
            return
        if self.path.startswith("/api/agents/"):
            self.agents_post(body)
            return
        if self.path == "/api/wispr/account/connect":
            self.account_call(lambda: ACCOUNT.begin(self.callback_url()))
            return
        if self.path == "/api/wispr/account/poll":
            self.account_call(ACCOUNT.poll)
            return
        if self.path == "/api/wispr/account/disconnect":
            self.account_call(ACCOUNT.disconnect)
            return
        if self.path == "/api/wispr/account/note":
            # Only an id is accepted; the text is fetched here, never supplied.
            if set(body) != {"note_id"}:
                self.send_json({"error": "Invalid request"}, 400)
                return
            self.account_call(lambda: ACCOUNT.get_note(body.get("note_id")))
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
            if set(body) - {"plan_id", "confirm"}:
                # A client may never compose or amend actions. Only an id (and the
                # person's explicit confirmation) is accepted, and only an id that
                # this process minted.
                self.send_json({"error": "Invalid plan"}, 400)
                return
            if not isinstance(plan_id, str) or len(plan_id) > 128 or not isinstance(body.get("confirm", False), bool):
                self.send_json({"error": "Invalid plan"}, 400)
                return
            with PLAN_LOCK:
                pending = PLANS.get(plan_id)
            if pending and pending.get("needs_confirm") and body.get("confirm") is not True:
                # The plan stays alive: confirming is a second, deliberate gesture.
                self.send_json({"error": "This plan can change or destroy things. Confirm it explicitly.", "needs_confirm": True}, 428)
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


# Stdio MCP servers are child processes; never leave them running after FlowMesh exits.
atexit.register(MANAGER.close_all)
atexit.register(AGENTS.close_all)
atexit.register(WAKE.stop)


def serve(port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


if __name__ == "__main__":
    httpd = serve(int(os.environ.get("FLOWMESH_PORT", "8765")))
    print(f"FlowMesh local bridge: http://127.0.0.1:{httpd.server_port}/?k={SESSION_TOKEN}")
    httpd.serve_forever()
