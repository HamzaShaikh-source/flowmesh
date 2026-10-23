"""The MCP client against a real stdio child process."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import mcp_client
from mcp_client import McpError, McpSession, StdioTransport

MOCK = str(Path(__file__).resolve().parent / "mock_mcp_server.py")


def open_session(env=None) -> McpSession:
    transport = StdioTransport(sys.executable, [MOCK], env=env)
    return McpSession(transport, "mock").open()


class StdioSessionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.session = open_session()
        self.addCleanup(self.session.close)

    def test_initializes_and_lists_tools_ignoring_non_json_stdout(self):
        self.assertEqual(self.session.server_info["name"], "mock-notes")
        names = [t["name"] for t in self.session.list_tools()]
        self.assertIn("echo", names)
        self.assertIn("delete_note", names)

    def test_calls_a_tool_and_returns_text(self):
        result = self.session.call_tool("echo", {"text": "hello"})
        self.assertEqual((result["is_error"], result["text"]), (False, "hello"))

    def test_tool_errors_are_flagged_not_raised(self):
        result = self.session.call_tool("fail", {})
        self.assertTrue(result["is_error"])
        self.assertEqual(result["text"], "it broke")

    def test_unknown_tool_is_a_protocol_error(self):
        with self.assertRaises(McpError) as caught:
            self.session.call_tool("nope", {})
        self.assertEqual(caught.exception.kind, "server_error")

    def test_output_is_stripped_of_control_characters_and_truncated(self):
        result = self.session.call_tool("big_output", {})
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["text"]), mcp_client.MAX_OUTPUT_CHARS)
        self.assertNotIn("\x00", result["text"])
        self.assertNotIn("\x07", result["text"])

    def test_a_slow_call_times_out_without_killing_the_session(self):
        with self.assertRaises(McpError) as caught:
            self.session.call_tool("slow", {"seconds": 3}, timeout=0.5)
        self.assertEqual(caught.exception.kind, "timeout")
        self.assertEqual(self.session.call_tool("echo", {"text": "still here"})["text"], "still here")

    def test_server_initiated_requests_are_refused(self):
        result = self.session.call_tool("ask_sampling", {})
        self.assertIn("-32601", result["text"])
        self.assertIn("does not support", result["text"])

    def test_close_terminates_the_child(self):
        proc = self.session.transport._proc
        self.session.close()
        proc.wait(timeout=5)
        self.assertIsNotNone(proc.poll())

    def test_a_dead_server_reports_unavailable(self):
        self.session.transport._proc.kill()
        self.session.transport._proc.wait(timeout=5)
        with self.assertRaises(McpError) as caught:
            self.session.call_tool("echo", {"text": "x"})
        self.assertEqual(caught.exception.kind, "unavailable")


class EnvironmentTest(unittest.TestCase):
    def test_flowmesh_secrets_are_not_inherited_but_configured_ones_are(self):
        with patch.dict(os.environ, {"FLOWMESH_HA_TOKEN": "x", "TYPESAFE_API_KEY": "y", "ANTHROPIC_API_KEY": "z"}):
            session = open_session(env={"GITHUB_TOKEN": "configured"})
            self.addCleanup(session.close)
            leaked = session.call_tool("env_probe", {})["text"]
        self.assertIn("GITHUB_TOKEN", leaked)
        for forbidden in ("FLOWMESH_HA_TOKEN", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY"):
            self.assertNotIn(forbidden, leaked)

    def test_a_missing_executable_is_reported_plainly(self):
        transport = StdioTransport("definitely-not-a-real-program-xyz", [])
        with self.assertRaises(McpError) as caught:
            McpSession(transport).open()
        self.assertEqual(caught.exception.kind, "unavailable")

    def test_commands_are_never_run_through_a_shell(self):
        self.assertIsNone(mcp_client.resolve_command("python; rm -rf /"))
        self.assertIsNone(mcp_client.resolve_command("python\nx"))


class HttpTransportConfigTest(unittest.TestCase):
    def test_remote_http_credentials_in_url_and_plain_http_are_refused(self):
        for url in ("http://example.com/mcp", "https://user:pw@example.com/mcp", "ftp://x/y", "https:///nohost"):
            with self.assertRaises(McpError, msg=url):
                mcp_client.HttpTransport(url)

    def test_https_and_loopback_http_are_accepted(self):
        mcp_client.HttpTransport("https://example.com/mcp")
        mcp_client.HttpTransport("http://127.0.0.1:9/mcp")


if __name__ == "__main__":
    unittest.main()
