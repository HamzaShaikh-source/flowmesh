"""Deterministic, reviewable plans for the three supported work routines."""

from __future__ import annotations

import re

WORKFLOWS = {
    "focus": ("Deep focus", "Clear the desk and begin one uninterrupted block."),
    "meeting": ("Meeting reset", "Capture the next step and return to your work."),
    "research": ("Research sprint", "Prepare references and start a timed reading block."),
}

FORBIDDEN = re.compile(
    r"\b(unlock|delete|purchase|buy|oven|alarm|password|door|security|medication|send email|send money|transfer funds)\b",
    re.I,
)


def local_route(command: str) -> str | None:
    text = command.lower()
    if FORBIDDEN.search(text):
        return None
    if re.search(r"meeting|follow.?up|call ended", text):
        return "meeting"
    if re.search(r"research|reading|documentation|study", text):
        return "research"
    if re.search(r"focus|deep work|work session|timer|project board", text):
        return "focus"
    return None


def number_near(command: str, pattern: str, fallback: int, low: int, high: int) -> int:
    match = re.search(pattern, command, re.I)
    return min(high, max(low, int(match.group(1)))) if match else fallback


def actions_for(route: str, command: str) -> list[dict]:
    if route not in WORKFLOWS:
        raise ValueError("Unsupported routine")
    minutes = number_near(command, r"\b(\d{1,3})\s*(?:minutes?|mins?)\b", 25 if route == "research" else 45, 1, 180)
    brightness = number_near(command, r"\b(\d{1,3})\s*%", {"focus": 30, "meeting": 70, "research": 55}[route], 1, 100)
    actions: list[dict] = []

    def add(kind: str, target: str, label: str, detail: str, surface: str, **extra: object) -> None:
        actions.append({"kind": kind, "target": target, "label": label, "detail": detail, "surface": surface, **extra})

    if route == "research":
        add("open_url", "documentation", "Open documentation", "Approved documentation URL", "pc")
        if "calculator" in command.lower():
            add("launch_app", "calculator", "Launch Calculator", "Approved Windows application", "pc")
    else:
        add("open_url", "project_board", "Open project board", "Approved project board URL", "pc")
        if route == "focus" and re.search(r"notepad|editor", command, re.I):
            add("launch_app", "notepad", "Launch Notepad", "Approved Windows application", "pc")
    if route in {"focus", "research"}:
        add("timer", "focus_timer", f"Start {minutes} minute timer", "Runs while FlowMesh is open", "pc", value=minutes)
    message = {
        "focus": f"Focus block started for {minutes} minutes.",
        "meeting": "Meeting finished. Write the follow up and capture action items.",
        "research": f"Research sprint started for {minutes} minutes.",
    }[route]
    add("notify", "my_phone", "Notify my phone", "Home Assistant Companion notification", "phone", message=message)
    add("light", "desk_light", f"Set desk lamp to {brightness}%", "Home Assistant light with read-back", "space", value=brightness)
    return actions
