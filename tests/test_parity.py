"""The web planner must be the same planner. Drift fails here, in CI, on every OS."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import planner

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "planner_cases.json"


def python_plans(cases: list[str]) -> list[dict]:
    plans = []
    for command in cases:
        route = planner.local_route(command)
        plans.append({"route": None} if not route else planner.plan_payload(route, command))
    return plans


class PlannerParityTests(unittest.TestCase):
    def test_every_route_is_covered(self):
        cases = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]
        routes = {planner.local_route(command) for command in cases}
        self.assertEqual(routes, {None, "focus", "meeting", "research", "capture"})

    def test_js_planner_matches_python_exactly(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed on this machine")
        cases = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]
        cases += [
            "x" * 1000,
            "x" * 1001,
            "focus " + "x" * 1000,
            "capture: " + ("word " * 150).strip(),
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
            json.dump({"cases": cases}, handle)
            fixture_path = handle.name
        try:
            result = subprocess.run(
                [node, str(ROOT / "tests" / "parity.js"), fixture_path],
                capture_output=True, text=True, timeout=90, check=False,
            )
        finally:
            Path(fixture_path).unlink(missing_ok=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        js_plans = json.loads(result.stdout)
        self.assertEqual(len(js_plans), len(cases))
        for index, (expected, actual) in enumerate(zip(python_plans(cases), js_plans)):
            with self.subTest(case=cases[index][:60]):
                self.assertEqual(expected, actual)


if __name__ == "__main__":
    unittest.main()
