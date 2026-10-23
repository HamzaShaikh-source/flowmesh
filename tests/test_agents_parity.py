"""The Python bridge and the Electron runtime must offer the same coding-agent behaviour."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import agents
from scripts import export_agents_catalog

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = (ROOT / "bridge.py").read_text(encoding="utf-8")
RUNTIME = (ROOT / "electron" / "runtime.js").read_text(encoding="utf-8")

NODE = shutil.which("node")


def node(expression: str):
    out = subprocess.run(["node", "-e", f"process.stdout.write(JSON.stringify({expression}))"], cwd=ROOT,
                         capture_output=True, encoding="utf-8", check=True).stdout
    return json.loads(out)


@unittest.skipUnless(NODE, "node is not installed")
class AgentsParityTest(unittest.TestCase):
    def test_the_generated_catalog_is_not_stale(self):
        committed = (ROOT / "electron" / "agents_catalog.js").read_text(encoding="utf-8")
        self.assertEqual(committed.replace("\r\n", "\n"), export_agents_catalog.render(),
                         "run: python scripts/export_agents_catalog.py")

    def test_the_catalog_is_identical_in_both_runtimes(self):
        self.assertEqual(node("require('./electron/agents.js').CATALOG"), agents.CATALOG)
        self.assertEqual(node("require('./electron/agents.js').ALIASES"), agents.ALIASES)

    def test_the_public_catalog_is_identical(self):
        self.assertEqual(node("require('./electron/agents.js').publicCatalog()"), agents.public_catalog())

    def test_the_phrase_grammar_agrees_on_every_case(self):
        phrases = [
            "Ask Codex to fix the failing test", "tell claude code to add a unit test", "have opencode refactor the router",
            "get antigravity to explain this repo", "ask chatgpt codex to bump the version", "ask gemini cli to write docs",
            "let aider add types", "ask codex", "ask bob to fix it", "open notepad", "codex fix the test", "ask codex to to x y",
            "ASK CODEX TO   fix   spacing  ", "ask codex to ab", "ask claude to\nwrite a poem about\nnewlines",
        ]
        expected = [agents.agent_phrase(p) for p in phrases]
        got = node(f"{json.dumps(phrases)}.map(p => require('./electron/agents.js').agentPhrase(p))")
        self.assertEqual(got, [list(e) if e else None for e in expected])

    def test_command_building_agrees(self):
        cases = [("claude", "plan", "fix it"), ("codex", "edit", "a b"), ("agy", "full", "do"), ("aider", "edit", "x"),
                 ("gemini", "plan", "y"), ("opencode", "edit", "z")]
        for agent_id, mode_id, prompt in cases:
            agent = agents.agent_by_id(agents.CATALOG, agent_id)
            mode = next(m for m in agent["modes"] if m["id"] == mode_id)
            args, stdin = agents.build_command(agent, mode, Path("/work/p"), prompt, "/tmp/task.txt")
            got = node(f"(() => {{ const a = require('./electron/agents.js'); const g = a.agentById(a.CATALOG, {json.dumps(agent_id)}); "
                       f"return a.buildCommand(g, g.modes.find(m => m.id === {json.dumps(mode_id)}), '/work/p', {json.dumps(prompt)}, '/tmp/task.txt'); }})()")
            args = [a.replace("\\", "/") for a in args]  # Path() renders the folder with the host separator
            self.assertEqual(got, [args, stdin], f"{agent_id}/{mode_id}")

    def test_the_http_routes_are_the_same(self):
        py = set(re.findall(r'"(/api/agents[^"]*)"', BRIDGE))
        js = set(re.findall(r"'(/api/agents[^']*)'", RUNTIME))
        self.assertEqual(py, js)

    def test_both_runtimes_drop_flowmesh_secrets_from_the_child(self):
        env = {"PATH": "x", "FLOWMESH_KEY": "1", "typesafe_token": "2", "HOME": "h"}
        js = node(f"require('./electron/agents.js').agentEnvironment({json.dumps(env)})")
        self.assertEqual(js, agents.agent_environment(env))
        self.assertNotIn("FLOWMESH_KEY", js)


if __name__ == "__main__":
    unittest.main()
