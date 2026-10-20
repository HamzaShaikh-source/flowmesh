"""Export planner behaviour to a JSON golden file shared by both runtimes.

The Electron app reuses web/core.js through Node, and core.js is a port of
planner.py. This script pins the Python answers; `node --test
electron/test/parity.test.js` pins the JavaScript answers to the same file, so
drift on either side fails a test in the language that changed.

Run from the repo root: python scripts/export_planner_golden.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import planner  # noqa: E402

COMMANDS = [
    "Write a note about the release checklist and open the project board",
    "Start a 25 minute focus sprint and set the lamp to 40 percent",
    "Take a note for the standup and message my phone that I am heads down",
    "Capture the release link. Start a 20 minute research sprint.",
    "Open the docs and start a 90 minute focus block",
    "Remind me of the standup notes and open the board",
    "Set the desk lamp to 15 percent",
    "research competitor launch notes for twenty minutes",
    "Start a five minute focus timer",
    "note: judges can open the hosted console",
    "Delete the entire repo",
    "asdfgh",
]


def main() -> None:
    cases = []
    for command in COMMANDS:
        usable = planner.command_is_usable(command) and not planner.FORBIDDEN.search(command.strip())
        route = planner.local_route(command) if usable else None
        if route is None or route not in planner.WORKFLOWS:
            cases.append({"command": command, "plan": None})
            continue
        cases.append(
            {
                "command": command,
                "plan": {
                    "route": route,
                    "title": planner.WORKFLOWS[route][0],
                    "description": planner.WORKFLOWS[route][1],
                    "source": "local",
                    "confidence": None,
                    "also": planner.other_intents(route, command),
                    "actions": planner.actions_for(route, command),
                },
            }
        )
    target = ROOT / "electron" / "test" / "fixtures" / "planner_golden.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"generator": "scripts/export_planner_golden.py", "cases": cases}, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {target} ({len(cases)} cases)")


if __name__ == "__main__":
    main()
