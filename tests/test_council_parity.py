"""The Python and Electron councils must read, score and report identically."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import council
from scripts import export_agents_catalog

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = (ROOT / "electron" / "runtime.js").read_text(encoding="utf-8")
BRIDGE = (ROOT / "bridge.py").read_text(encoding="utf-8")
NODE = shutil.which("node")


def node(expression: str):
    out = subprocess.run(["node", "-e", f"process.stdout.write(JSON.stringify({expression}))"], cwd=ROOT,
                         capture_output=True, encoding="utf-8", check=True).stdout
    return json.loads(out)


def js(call: str, arg):
    return node(f"(() => {{ const c = require('./electron/council.js'); const a = {json.dumps(arg)}; return {call}; }})()")


def judge_reply(scores, improvements=()):
    return "banner\n" + json.dumps({"scores": {k: {"score": v, "evidence": f"{k} evidence"} for k, v in scores.items()},
                                    "strengths": ["clear", "tested"], "improvements": list(improvements), "summary": "ok"})


@unittest.skipUnless(NODE, "node is not installed")
class CouncilParityTest(unittest.TestCase):
    def test_the_generated_text_is_not_stale_and_equal(self):
        committed = (ROOT / "electron" / "council_text.js").read_text(encoding="utf-8")
        self.assertEqual(committed.replace(chr(13) + chr(10), chr(10)), export_agents_catalog.render_council(), "run: python scripts/export_agents_catalog.py")
        for name in ("PROPOSE", "CRITIQUE", "REBUT", "VOTE", "RUBRIC", "SCALE", "JUDGE_SYSTEM"):
            self.assertEqual(node(f"require('./electron/council_text.js').{name}"), getattr(council, name), name)
        self.assertEqual(node("require('./electron/council.js').judgeSystem()"), council.judge_system())

    def test_extraction_agrees(self):
        cases = [('banner {"ideas": [{"title": "..."}]} x {"ideas": [{"title": "Real"}]} bye', "ideas"), ("", "ideas"), ("no json", "ideas"),
                 ('{bad', "ideas"), ('{"other": 1}', "ideas"), ('{"ideas": ["a\nb"]}', "ideas"), ('x {"a": {"vote": "I2"}} y', "vote"),
                 ('{"vote": "I1", "n": {"vote": "I2"}}', "vote"), ('{"a": "}{"} {"vote": "I3"}', "vote")]
        got = js("a.map(([t, k]) => c.extractObject(t, k))", cases)
        self.assertEqual(got, [council.extract_object(t, k) for t, k in cases])

    def test_tally_agrees(self):
        ideas = [{"id": f"I{n}", "title": f"t{n}"} for n in (1, 2, 3, 4)]
        ideas[3]["withdrawn"] = True
        reviews = [{"id": "I1", "scores": {"impact": 7, "fit": 6}}, {"id": "I2", "scores": {"impact": 7, "fit": 6.5}}, {"id": "I3", "scores": {}}]
        cases = [({"a": "I2", "b": "I2", "c": "I1"}, {}), ({"a": "I3", "b": "I2"}, {"I3": [5.0], "I2": [8.0]}), ({"a": "I3", "b": "I2"}, {}),
                 ({"a": "I1", "b": "I2"}, {"I1": [7.13], "I2": [7.12]})]
        for votes, scores in cases:
            self.assertEqual(js("c.tally(a[0], a[1], a[2], a[3])", [ideas, votes, reviews, scores]), council.tally(ideas, votes, reviews, scores), (votes, scores))

    def test_judge_parsing_and_aggregation_agree(self):
        keys = council.KEYS
        replies = [judge_reply({k: 7.0 for k in keys}), judge_reply({k: 3 for k in keys}), judge_reply({k: 9.5 for k in keys}),
                   judge_reply({k: 99 for k in keys}), judge_reply({**{k: 6.25 for k in keys}, "docs": "great"}),
                   judge_reply({k: 8.25 for k in keys}, [{"title": "Add tests", "detail": "d", "severity": "major"}, {"title": "Fix bug", "detail": "e", "severity": "blocker"}]),
                   "I refuse", judge_reply({k: 2.5 for k in list(keys)[:-1]})]
        py = [council.parse_judge(r) for r in replies]
        self.assertEqual(js("a.map((r) => c.parseJudge(r))", replies), py)
        good = [p for p in py if p]
        caps = {"testing": (3.0, "no automated tests were found"), "docs": (6.0, "x")}
        caps_js = {k: list(v) for k, v in caps.items()}
        self.assertEqual(js("c.aggregate(a[0], a[1])", [good, caps_js]), council.aggregate(good, caps))
        self.assertEqual(js("c.aggregate(a[0], a[1])", [good[:1], {}]), council.aggregate(good[:1], {}))

    def test_the_folder_audit_and_caps_agree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src").mkdir()
            (root / "src" / "app.py").write_text("def f():\n    return 1  # TODO later\n", encoding="utf-8")
            (root / "src" / "big.js").write_text("x\n" * 3000, encoding="utf-8")
            (root / "tests").mkdir()
            (root / "tests" / "test_app.py").write_text("def test_f():\n    assert True\n", encoding="utf-8")
            (root / "web").mkdir()
            (root / "web" / "app.spec.ts").write_text("it('x', () => {})\n", encoding="utf-8")
            (root / "web" / "index.html").write_text("<p>hi</p>\n", encoding="utf-8")
            (root / "README.md").write_text("# App\n\nInstall and run it. Tests: pytest. " + "x" * 200, encoding="utf-8")
            (root / ".gitignore").write_text("*.pyc\n", encoding="utf-8")
            (root / "LICENSE").write_text("MIT", encoding="utf-8")
            (root / "debug.log").write_text("noise", encoding="utf-8")
            (root / "src" / "leak.py").write_text('K = "' + "ghp_" + "a" * 36 + '"\n', encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "skip.js").write_text("x", encoding="utf-8")
            py = council.audit_folder(root)
            got = js("c.auditFolder(a)", str(root))
        self.assertEqual(json.loads(json.dumps(got, sort_keys=True)), json.loads(json.dumps(py, sort_keys=True)))
        self.assertEqual(js("c.capsFromAudit(a)", py), {k: list(v) for k, v in council.caps_from_audit(py).items()})
        self.assertEqual(js("c.evidence('the brief', a)", py), council.evidence("the brief", py))

    def test_reports_agree(self):
        labels = {"a": "Agent A", "b": "Agent B"}
        debate = {"kind": "debate", "problem": "How do we parse it?", "silent": ["b"],
                  "ideas": [{"id": "I1", "author": "a", "title": "Hand parser", "pitch": "p", "mvp": "m", "stack": "py", "risks": "r"},
                            {"id": "I2", "author": "b", "title": "Grammar", "pitch": "p2", "mvp": "m2", "stack": "py", "risks": "r2"}],
                  "ranking": [{"id": "I1", "title": "Hand parser", "votes": 1, "score": 7.13}, {"id": "I2", "title": "Grammar", "votes": 0, "score": 6.0}],
                  "votes": [{"voter": "b", "vote": "I1", "reason": "simpler"}], "winner": "I1"}
        self.assertEqual(js("c.reportDebate(a[0], a[1])", [debate, labels]), council.report_debate(debate, labels))
        judges = [council.parse_judge(judge_reply({k: v for k in council.KEYS}, [{"title": "Add tests", "detail": "d", "severity": "major"}])) for v in (6.0, 8.5)]
        card = council.aggregate(judges, {"testing": (3.0, "no automated tests were found")})
        card.update(kind="judge", judges=[{"agent": "a", "overall": 60.0, "summary": "s"}, {"agent": "b", "overall": 85.0, "summary": "t"}],
                    failed_judges=["b"], measurements={"count": 3, "loc": 40, "test_files": 0, "possible_secrets": 1})
        self.assertEqual(js("c.reportJudge(a[0], a[1])", [card, labels]), council.report_judge(card, labels))

    def test_the_routes_are_the_same(self):
        self.assertIn('"/api/agents/council"', BRIDGE)
        self.assertIn("'/api/agents/council'", RUNTIME)


if __name__ == "__main__":
    unittest.main()
