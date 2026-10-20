"""Deterministic, reviewable plans. The web edition mirrors this file exactly.

`web/core.js` is a line-for-line port. `tests/test_parity.py` fails if the two
produce different plans for the shared fixtures, so a change here must be made
there too.
"""

from __future__ import annotations

import re

WORKFLOWS = {
    "focus": ("Deep focus", "One uninterrupted block, with the usual distractions handled."),
    "meeting": ("Meeting reset", "Capture the follow-up while it is still fresh."),
    "research": ("Research sprint", "References open, reading time bounded."),
    "capture": ("Quick capture", "File the thought before it disappears."),
}

DEFAULTS = {"focus": 45, "research": 25}
BRIGHTNESS = {"focus": 30, "meeting": 70, "research": 55}

# Destructive, payment, secret, and physical-safety vocabulary. These never
# become a plan; the bridge answers 422 before anything is scheduled.
FORBIDDEN_WORDS = [
    "delete", "erase", "wipe", "unlock", "purchase", "buy", "pay", "refund",
    "transfer", "password", "credentials", "medication", "oven", "door",
    "alarm", "format disk",
]
FORBIDDEN = re.compile(r"\b(" + "|".join(re.escape(word) for word in FORBIDDEN_WORDS) + r")\b", re.I)

CAPTURE_PREFIX = re.compile(
    r"^\s*(?:capture|note down|remember(?: that)?|jot(?: down)?|make a note|save a note|add a note|note that)\b[\s:,.\-]*",
    re.I,
)
MEETING = re.compile(r"\b(meeting|follow.?up|call ended|standup|debrief|sync)\b", re.I)
RESEARCH = re.compile(r"\b(research|reading|documentation|docs|study|paper|spec)\b", re.I)
FOCUS = re.compile(r"\b(focus|deep work|work session|timer|project board|start working|block)\b", re.I)
MINUTES = re.compile(r"\b(\d{1,3})[\s-]*(?:minutes?|mins?)\b", re.I)
PERCENT = re.compile(r"\b(\d{1,3})\s*(?:%|percent\b)", re.I)

MAX_COMMAND = 1000


def command_is_usable(command: object) -> bool:
    return isinstance(command, str) and 1 <= len(command.strip()) <= MAX_COMMAND


def is_forbidden(command: str) -> bool:
    return bool(FORBIDDEN.search(command))


def local_route(command: str) -> str | None:
    """Label the intent with plain rules. No model, no paraphrase."""
    text = command.strip()
    if not command_is_usable(text) or is_forbidden(text):
        return None
    if CAPTURE_PREFIX.match(text):
        return "capture"
    if MEETING.search(text):
        return "meeting"
    if RESEARCH.search(text):
        return "research"
    if FOCUS.search(text):
        return "focus"
    return None


def number_near(command: str, pattern: re.Pattern[str], fallback: int, low: int, high: int) -> int:
    match = pattern.search(command)
    return min(high, max(low, int(match.group(1)))) if match else fallback


def actions_for(route: str, command: str) -> list[dict]:
    """The exact, ordered effects a person is asked to approve."""
    if route not in WORKFLOWS:
        raise ValueError("Unsupported routine")
    text = command.strip()
    minutes = number_near(text, MINUTES, DEFAULTS.get(route, 0), 1, 180)
    brightness = number_near(text, PERCENT, BRIGHTNESS.get(route, 50), 1, 100)
    actions: list[dict] = []

    def add(kind: str, target: str, label: str, detail: str, surface: str, **extra: object) -> None:
        actions.append({"kind": kind, "target": target, "label": label, "detail": detail, "surface": surface, **extra})

    if route == "capture":
        body = CAPTURE_PREFIX.sub("", text) or text
        add("write_note", "run_record", "Save the note", "Markdown file in your FlowMesh folder", "pc", note=body)
        return actions

    if route == "research":
        if any(word in text.lower() for word in ("board", "backlog", "issue")):
            add("open_url", "project_board", "Open project board", "Approved board URL in your browser", "pc")
        else:
            add("open_url", "documentation", "Open documentation", "Approved docs URL in your browser", "pc")
        if re.search(r"calculator", text, re.I):
            add("launch_app", "calculator", "Open calculator", "Allowlisted app on this computer", "pc")
    else:
        add("open_url", "project_board", "Open project board", "Approved board URL in your browser", "pc")
        if route == "focus" and re.search(r"notepad|editor|text file", text, re.I):
            add("launch_app", "notepad", "Open text editor", "Allowlisted app on this computer", "pc")

    if route in {"focus", "research"}:
        add("timer", "focus_timer", f"Start {minutes} minute timer", "Runs while FlowMesh is open", "pc", value=minutes)

    if route == "meeting":
        message = "Meeting finished. Write the follow-up while it is fresh."
    elif route == "focus":
        message = f"Focus block started for {minutes} minutes."
    else:
        message = f"Research sprint started for {minutes} minutes."
    add("notify", "my_phone", "Notify my phone", "Home Assistant Companion notification", "phone", message=message)
    add("light", "desk_light", f"Set desk lamp to {brightness}%", "Home Assistant light with read-back", "space", value=brightness)
    add("write_note", "run_record", "Save run record", "Markdown file in your FlowMesh folder", "pc", note=text)
    return actions


def plan_payload(route: str, command: str, source: str = "local", confidence: float | None = None) -> dict:
    title, description = WORKFLOWS[route]
    return {
        "route": route,
        "title": title,
        "description": description,
        "source": source,
        "confidence": confidence,
        "actions": actions_for(route, command),
    }
