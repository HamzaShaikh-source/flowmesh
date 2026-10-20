"""The Python half of the cross-runtime planner golden.

`electron/test/parity.test.js` pins web/core.js to `planner_golden.json`; this
test pins planner.py to the same file. Whichever side drifts, one suite fails,
so the Electron app and the packaged app can never quietly disagree about what
a sentence means.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import planner

GOLDEN = Path(__file__).resolve().parents[1] / "electron" / "test" / "fixtures" / "planner_golden.json"


def payload_for(route: str, command: str) -> dict:
    return {
        "route": route,
        "title": planner.WORKFLOWS[route][0],
        "description": planner.WORKFLOWS[route][1],
        "source": "local",
        "confidence": None,
        "also": planner.other_intents(route, command),
        "actions": planner.actions_for(route, command),
    }


class SharedGoldenTests(unittest.TestCase):
    def test_golden_file_is_present_and_substantial(self) -> None:
        self.assertTrue(GOLDEN.exists(), f"missing {GOLDEN}; run scripts/export_planner_golden.py")
        cases = json.loads(GOLDEN.read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 10)

    def test_python_planner_matches_the_shared_golden(self) -> None:
        for entry in json.loads(GOLDEN.read_text(encoding="utf-8"))["cases"]:
            command, expected = entry["command"], entry["plan"]
            usable = planner.command_is_usable(command) and not planner.FORBIDDEN.search(command.strip())
            route = planner.local_route(command) if usable else None
            if expected is None:
                self.assertTrue(route is None or route not in planner.WORKFLOWS, command)
                continue
            self.assertEqual(route, expected["route"], command)
            self.assertEqual(payload_for(route, command), expected, command)

    def test_forbidden_intents_stay_unroutable(self) -> None:
        for command in ("Delete the entire repo", "buy the domain now", "unlock the front door"):
            self.assertFalse(planner.command_is_usable(command) and not planner.FORBIDDEN.search(command), command)


if __name__ == "__main__":
    unittest.main()
