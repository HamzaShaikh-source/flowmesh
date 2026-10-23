"""Coding agents through the real HTTP bridge: folders, plans, approval, honest receipts."""

from __future__ import annotations

import time
import unittest
from pathlib import Path
from unittest.mock import patch

import bridge
from agents import AgentManager
from tests.helpers import BridgeTestCase
from tests.test_agents import mock_catalog


class AgentsBridgeCase(BridgeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.store: dict = {}
        self.manager = AgentManager(mock_catalog(), load=lambda: self.store, save=lambda v: self.store.update(v))
        patcher = patch.object(bridge, "AGENTS", self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.manager.close_all)
        self.project = Path(self.tmp.name).resolve() / "projects" / "demo"
        self.project.mkdir(parents=True)

    def add_folder(self):
        status, _, body = self.call("POST", "/api/agents/workspaces", {"path": str(self.project), "label": "Demo", "acknowledged": True})
        self.assertEqual(status, 200, body)
        return self.json_of(body)["workspace"]

    def plan(self, space, prompt="hello", agent="mock", mode="edit", expected=200):
        status, _, body = self.call("POST", "/api/agents/plan", {"agent": agent, "workspace": space["id"], "mode": mode, "prompt": prompt})
        self.assertEqual(status, expected, body)
        return self.json_of(body)

    def wait_detected(self):
        for _ in range(100):
            if not self.manager.detect()["checking"]:
                return
            time.sleep(0.1)


class FoldersTest(AgentsBridgeCase):
    def test_adding_a_folder_needs_an_acknowledgement(self):
        status, _, body = self.call("POST", "/api/agents/workspaces", {"path": str(self.project)})
        self.assertEqual(status, 428)
        self.assertTrue(self.json_of(body)["needs_acknowledgement"])

    def test_a_home_or_root_folder_is_refused(self):
        for bad in (str(Path.home()), Path(self.project.anchor).as_posix()):
            status, _, _ = self.call("POST", "/api/agents/workspaces", {"path": bad, "acknowledged": True})
            self.assertEqual(status, 422, bad)

    def test_listing_reports_catalog_config_and_detection(self):
        space = self.add_folder()
        self.wait_detected()
        data = self.json_of(self.call("GET", "/api/agents")[2])
        self.assertTrue(data["enabled"])
        self.assertIn("mock", {a["id"] for a in data["catalog"]})
        self.assertEqual(data["config"]["workspaces"][0]["id"], space["id"])
        self.assertTrue(data["detection"]["agents"]["mock"]["installed"])
        self.assertFalse(data["detection"]["agents"]["ghost"]["installed"])
        self.assertNotIn(str(Path(self.tmp.name)), self.call("GET", "/api/agents")[2].replace("\\\\", "\\").split('"workspaces"')[0])

    def test_removing_a_folder(self):
        space = self.add_folder()
        self.assertEqual(self.call("POST", "/api/agents/workspaces/remove", {"id": space["id"]})[0], 200)
        self.assertEqual(self.call("POST", "/api/agents/workspaces/remove", {"id": space["id"]})[0], 404)


class PlanAndRunTest(AgentsBridgeCase):
    def test_an_edit_task_is_a_write_plan_that_is_never_auto_run(self):
        plan = self.plan(self.add_folder())
        self.assertEqual((plan["risk"], plan["route"], plan["auto_run"], plan["needs_confirm"]), ("write", "agent", False, False))
        self.assertEqual(plan["actions"][0]["kind"], "agent_run")
        self.assertIn("task sent on stdin", plan["actions"][0]["command"])

    def test_a_bypass_mode_is_danger_and_needs_the_second_confirmation(self):
        plan = self.plan(self.add_folder(), mode="full")
        self.assertEqual((plan["risk"], plan["needs_confirm"]), ("danger", True))
        self.assertEqual(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[0], 428)

    def test_approving_runs_the_agent_and_returns_its_output(self):
        space = self.add_folder()
        plan = self.plan(space, prompt="WRITE:made.txt please")
        status, _, body = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
        self.assertEqual(status, 200, body)
        results = self.json_of(body)["results"]
        self.assertEqual(results[0]["status"], "returned", "FlowMesh never claims a coding task is verified")
        self.assertIn("made.txt", results[0]["output"])
        self.assertTrue((self.project / "made.txt").exists())
        self.assertEqual(results[-1]["status"], "verified", "the run record itself is hashed")
        self.assertEqual(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[0], 409)

    def test_a_failing_agent_is_failed_with_its_output(self):
        plan = self.plan(self.add_folder(), prompt="FAIL")
        results = self.json_of(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[2])["results"]
        self.assertEqual(results[0]["status"], "failed")
        self.assertIn("something went wrong", results[0]["output"])

    def test_the_client_cannot_name_a_path_or_extra_fields(self):
        space = self.add_folder()
        status, _, _ = self.call("POST", "/api/agents/plan", {"agent": "mock", "workspace": space["id"], "mode": "edit",
                                                              "prompt": "x", "path": "C:/Windows"})
        self.assertEqual(status, 400)
        status, _, _ = self.call("POST", "/api/agents/plan", {"agent": "mock", "workspace": "C:/Windows", "mode": "edit", "prompt": "x"})
        self.assertEqual(status, 422)

    def test_an_uninstalled_agent_is_refused_with_a_reason(self):
        body = self.plan(self.add_folder(), agent="ghost", expected=422)
        self.assertIn("not installed", body["error"])

    def test_progress_is_pollable_and_cancel_stops_the_run(self):
        import threading

        space = self.add_folder()
        plan = self.plan(space, prompt="SLEEP:30")
        run_id = plan["actions"][0]["run_id"]
        out: dict = {}
        worker = threading.Thread(target=lambda: out.update(r=self.call("POST", "/api/execute", {"plan_id": plan["id"]})))
        worker.start()
        view = None
        for _ in range(100):
            status, _, body = self.call("GET", f"/api/agents/runs/{run_id}")
            if status == 200 and "sleeping" in self.json_of(body)["output"]:
                view = self.json_of(body)
                break
            time.sleep(0.1)
        self.assertIsNotNone(view)
        self.assertEqual(view["status"], "running")
        self.assertEqual(self.call("POST", f"/api/agents/runs/{run_id}/cancel", {})[0], 200)
        worker.join(30)
        results = self.json_of(out["r"][2])["results"]
        self.assertNotEqual(results[0]["status"], "verified")
        self.assertIn("cancel", results[0]["detail"].lower())
        self.assertEqual(self.call("POST", f"/api/agents/runs/{run_id}/cancel", {})[0], 404)
        self.assertEqual(self.call("GET", "/api/agents/runs/not-a-run")[0], 404)


class RelayTest(AgentsBridgeCase):
    def relay(self, kind, agents, prompt="hello", mode="edit", expected=200, **extra):
        space = self.add_folder()
        body = {"kind": kind, "workspace": space["id"], "prompt": prompt, "agents": agents, "mode": mode, **extra}
        status, _, raw = self.call("POST", "/api/agents/relay", body)
        self.assertEqual(status, expected, raw)
        return self.json_of(raw)

    def approve(self, plan):
        status, _, raw = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
        self.assertEqual(status, 200, raw)
        return self.json_of(raw)["results"]

    def test_work_then_review_hands_the_output_over_as_untrusted_data(self):
        plan = self.relay("review", ["mock", "mock2"], prompt="WRITE:made.txt")
        steps = [a for a in plan["actions"] if a["kind"] == "agent_run"]
        self.assertEqual([(a["role"], a["risk"], a["handoff_from"]) for a in steps], [("work", "write", None), ("review", "read", 0)])
        self.assertEqual(plan["risk"], "write")
        self.assertFalse(plan["auto_run"])
        results = self.approve(plan)
        self.assertEqual([r["status"] for r in results[:2]], ["returned", "returned"])
        second = results[1]["output"]
        self.assertIn("untrusted", second)
        self.assertIn("made.txt", second)
        self.assertIn("Review the changes", second)
        self.assertEqual(results[-1]["status"], "verified")

    def test_a_failed_step_stops_the_ones_after_it(self):
        plan = self.relay("review", ["mock", "mock2"], prompt="FAIL")
        results = self.approve(plan)
        self.assertEqual(results[0]["status"], "failed")
        self.assertEqual(results[1]["status"], "denied")
        self.assertIn("Skipped", results[1]["detail"])

    def test_plan_build_review_chain_has_three_steps_in_order(self):
        plan = self.relay("chain", ["mock", "mock2", "mock3"])
        steps = [a for a in plan["actions"] if a["kind"] == "agent_run"]
        self.assertEqual([(a["role"], a["mode"]) for a in steps], [("plan", "plan"), ("work", "edit"), ("review", "plan")])
        self.assertEqual([r["status"] for r in self.approve(plan)[:3]], ["returned"] * 3)

    def test_compare_is_read_only_and_independent(self):
        plan = self.relay("compare", ["mock", "mock2"])
        steps = [a for a in plan["actions"] if a["kind"] == "agent_run"]
        self.assertEqual([(a["risk"], a["handoff_from"]) for a in steps], [("read", None), ("read", None)])
        self.assertEqual(plan["risk"], "read")
        self.relay("compare", ["mock", "mock"], expected=422)

    def test_full_access_in_any_step_needs_the_second_confirmation(self):
        plan = self.relay("review", ["mock", "mock2"], mode="full")
        self.assertEqual((plan["risk"], plan["needs_confirm"]), ("danger", True))
        self.assertEqual(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[0], 428)

    def test_an_agent_that_cannot_be_read_only_cannot_review(self):
        body = self.relay("review", ["mock", "mockarg"], expected=422)
        self.assertIn("read-only", body["error"])

    def test_bad_shapes_are_refused(self):
        self.relay("review", ["mock"], expected=422)
        self.relay("chain", ["mock", "mock2"], expected=422)
        self.relay("nonsense", ["mock", "mock2"], expected=422)
        self.relay("review", ["mock", "mock2"], expected=400, path="C:/Windows")


class PhraseAndSigninTest(AgentsBridgeCase):
    def test_a_spoken_agent_sentence_becomes_a_plan_with_saved_defaults(self):
        space = self.add_folder()
        self.call("POST", "/api/agents/defaults", {"default_agent": "mock", "default_workspace": space["id"], "default_mode": "edit"})
        with patch("bridge.agent_phrase", return_value=("mock", "fix the build")):
            status, _, body = self.call("POST", "/api/plan", {"command": "ask mock to fix the build"})
        self.assertEqual(status, 200, body)
        plan = self.json_of(body)
        self.assertEqual((plan["route"], plan["auto_run"]), ("agent", False))
        self.assertEqual(plan["actions"][0]["prompt"], "fix the build")

    def test_a_phrase_without_a_saved_folder_explains_what_to_do(self):
        with patch("bridge.agent_phrase", return_value=("mock", "fix the build")):
            status, _, body = self.call("POST", "/api/plan", {"command": "ask mock to fix the build"})
        self.assertEqual(status, 422)
        self.assertIn("project folder", self.json_of(body)["error"])

    def test_sign_in_opens_the_vendors_own_login_in_a_terminal(self):
        opened = []
        with patch("agents.open_in_terminal", side_effect=lambda argv: opened.append(argv) or True):
            status, _, body = self.call("POST", "/api/agents/signin", {"agent": "mock"})
        self.assertEqual(status, 200, body)
        self.assertEqual(opened[0][-2:], ["auth", "login"])
        self.assertEqual(self.call("POST", "/api/agents/signin", {"agent": "../evil"})[0], 422)

    def test_the_feature_can_be_switched_off(self):
        with patch.dict("os.environ", {"FLOWMESH_AGENTS": "off"}):
            self.assertEqual(self.call("POST", "/api/agents/defaults", {})[0], 403)
            self.assertFalse(self.json_of(self.call("GET", "/api/agents")[2])["enabled"])


if __name__ == "__main__":
    unittest.main()
