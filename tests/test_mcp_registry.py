"""Registry, risk levels, schema validation and plan building."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import flowmesh_config
import mcp_registry
from mcp_registry import DANGER, MASK, READ, WRITE, McpManager, classify, validate_arguments, validate_server

MOCK = str(Path(__file__).resolve().parent / "mock_mcp_server.py")


def stdio(server_id="notes", **extra) -> dict:
    return {"id": server_id, "label": "Notes", "transport": "stdio", "command": sys.executable, "args": [MOCK], **extra}


class IsolatedConfig(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"FLOWMESH_CONFIG_DIR": os.path.join(self.tmp.name, "cfg")})
        env.start()
        self.addCleanup(env.stop)
        keyring = patch.object(flowmesh_config, "keyring", None)
        keyring.start()
        self.addCleanup(keyring.stop)
        self.manager = McpManager()
        self.addCleanup(self.manager.close_all)


class ClassifyTest(unittest.TestCase):
    def test_risk_levels(self):
        self.assertEqual(classify({"name": "list_files", "annotations": {"readOnlyHint": True}}), READ)
        self.assertEqual(classify({"name": "send_message"}), WRITE)
        self.assertEqual(classify({"name": "x", "annotations": {"destructiveHint": True}}), DANGER)

    def test_a_destructive_name_beats_a_read_only_claim(self):
        # A server cannot lower its own risk by labelling a destructive tool read-only.
        self.assertEqual(classify({"name": "delete_repo", "annotations": {"readOnlyHint": True}}), DANGER)
        self.assertEqual(classify({"name": "run_command"}), DANGER)
        self.assertEqual(classify({"name": "git_reset"}), DANGER)

    def test_names_that_merely_contain_a_word_are_not_flagged(self):
        self.assertEqual(classify({"name": "remover_info", "annotations": {"readOnlyHint": True}}), READ)
        self.assertEqual(classify({"name": "shellfish_menu", "annotations": {"readOnlyHint": True}}), READ)


class SchemaTest(unittest.TestCase):
    schema = {"type": "object", "required": ["title"], "additionalProperties": False,
              "properties": {"title": {"type": "string", "minLength": 1, "maxLength": 5},
                             "count": {"type": "integer", "minimum": 1, "maximum": 3},
                             "kind": {"enum": ["a", "b"]},
                             "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 2}}}

    def test_valid_arguments_pass(self):
        self.assertEqual(validate_arguments(self.schema, {"title": "hi", "count": 2, "kind": "a", "tags": ["x"]}), [])

    def test_each_kind_of_mistake_is_reported(self):
        cases = {
            "required": {},
            "type": {"title": 5},
            "maxLength": {"title": "toolong"},
            "minimum": {"title": "a", "count": 0},
            "maximum": {"title": "a", "count": 9},
            "enum": {"title": "a", "kind": "z"},
            "extra field": {"title": "a", "evil": 1},
            "items": {"title": "a", "tags": [1]},
            "maxItems": {"title": "a", "tags": ["a", "b", "c"]},
            "bool is not an int": {"title": "a", "count": True},
        }
        for label, value in cases.items():
            self.assertTrue(validate_arguments(self.schema, value), label)

    def test_anyof_and_unknown_schemas_do_not_crash(self):
        any_of = {"anyOf": [{"type": "string"}, {"type": "integer"}]}
        self.assertEqual(validate_arguments(any_of, "x"), [])
        self.assertTrue(validate_arguments(any_of, [1]))
        self.assertEqual(validate_arguments(None, {"a": 1}), [])
        self.assertEqual(validate_arguments({"$ref": "#/x"}, 5), [])


class ServerConfigTest(IsolatedConfig):
    def test_secrets_are_masked_outwards_and_kept_when_the_mask_comes_back(self):
        saved = self.manager.upsert(stdio(env={"API_TOKEN": "s3cret"}))
        self.assertEqual(saved["env"], {"API_TOKEN": MASK})
        self.assertNotIn("s3cret", str(self.manager.list_servers()))
        self.manager.upsert(stdio(env={"API_TOKEN": MASK, "OTHER": "v"}))
        self.assertEqual(self.manager.get("notes")["env"], {"API_TOKEN": "s3cret", "OTHER": "v"})

    def test_http_headers_are_masked_too(self):
        saved = self.manager.upsert({"id": "remote", "transport": "http", "url": "https://example.com/mcp",
                                     "headers": {"Authorization": "Bearer abc"}})
        self.assertEqual(saved["headers"], {"Authorization": MASK})
        self.assertNotIn("Bearer abc", str(self.manager.list_servers()))

    def test_bad_configs_are_rejected_with_a_sentence(self):
        bad = [
            {"id": "Bad Id", "transport": "stdio", "command": "x"},
            {"id": "a", "transport": "ftp"},
            {"id": "a", "transport": "stdio", "command": ""},
            {"id": "a", "transport": "stdio", "command": "x\ny"},
            {"id": "a", "transport": "stdio", "command": "x", "args": ["a"] * 40},
            {"id": "a", "transport": "stdio", "command": "x", "env": {"bad name": "v"}},
            {"id": "a", "transport": "http", "url": "http://example.com/mcp"},
            {"id": "a", "transport": "http", "url": "https://u:p@example.com/mcp"},
            {"id": "a", "transport": "http", "url": "https://example.com", "headers": {"X": "a\nb"}},
            "not an object",
        ]
        for raw in bad:
            with self.assertRaises(ValueError, msg=str(raw)):
                validate_server(raw)

    def test_persistence_survives_a_new_manager_and_remove_works(self):
        self.manager.upsert(stdio())
        self.assertEqual([s["id"] for s in McpManager().list_servers()], ["notes"])
        self.assertTrue(self.manager.remove("notes"))
        self.assertFalse(self.manager.remove("notes"))
        self.assertEqual(McpManager().list_servers(), [])

    def test_server_count_is_capped(self):
        for index in range(mcp_registry.MAX_SERVERS):
            self.manager.upsert(stdio(f"s{index}"))
        with self.assertRaises(ValueError):
            self.manager.upsert(stdio("one-too-many"))


class ToolsAndPlansTest(IsolatedConfig):
    def setUp(self) -> None:
        super().setUp()
        self.manager.upsert(stdio())

    def test_catalog_lists_tools_with_risk(self):
        catalog = self.manager.catalog()
        risks = {t["name"]: t["risk"] for t in catalog["tools"]}
        self.assertEqual(catalog["errors"], {})
        self.assertEqual((risks["echo"], risks["add_note"], risks["delete_note"], risks["fail"]), (READ, WRITE, DANGER, WRITE))

    def test_a_good_call_becomes_a_reviewable_action(self):
        (action,) = self.manager.plan_actions([{"server": "notes", "tool": "add_note", "arguments": {"title": "Hi", "body": "there"}}])
        self.assertEqual((action["kind"], action["risk"], action["target"]), ("mcp_call", WRITE, "notes/add_note"))
        self.assertIn("title: Hi", action["detail"])
        self.assertFalse(action["auto_ok"])

    def test_auto_ok_needs_both_a_read_tool_and_the_servers_opt_in(self):
        call = [{"server": "notes", "tool": "echo", "arguments": {"text": "x"}}]
        self.assertFalse(self.manager.plan_actions(call)[0]["auto_ok"])
        self.manager.upsert(stdio(auto_read=True))
        self.assertTrue(self.manager.plan_actions(call)[0]["auto_ok"])
        write = [{"server": "notes", "tool": "add_note", "arguments": {"title": "x"}}]
        self.assertFalse(self.manager.plan_actions(write)[0]["auto_ok"], "a write tool must never auto-run")

    def test_invalid_plans_are_refused_before_anything_exists(self):
        cases = [
            [],
            [{"server": "notes", "tool": "add_note", "arguments": {}}],
            [{"server": "notes", "tool": "add_note", "arguments": {"title": "x", "evil": 1}}],
            [{"server": "notes", "tool": "nope", "arguments": {}}],
            [{"server": "ghost", "tool": "echo", "arguments": {"text": "x"}}],
            [{"server": "notes", "tool": "echo", "arguments": {"text": "x" * 500}}],
            [{"server": "notes", "tool": "echo", "arguments": {"text": "x"}, "shell": "rm -rf /"}],
            [{"server": "notes", "tool": "echo", "arguments": "text"}],
            "not a list",
            [{"server": "notes", "tool": "echo", "arguments": {"text": "x"}}] * 9,
        ]
        for calls in cases:
            with self.assertRaises(ValueError, msg=str(calls)[:80]):
                self.manager.plan_actions(calls)

    def test_a_disabled_server_cannot_be_planned_or_called(self):
        self.manager.upsert(stdio(enabled=False))
        with self.assertRaises(ValueError):
            self.manager.plan_actions([{"server": "notes", "tool": "echo", "arguments": {"text": "x"}}])

    def test_call_runs_the_tool(self):
        self.assertEqual(self.manager.call("notes", "echo", {"text": "hi"})["text"], "hi")

    def test_test_reports_the_tool_count(self):
        result = self.manager.test("notes")
        self.assertTrue(result["ok"])
        self.assertGreaterEqual(result["tools"], 6)

    def test_a_broken_server_is_reported_in_the_catalog_not_raised(self):
        self.manager.upsert({"id": "broken", "transport": "stdio", "command": "definitely-not-a-program-xyz"})
        catalog = self.manager.catalog()
        self.assertIn("broken", catalog["errors"])
        self.assertTrue(catalog["tools"])


if __name__ == "__main__":
    unittest.main()
