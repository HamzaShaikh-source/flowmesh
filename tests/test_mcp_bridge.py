"""MCP through the real HTTP bridge: register, plan, approve once, get honest receipts."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import bridge
import flowmesh_config
from mcp_client import McpError
from tests.helpers import BridgeTestCase

MOCK = str(Path(__file__).resolve().parent / "mock_mcp_server.py")
SERVER = {"id": "notes", "label": "Notes", "transport": "stdio", "command": sys.executable, "args": [MOCK],
          "env": {"NOTES_TOKEN": "s3cret"}}


class McpBridgeCase(BridgeTestCase):
    def setUp(self) -> None:
        super().setUp()
        keyring = patch.object(flowmesh_config, "keyring", None)
        keyring.start()
        self.addCleanup(keyring.stop)
        self.addCleanup(bridge.MANAGER.close_all)

    def register(self, **extra):
        status, _, body = self.call("POST", "/api/mcp/servers", {"server": {**SERVER, **extra}, "acknowledged": True})
        self.assertEqual(status, 200, body)

    def plan(self, calls, status_expected=200):
        status, _, body = self.call("POST", "/api/mcp/plan", {"calls": calls})
        self.assertEqual(status, status_expected, body)
        return self.json_of(body)


class RegistrationTest(McpBridgeCase):
    def test_a_stdio_server_needs_an_explicit_acknowledgement(self):
        status, _, body = self.call("POST", "/api/mcp/servers", {"server": SERVER})
        self.assertEqual(status, 428)
        self.assertTrue(self.json_of(body)["needs_acknowledgement"])
        self.assertEqual(self.json_of(self.call("GET", "/api/mcp/servers")[2])["servers"], [])

    def test_secret_values_never_come_back(self):
        self.register()
        status, _, body = self.call("GET", "/api/mcp/servers")
        self.assertEqual(status, 200)
        self.assertNotIn("s3cret", body)
        self.assertEqual(self.json_of(body)["servers"][0]["env"], {"NOTES_TOKEN": "********"})

    def test_toggling_a_server_does_not_need_the_acknowledgement_again(self):
        self.register()
        masked = {**SERVER, "env": {"NOTES_TOKEN": "********"}, "enabled": False}
        status, _, _ = self.call("POST", "/api/mcp/servers", {"server": masked})
        self.assertEqual(status, 200)

    def test_changing_the_program_needs_it_again(self):
        self.register()
        status, _, _ = self.call("POST", "/api/mcp/servers", {"server": {**SERVER, "args": [MOCK, "--other"]}})
        self.assertEqual(status, 428)

    def test_invalid_servers_are_422_and_test_reports_tool_count(self):
        status, _, _ = self.call("POST", "/api/mcp/servers", {"server": {"id": "Bad Id", "transport": "stdio", "command": "x"}, "acknowledged": True})
        self.assertEqual(status, 422)
        self.register()
        status, _, body = self.call("POST", "/api/mcp/servers/test", {"id": "notes"})
        self.assertEqual((status, self.json_of(body)["ok"]), (200, True))

    def test_remove_and_presets(self):
        self.register()
        self.assertEqual(self.call("POST", "/api/mcp/servers/remove", {"id": "notes"})[0], 200)
        self.assertEqual(self.call("POST", "/api/mcp/servers/remove", {"id": "notes"})[0], 404)
        presets = self.json_of(self.call("GET", "/api/mcp/presets")[2])["presets"]
        self.assertTrue({"filesystem", "github", "playwright"} <= {p["id"] for p in presets})

    def test_every_mcp_route_demands_the_session_token(self):
        for method, path, payload in (("GET", "/api/mcp/servers", None), ("GET", "/api/mcp/tools", None),
                                      ("GET", "/api/mcp/presets", None), ("POST", "/api/mcp/plan", {"calls": []}),
                                      ("POST", "/api/mcp/servers", {"server": SERVER})):
            self.assertEqual(self.call(method, path, payload, token="none")[0], 401, path)


class PlanAndRunTest(McpBridgeCase):
    def setUp(self) -> None:
        super().setUp()
        self.register()

    def test_plan_run_and_one_use(self):
        plan = self.plan([{"server": "notes", "tool": "add_note", "arguments": {"title": "Pricing", "body": "call Rohan"}}])
        self.assertEqual((plan["route"], plan["risk"], plan["auto_run"], plan["needs_confirm"]), ("tools", "write", False, False))
        first = plan["actions"][0]
        self.assertEqual(first["arguments"], {"title": "Pricing", "body": "call Rohan"})
        status, _, body = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
        self.assertEqual(status, 200)
        results = self.json_of(body)["results"]
        self.assertEqual(results[0]["status"], "returned")
        self.assertIn("Saved note 'Pricing'", results[0]["output"])
        self.assertEqual(results[-1]["status"], "verified", "the run record is hashed and written")
        self.assertEqual(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[0], 409)

    def test_the_run_record_contains_the_tool_output(self):
        plan = self.plan([{"server": "notes", "tool": "echo", "arguments": {"text": "hello record"}}])
        results = self.json_of(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[2])["results"]
        record = Path(results[-1]["path"]).read_text(encoding="utf-8")
        self.assertIn("hello record", record)
        self.assertIn("untrusted", record)

    def test_a_tool_error_is_failed_and_keeps_its_message(self):
        plan = self.plan([{"server": "notes", "tool": "fail", "arguments": {}}])
        results = self.json_of(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[2])["results"]
        self.assertEqual((results[0]["status"], results[0]["output"]), ("failed", "it broke"))

    def test_a_timeout_is_unknown_never_a_claimed_success(self):
        plan = self.plan([{"server": "notes", "tool": "echo", "arguments": {"text": "x"}}])
        with patch.object(bridge.MANAGER, "call", side_effect=McpError("timeout", "No answer in 60 seconds.")):
            results = self.json_of(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[2])["results"]
        self.assertEqual(results[0]["status"], "unknown")
        self.assertIn("may or may not", results[0]["detail"])

    def test_oversized_output_is_truncated_and_flagged(self):
        plan = self.plan([{"server": "notes", "tool": "big_output", "arguments": {}}])
        results = self.json_of(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[2])["results"]
        self.assertLessEqual(len(results[0]["output"]), 20_000)
        self.assertIn("truncated", results[0]["detail"])

    def test_the_client_can_never_amend_arguments_at_execute_time(self):
        plan = self.plan([{"server": "notes", "tool": "echo", "arguments": {"text": "safe"}}])
        for body in ({"plan_id": plan["id"], "arguments": {"text": "evil"}}, {"plan_id": plan["id"], "calls": []},
                     {"plan_id": plan["id"], "confirm": "yes"}):
            self.assertEqual(self.call("POST", "/api/execute", body)[0], 400)
        results = self.json_of(self.call("POST", "/api/execute", {"plan_id": plan["id"]})[2])["results"]
        self.assertEqual(results[0]["output"], "safe")

    def test_bad_calls_are_refused_with_a_reason_before_a_plan_exists(self):
        for calls in ([{"server": "notes", "tool": "add_note", "arguments": {}}],
                      [{"server": "notes", "tool": "ghost", "arguments": {}}],
                      [{"server": "notes", "tool": "add_note", "arguments": {"title": "x", "extra": 1}}]):
            body = self.plan(calls, 422)
            self.assertTrue(body["error"])
        self.assertEqual(self.call("POST", "/api/mcp/plan", {"calls": [], "shell": "x"})[0], 400)

    def test_a_destructive_tool_needs_a_second_deliberate_confirmation(self):
        plan = self.plan([{"server": "notes", "tool": "delete_note", "arguments": {"title": "old"}}])
        self.assertEqual((plan["risk"], plan["needs_confirm"]), ("danger", True))
        status, _, body = self.call("POST", "/api/execute", {"plan_id": plan["id"]})
        self.assertEqual(status, 428)
        self.assertTrue(self.json_of(body)["needs_confirm"])
        status, _, body = self.call("POST", "/api/execute", {"plan_id": plan["id"], "confirm": True})
        self.assertEqual(status, 200, "the plan must survive the refusal")
        self.assertEqual(self.json_of(body)["results"][0]["status"], "returned")

    def test_read_only_calls_auto_run_only_when_the_server_opted_in(self):
        call = [{"server": "notes", "tool": "echo", "arguments": {"text": "x"}}]
        self.assertFalse(self.plan(call)["auto_run"])
        self.register(auto_read=True, env={"NOTES_TOKEN": "********"})
        auto = self.plan(call)
        self.assertTrue(auto["auto_run"])
        self.assertNotIn("write_note", [a["kind"] for a in auto["actions"]])
        mixed = self.plan(call + [{"server": "notes", "tool": "add_note", "arguments": {"title": "t"}}])
        self.assertFalse(mixed["auto_run"], "one write in the plan means a person approves the whole plan")

    def test_events_keep_only_a_short_preview_of_output(self):
        plan = self.plan([{"server": "notes", "tool": "big_output", "arguments": {}}])
        self.call("POST", "/api/execute", {"plan_id": plan["id"]})
        events = self.json_of(self.call("GET", "/api/events")[2])["events"]
        tool_event = next(e for e in events if e["action"]["kind"] == "mcp_call")
        self.assertNotIn("output", tool_event)
        self.assertLessEqual(len(tool_event["output_preview"]), 600)
        self.assertEqual(tool_event["action"]["risk"], "read")


class RoutinesUnchangedTest(McpBridgeCase):
    def test_the_original_routines_still_plan_and_run_without_any_servers(self):
        status, _, body = self.call("POST", "/api/plan", {"command": "start a 25 minute research sprint"})
        self.assertEqual(status, 200)
        self.assertEqual(self.json_of(body)["route"], "research")


if __name__ == "__main__":
    unittest.main()


class StdioLockTest(McpBridgeCase):
    def test_stdio_servers_can_be_disabled_for_the_whole_install(self):
        with patch.dict("os.environ", {"FLOWMESH_MCP_STDIO": "off"}):
            status, _, body = self.call("POST", "/api/mcp/servers", {"server": SERVER, "acknowledged": True})
            self.assertEqual(status, 403)
            self.assertEqual(self.json_of(body)["kind"], "disabled")
            self.assertEqual(self.json_of(self.call("GET", "/api/mcp/servers")[2])["servers"], [])
            remote = {"id": "remote", "transport": "http", "url": "https://example.com/mcp"}
            self.assertEqual(self.call("POST", "/api/mcp/servers", {"server": remote})[0], 200)
