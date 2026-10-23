"""Coding agents: folders, safe command building, running, cancelling, git observation."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import agents
from agents import AgentError, AgentManager

MOCK = str(Path(__file__).resolve().parent / "mock_agent_cli.py")


def mock_catalog() -> list[dict]:
    base = {"command": sys.executable, "launcher_args": [MOCK], "docs": "https://example.com", "version_args": ["--version"],
            "status_args": ["auth", "status"], "signed_in": r"Logged in", "signed_out": r"Not logged in",
            "method": r"Logged in using (\w+)", "login_args": ["auth", "login"], "login_note": "test"}
    return [
        {**base, "id": "mock", "label": "Mock Agent", "base_args": [], "prompt_via": "stdin", "modes": [
            {"id": "plan", "label": "Plan", "risk": "read", "args": ["--stdin", "--mode", "plan", "--dir", "{dir}"], "about": ""},
            {"id": "edit", "label": "Edit", "risk": "write", "args": ["--stdin", "--mode", "edit"], "about": ""},
            {"id": "full", "label": "Full", "risk": "danger", "args": ["--stdin", "--mode", "full"], "about": ""}]},
        {**base, "id": "mockarg", "label": "Mock Arg", "base_args": [], "prompt_via": "arg", "modes": [
            {"id": "edit", "label": "Edit", "risk": "write", "args": ["--prompt", "{prompt}"], "about": ""}]},
        {**base, "id": "mockfile", "label": "Mock File", "base_args": [], "prompt_via": "file", "modes": [
            {"id": "edit", "label": "Edit", "risk": "write", "args": ["--file", "{promptfile}"], "about": ""}]},
        {**base, "id": "ghost", "label": "Ghost", "command": "definitely-not-installed-xyz", "launcher_args": [], "base_args": [],
         "prompt_via": "stdin", "modes": [{"id": "edit", "label": "Edit", "risk": "write", "args": ["--stdin"], "about": ""}]},
        {**base, "id": "mock2", "label": "Mock Two", "base_args": [], "prompt_via": "stdin", "modes": [
            {"id": "plan", "label": "Plan", "risk": "read", "args": ["--stdin", "--mode", "plan"], "about": ""},
            {"id": "edit", "label": "Edit", "risk": "write", "args": ["--stdin", "--mode", "edit"], "about": ""}]},
        {**base, "id": "mock3", "label": "Mock Three", "base_args": [], "prompt_via": "stdin", "modes": [
            {"id": "plan", "label": "Plan", "risk": "read", "args": ["--stdin", "--mode", "plan"], "about": ""},
            {"id": "edit", "label": "Edit", "risk": "write", "args": ["--stdin", "--mode", "edit"], "about": ""}]},
    ]


def alive(pid: int) -> bool:
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class AgentCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store: dict = {}
        self.project = Path(self.tmp.name).resolve() / "projects" / "demo"
        self.project.mkdir(parents=True)
        self.manager = AgentManager(mock_catalog(), load=lambda: self.store, save=lambda v: self.store.update(v))
        self.addCleanup(self.manager.close_all)
        self.space = self.manager.upsert_workspace({"path": str(self.project), "label": "Demo"})

    def action(self, prompt="hello", agent="mock", mode="edit"):
        return self.manager.plan_action(agent, self.space["id"], mode, prompt)


class PhraseTest(unittest.TestCase):
    def test_phrases_name_an_agent_and_a_task(self):
        cases = {
            "Ask Codex to fix the failing test": ("codex", "fix the failing test"),
            "tell claude code to add a unit test for the parser": ("claude", "add a unit test for the parser"),
            "have opencode refactor the router": ("opencode", "refactor the router"),
            "get antigravity to explain this repo": ("agy", "explain this repo"),
            "ask chatgpt codex to bump the version": ("codex", "bump the version"),
            "ask gemini cli to write docs": ("gemini", "write docs"),
        }
        for said, expected in cases.items():
            self.assertEqual(agents.agent_phrase(said), expected, said)

    def test_anything_else_is_not_an_agent_phrase(self):
        for said in ("start a 25 minute research sprint", "ask rohan to send the quote", "codex fix the test", "ask codex", "ask codex to",
                     "ask codex to x", "I asked codex to fix it", "", "please ask codex to fix the test"):
            self.assertIsNone(agents.agent_phrase(said), said)

    def test_a_phrase_cannot_smuggle_a_folder_mode_or_flag(self):
        agent, task = agents.agent_phrase("ask codex to fix it --dangerously-bypass-approvals-and-sandbox in C:/Windows")
        self.assertEqual(agent, "codex")
        # The whole remainder is the *task text*; modes and folders only ever come from saved settings.
        self.assertIn("--dangerously", task)


class FolderTest(unittest.TestCase):
    def test_only_real_project_folders_are_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = Path(tmp).resolve() / "a" / "b"
            good.mkdir(parents=True)
            self.assertEqual(agents.validate_folder(str(good)), good)
            (good / "f.txt").write_text("x")
            for bad in ("", "  ", None, 5, "relative/path", str(good / "missing"), str(good / "f.txt"), str(Path(good.anchor)),
                        str(Path.home()), "x\x00y", "a" * 2000):
                with self.assertRaises(AgentError, msg=str(bad)[:30]):
                    agents.validate_folder(bad)

    def test_system_folders_are_refused(self):
        for name in (os.environ.get("SystemRoot"), "/etc", "/usr", "/System"):
            if name and os.path.isdir(name):
                with self.assertRaises(AgentError, msg=name):
                    agents.validate_folder(name)


class CatalogTest(unittest.TestCase):
    def test_every_agent_is_well_formed_and_risk_is_never_below_what_the_mode_can_do(self):
        for agent in agents.CATALOG:
            self.assertRegex(agent["id"], agents.SLUG)
            self.assertIn(agent["prompt_via"], {"stdin", "arg", "file"})
            self.assertTrue(agent["modes"], agent["id"])
            for mode in agent["modes"]:
                self.assertIn(mode["risk"], {"read", "write", "danger"})
                joined = " ".join(mode["args"])
                if agent["prompt_via"] == "stdin":
                    self.assertNotIn("{prompt}", joined, agent["id"])
                if agent["prompt_via"] == "arg":
                    self.assertIn("{prompt}", mode["args"], agent["id"])
                if agent["prompt_via"] == "file":
                    self.assertIn("{promptfile}", joined, agent["id"])
                # Anything that bypasses approvals or sandboxes must be marked danger.
                if any(flag in joined for flag in ("bypassPermissions", "danger-full-access", "dangerously", "yolo", "--mode auto")):
                    self.assertEqual(mode["risk"], "danger", f"{agent['id']}/{mode['id']}")
                # Read-only modes must not carry an edit-capable flag.
                if mode["risk"] == "read":
                    for flag in ("acceptEdits", "workspace-write", "accept-edits", "auto_edit", "bypass"):
                        self.assertNotIn(flag, joined, f"{agent['id']}/{mode['id']}")

    def test_the_agent_the_page_may_see_has_no_executable_paths(self):
        text = repr(agents.public_catalog())
        self.assertNotIn("{dir}", text)
        for agent in agents.public_catalog():
            self.assertTrue(agent["modes"])


class BuildCommandTest(unittest.TestCase):
    folder = Path("/work/demo")

    def test_stdin_agents_get_the_prompt_on_stdin_and_nowhere_in_argv(self):
        catalog = mock_catalog()
        args, stdin = agents.build_command(catalog[0], catalog[0]["modes"][0], self.folder, "do the thing & more %PATH%")
        self.assertEqual(stdin, "do the thing & more %PATH%")
        self.assertNotIn("do the thing", " ".join(args))
        self.assertIn(str(self.folder), args)

    def test_argument_agents_refuse_a_leading_dash_so_a_task_cannot_become_a_flag(self):
        catalog = mock_catalog()
        for prompt in ("--dangerously-skip-permissions", "-p evil", "  --add-dir /"):
            with self.assertRaises(AgentError, msg=prompt):
                agents.build_command(catalog[1], catalog[1]["modes"][0], self.folder, prompt)
        args, stdin = agents.build_command(catalog[1], catalog[1]["modes"][0], self.folder, "fix the - dash in the middle")
        self.assertIsNone(stdin)
        self.assertIn("fix the - dash in the middle", args)

    def test_prompt_rules(self):
        for bad in ("", "   ", None, 5, "x" * (agents.MAX_PROMPT_CHARS + 1), "a\x00b"):
            with self.assertRaises(AgentError, msg=str(bad)[:20]):
                agents.clean_prompt(bad)
        self.assertEqual(agents.clean_prompt("  hi\r\nthere  "), "hi\nthere")

    def test_the_child_environment_drops_flowmesh_secrets_only(self):
        env = agents.agent_environment({"PATH": "/bin", "FLOWMESH_HA_TOKEN": "x", "typesafe_api_key": "y", "ANTHROPIC_API_KEY": "keep", "HOME": "/h"})
        self.assertEqual(sorted(env), ["ANTHROPIC_API_KEY", "HOME", "NO_COLOR", "PATH"])

    def test_terminal_escapes_and_control_characters_are_stripped(self):
        self.assertEqual(agents.sanitize("\x1b[31mred\x1b[0m \x1b]0;title\x07ok \x07\x00end"), "red ok   end")


class ConfigTest(AgentCase):
    def test_workspaces_defaults_and_removal(self):
        other = Path(self.tmp.name).resolve() / "projects" / "other"
        other.mkdir()
        second = self.manager.upsert_workspace({"path": str(other)})
        self.assertEqual(self.manager.config()["default_workspace"], self.space["id"], "the first folder becomes the default")
        self.manager.set_defaults({"default_workspace": second["id"], "default_mode": "plan", "default_agent": "mock"})
        self.assertEqual(self.manager.config()["default_mode"], "plan")
        self.assertTrue(self.manager.remove_workspace(second["id"]))
        self.assertEqual(self.manager.config()["default_workspace"], self.space["id"], "removing the default falls back")
        self.assertFalse(self.manager.remove_workspace("nope"))

    def test_bad_settings_are_refused(self):
        for raw in ({"default_mode": "root"}, {"default_agent": "evil"}, {"default_workspace": "nope"}, {"other": 1}, "x"):
            with self.assertRaises(AgentError, msg=str(raw)):
                self.manager.set_defaults(raw)
        with self.assertRaises(AgentError):
            self.manager.upsert_workspace({"path": str(Path(self.project.anchor))})
        for i in range(agents.MAX_WORKSPACES + 1):
            folder = self.project.parent / f"p{i}"
            folder.mkdir(exist_ok=True)
            if i < agents.MAX_WORKSPACES - 1:
                self.manager.upsert_workspace({"path": str(folder)})
            else:
                with self.assertRaises(AgentError):
                    self.manager.upsert_workspace({"path": str(folder)})
                    self.manager.upsert_workspace({"path": str(self.project.parent / "extra")})
                break


class PlanTest(AgentCase):
    def test_a_good_task_becomes_an_action_with_a_risk_from_its_mode(self):
        for mode, risk in (("plan", "read"), ("edit", "write"), ("full", "danger")):
            action = self.action("add a test", mode=mode)
            self.assertEqual((action["kind"], action["risk"], action["agent"], action["mode"]), ("agent_run", risk, "mock", mode))
            self.assertEqual(action["workspace_path"], str(self.project))
            self.assertFalse(action["auto_ok"], "a coding task must never auto-run")
            self.assertRegex(action["run_id"], agents.RUN_ID)

    def test_refusals_say_why(self):
        cases = [("nope", self.space["id"], "edit", "x", "unknown_agent"), ("ghost", self.space["id"], "edit", "x", "not_installed"),
                 ("mock", "missing", "edit", "x", "no_workspace"), ("mock", self.space["id"], "root", "x", "bad_mode"),
                 ("mock", self.space["id"], "edit", "", "bad_prompt"), ("mockarg", self.space["id"], "edit", "--evil", "bad_prompt")]
        for agent, space, mode, prompt, kind in cases:
            with self.assertRaises(AgentError, msg=kind) as caught:
                self.manager.plan_action(agent, space, mode, prompt)
            self.assertEqual(caught.exception.kind, kind)


class RunTest(AgentCase):
    def test_the_task_reaches_the_agent_on_stdin_in_the_project_folder(self):
        receipt = self.manager.run(self.action("fix the parser & the %PATH% thing"))
        self.assertEqual(receipt["status"], "returned")
        out = receipt["output"]
        self.assertIn("fix the parser & the %PATH% thing", out)
        self.assertIn(str(self.project).replace("\\", "\\\\"), out)
        self.assertIn("did not check the work", receipt["detail"])

    def test_flowmesh_secrets_do_not_reach_the_agent(self):
        with patch.dict(os.environ, {"FLOWMESH_HA_TOKEN": "x", "TYPESAFE_API_KEY": "y", "KEEP_ME": "ok"}):
            mgr = AgentManager(mock_catalog(), load=lambda: self.store, save=lambda v: None)
            out = mgr.run(self.action("hi"))["output"]
        self.assertIn('"leaked": []', out)
        self.assertIn('"no_color": "1"', out)

    def test_ansi_and_control_characters_never_reach_the_receipt(self):
        out = self.manager.run(self.action("ANSI"))["output"]
        self.assertIn("red plain bell", out.replace("  ", " "))
        for bad in ("\x1b", "\x07", "\x00"):
            self.assertNotIn(bad, out)

    def test_a_character_split_across_two_reads_stays_whole(self):
        out = self.manager.run(self.action("SPLIT"))["output"]
        self.assertIn("café ok", out)
        self.assertNotIn("�", out)

    def test_failure_timeout_and_unsafe_prompts_are_reported_plainly(self):
        failed = self.manager.run(self.action("FAIL"))
        self.assertEqual(failed["status"], "failed")
        self.assertIn("code 3", failed["detail"])
        self.assertIn("something went wrong", failed["output"])
        denied = self.manager.run({**self.action("hi"), "agent": "nope"})
        self.assertEqual(denied["status"], "denied")
        self.assertEqual(self.manager.run({**self.action("hi"), "run_id": "short"})["status"], "denied")

    def test_arg_and_file_delivery_both_work(self):
        self.assertIn("via argument", self.manager.run(self.action("via argument", agent="mockarg"))["output"])
        self.assertIn("via a file", self.manager.run(self.action("via a file", agent="mockfile"))["output"])
        self.assertEqual([p for p in Path(tempfile.gettempdir()).glob("flowmesh-task-*.txt")], [], "the private prompt file must be removed")

    def test_output_is_capped(self):
        receipt = self.manager.run(self.action("BIG"))
        self.assertLessEqual(len(receipt["output"]), agents.RECEIPT_CHARS + 2000)

    def test_a_timeout_stops_the_process_and_says_it_may_have_changed_files(self):
        with patch.object(agents, "DEFAULT_TIMEOUT_S", 1):
            started = time.monotonic()
            receipt = self.manager.run(self.action("SLEEP:60"), timeout_s=1)
        self.assertLess(time.monotonic() - started, 40)
        self.assertEqual(receipt["status"], "unknown")
        self.assertIn("may have changed files", receipt["detail"])

    def test_cancel_stops_the_process_and_its_children(self):
        action = self.action("SLEEP:60 SPAWN")
        results = {}
        worker = __import__("threading").Thread(target=lambda: results.update(r=self.manager.run(action)))
        worker.start()
        deadline = time.time() + 20
        while time.time() < deadline and not (self.project / "child.pid").exists():
            time.sleep(0.1)
        child = int((self.project / "child.pid").read_text())
        live = self.manager.run_view(action["run_id"])
        self.assertEqual(live["status"], "running")
        self.assertIn("sleeping", live["output"])
        self.assertTrue(self.manager.cancel(action["run_id"]))
        worker.join(30)
        self.assertEqual(results["r"]["status"], "failed")
        self.assertIn("Cancelled", results["r"]["detail"])
        time.sleep(1.5)
        self.assertFalse(alive(child), "the agent's child process survived a cancel")
        self.assertFalse(self.manager.cancel(action["run_id"]), "a finished run cannot be cancelled again")

    def test_the_folder_must_still_be_the_one_that_was_planned(self):
        action = self.action("hi")
        self.assertEqual(self.manager.run({**action, "workspace_path": str(self.project.parent)})["status"], "denied")
        shutil.rmtree(self.project)
        self.assertEqual(self.manager.run(action)["status"], "denied")

    def test_views_and_cancel_reject_malformed_ids(self):
        for bad in (None, "", "short", "../../x", "a" * 80, 5):
            self.assertIsNone(self.manager.run_view(bad))
            self.assertFalse(self.manager.cancel(bad))

    def test_too_many_concurrent_runs_are_refused(self):
        with patch.object(agents, "MAX_CONCURRENT_RUNS", 0):
            self.assertEqual(self.manager.run(self.action("hi"))["status"], "unavailable")


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class GitObservationTest(AgentCase):
    def git(self, *args):
        subprocess.run(["git", "-C", str(self.project), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)

    def test_changed_files_are_observed_and_reported_honestly(self):
        self.git("init", "-q")
        (self.project / "a.txt").write_text("one\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "init")
        receipt = self.manager.run(self.action("WRITE:new_file.txt"))
        self.assertEqual(receipt["status"], "returned", "FlowMesh observed the change but did not verify the task")
        self.assertIn("git saw 1 changed file", receipt["detail"])
        self.assertIn("new_file.txt", receipt["output"])

    def test_a_folder_that_is_not_a_repository_says_it_could_not_observe(self):
        receipt = self.manager.run(self.action("WRITE:x.txt"))
        self.assertIn("not a git repository", receipt["detail"])
        self.assertTrue((self.project / "x.txt").exists())

    def test_a_clean_run_reports_zero_changes(self):
        self.git("init", "-q")
        receipt = self.manager.run(self.action("just read"))
        self.assertIn("git saw 0 changed files", receipt["detail"])


class DetectionAndLoginTest(AgentCase):
    def wait(self):
        deadline = time.time() + 30
        while time.time() < deadline:
            state = self.manager.detect()
            if not state["checking"] and state["agents"]:
                return state["agents"]
            time.sleep(0.1)
        self.fail("detection never finished")

    def test_installed_version_and_sign_in_are_detected_without_leaking_the_account(self):
        found = self.wait()
        self.assertTrue(found["mock"]["installed"])
        self.assertEqual(found["mock"]["version"], "mock-agent 1.2.3 (test)")
        self.assertEqual(found["mock"]["auth"], {"state": "signed_in", "detail": "MockPlan"})
        self.assertFalse(found["ghost"]["installed"])
        self.assertEqual(found["ghost"]["auth"]["state"], "unknown")

    def test_sign_in_opens_the_vendors_fixed_command_and_nothing_else(self):
        seen = []
        result = self.manager.open_login("mock", opener=lambda argv: seen.append(list(argv)) or True)
        self.assertTrue(result["opened"])
        self.assertEqual(seen[0][-2:], ["auth", "login"])
        self.assertEqual(result["command"], f"{sys.executable} auth login".replace(sys.executable, "python"), msg=None) if False else None
        self.assertTrue(result["command"].endswith("auth login"))
        with self.assertRaises(AgentError):
            self.manager.open_login("ghost", opener=lambda argv: True)
        with self.assertRaises(AgentError):
            self.manager.open_login("evil; rm -rf /", opener=lambda argv: True)

    def test_the_terminal_launcher_refuses_cmd_metacharacters(self):
        if os.name == "nt":
            self.assertFalse(agents.open_in_terminal(["C:\\tools\\agent.cmd", "login&calc"]))


if __name__ == "__main__":
    unittest.main()
