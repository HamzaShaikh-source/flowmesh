import os
import tempfile
import unittest
from unittest.mock import patch

import bridge
from planner import actions_for, local_route


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(
            os.environ, {"FLOWMESH_ARTIFACT_DIR": os.path.join(self.tmp.name, "runs")}
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        with bridge.PLAN_LOCK:
            bridge.PLANS.clear()
        del bridge.EVENTS[:]

    def test_unsafe_request_never_becomes_a_plan(self):
        self.assertIsNone(local_route("Focus then unlock the door"))
        self.assertIsNone(bridge.prepare_plan("Focus then unlock the door"))

    def test_routes_cover_four_workflows(self):
        self.assertEqual(local_route("Start a 45 minute focus session"), "focus")
        self.assertEqual(local_route("I just finished a meeting"), "meeting")
        self.assertEqual(local_route("Start a 25 minute research sprint"), "research")
        self.assertEqual(local_route("capture: ship it"), "capture")

    def test_one_use_approval_runs_server_owned_actions(self):
        command = "Start a 25 minute research sprint. Open documentation and Calculator."
        with patch.object(
            bridge, "jev_route", return_value={"route": None, "source": "local", "confidence": None}
        ):
            plan = bridge.prepare_plan(command)
        self.assertEqual(plan["route"], "research")
        self.assertEqual(plan["actions"], actions_for("research", command))
        with patch.object(bridge, "perform", return_value={"status": "sent", "detail": "test"}) as perform:
            results = bridge.execute_plan(plan["id"])
            self.assertEqual(perform.call_count, len(plan["actions"]) - 1)
            self.assertEqual(len(results), len(plan["actions"]))
            self.assertEqual(results[-1]["action"]["kind"], "write_note")
            self.assertEqual(results[-1]["status"], "verified")
            self.assertIsNone(bridge.execute_plan(plan["id"]))

    def test_capture_is_a_single_written_note(self):
        plan = bridge.prepare_plan("note down: renew the domain before Friday")
        self.assertEqual(plan["route"], "capture")
        self.assertEqual([a["kind"] for a in plan["actions"]], ["write_note"])
        self.assertEqual(plan["actions"][0]["note"], "renew the domain before Friday")

    def test_jev_none_is_not_overridden_by_local_keyword(self):
        with patch.object(
            bridge, "jev_route", return_value={"route": None, "source": "jev", "confidence": 0.9}
        ):
            self.assertIsNone(bridge.prepare_plan("Start a focus session"))

    def test_plan_clamps_numeric_values(self):
        actions = actions_for("focus", "Focus for 999 minutes and dim lamp to 999%")
        self.assertEqual(next(i for i in actions if i["kind"] == "timer")["value"], 180)
        self.assertEqual(next(i for i in actions if i["kind"] == "light")["value"], 100)

    def test_expired_plan_is_dropped(self):
        with bridge.PLAN_LOCK:
            bridge.PLANS["stale"] = {"expires": 0, "actions": [], "title": "x", "route": "capture", "id": "stale", "source": "local"}
        self.assertIsNone(bridge.execute_plan("stale"))


if __name__ == "__main__":
    unittest.main()
