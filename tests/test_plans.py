import unittest
from unittest.mock import patch

import bridge
from planner import actions_for, local_route


class PlanTests(unittest.TestCase):
    def tearDown(self):
        with bridge.PLAN_LOCK:
            bridge.PLANS.clear()

    def test_unsafe_request_never_becomes_a_plan(self):
        self.assertIsNone(local_route("Focus then unlock the door"))
        self.assertIsNone(bridge.prepare_plan("Focus then unlock the door"))

    def test_one_use_approval_executes_server_owned_actions(self):
        with patch.object(bridge, "jev_route", return_value={"route": None, "source": "local", "confidence": None}):
            plan = bridge.prepare_plan("Start a 25 minute research sprint. Open documentation and Calculator.")
        self.assertEqual(plan["route"], "research")
        self.assertEqual(plan["actions"], actions_for("research", "Start a 25 minute research sprint. Open documentation and Calculator."))
        with patch.object(bridge, "perform", return_value={"status": "sent", "detail": "test"}) as perform:
            results = bridge.execute_plan(plan["id"])
            self.assertEqual(perform.call_count, len(plan["actions"]))
            self.assertEqual(len(results), len(plan["actions"]))
            self.assertIsNone(bridge.execute_plan(plan["id"]))

    def test_jev_none_is_not_overridden_by_local_keyword(self):
        with patch.object(bridge, "jev_route", return_value={"route": None, "source": "jev", "confidence": 0.9}):
            self.assertIsNone(bridge.prepare_plan("Start a focus session"))

    def test_plan_clamps_numeric_values(self):
        actions = actions_for("focus", "Focus for 999 minutes and dim lamp to 999%")
        self.assertEqual(next(item for item in actions if item["kind"] == "timer")["value"], 180)
        self.assertEqual(next(item for item in actions if item["kind"] == "light")["value"], 100)


if __name__ == "__main__":
    unittest.main()
