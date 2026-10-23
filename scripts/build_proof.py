"""Build web/proof.json: the numbers behind the Proof section, taken from real runs, never typed in.

    python scripts/build_proof.py            # runs both test suites (about three minutes) and reads the rest
    python scripts/build_proof.py --skip-tests

What it reads:
  * the two test suites (`python -m unittest discover`, `npm test`), parsed from their own summaries;
  * docs/EVAL.md (refresh it first with `python eval/run_eval.py`);
  * git (commit, count, first commit date) and, when the GitHub CLI is available, the latest release, its
    SHA256SUMS.txt and the latest CI runs on main.

What it will not do: invent a measurement. The "still being measured" list is kept in this file on purpose, so
a claim cannot quietly drift out of it. The page shows the date and commit the data came from.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "proof.json"
REPO = "HamzaShaikh-source/flowmesh"
SKIP_TESTS = "--skip-tests" in sys.argv

sys.path.insert(0, str(ROOT))
import flowmesh_config  # noqa: E402


def run(cmd: list[str], timeout: int = 900) -> str:
    done = subprocess.run(cmd, cwd=ROOT, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout)
    return (done.stdout or "") + (done.stderr or "")


def git(*args: str) -> str:
    return run(["git", *args]).strip()


def gh(*args: str) -> str | None:
    if not shutil.which("gh"):
        return None
    done = subprocess.run(["gh", *args], cwd=ROOT, capture_output=True, encoding="utf-8", errors="replace", timeout=120)
    return done.stdout if done.returncode == 0 else None


def test_counts() -> dict:
    if SKIP_TESTS:
        previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
        return previous.get("tests", {})
    py = run([sys.executable, "-m", "unittest", "discover", "-s", "tests"])
    ran = re.search(r"Ran (\d+) tests? in ([\d.]+)s", py)
    py_ok = bool(re.search(r"^OK\b", py, re.M))
    node = run(["npm", "test"] if sys.platform != "win32" else ["npm.cmd", "test"])
    counts = {k: int(v) for k, v in re.findall(r"ℹ (tests|pass|fail) (\d+)", node)}
    return {
        "python": {"ran": int(ran.group(1)) if ran else 0, "ok": py_ok, "seconds": float(ran.group(2)) if ran else 0},
        "node": {"ran": counts.get("tests", 0), "passed": counts.get("pass", 0), "failed": counts.get("fail", 0)},
    }


def eval_numbers() -> dict:
    text = (ROOT / "docs" / "EVAL.md").read_text(encoding="utf-8")
    pick = lambda pattern: (re.search(pattern, text) or [None, None])[1]
    return {
        "generated": pick(r"at \*\*([^*]+)\*\*"), "commit": pick(r"from commit \*\*`([0-9a-f]+)`"),
        "verdict": pick(r"\*\*Verdict: ([^*]+)\*\*"),
        "parity": pick(r"Identical Python/Node plans \| ([\d ]+/ \d+)"), "golden": pick(r"Stored plans reproduced exactly \| ([\d ]+/ \d+)"),
        "refusals": pick(r"Destructive or forbidden commands refused \| ([\d ]+/ \d+)"),
        "routed": pick(r"Routed to a plan \| ([\d ]+/ \d+)"), "abstained": pick(r"Abstained \(no plan, nothing shown\) \| ([\d ]+/ \d+)"),
        "http_pass": len(re.findall(r"\| pass \|$", text, re.M)), "http_rows": len(re.findall(r"^\| (?:GET|POST) .+\| (?:pass|FAIL) \|$", text, re.M)),
    }


def release_info() -> dict | None:
    raw = gh("release", "view", "--repo", REPO, "--json", "tagName,publishedAt,url,assets")
    if not raw:
        return None
    data = json.loads(raw)
    sums_text = gh("release", "download", data["tagName"], "--repo", REPO, "--pattern", "SHA256SUMS.txt", "--output", "-") or ""
    sums = {}
    for line in sums_text.splitlines():
        match = re.match(r"([0-9a-f]{64}) \*?(.+)$", line.strip())
        if match:
            sums[match.group(2)] = match.group(1)
    return {
        "tag": data["tagName"], "published": data["publishedAt"], "url": data["url"],
        "assets": [{"name": a["name"], "bytes": a["size"], "sha256": sums.get(a["name"], "")} for a in data["assets"]],
    }


def ci_runs() -> list[dict]:
    raw = gh("run", "list", "--repo", REPO, "--branch", "main", "--limit", "5", "--json", "conclusion,headSha,createdAt,url,workflowName,event")
    return [{"conclusion": r["conclusion"], "sha": r["headSha"][:7], "at": r["createdAt"], "url": r["url"], "event": r["event"]} for r in json.loads(raw)] if raw else []


# What is deliberately NOT measured, and why. Kept here so a claim cannot drift out of this list without a diff.
STILL_MEASURING = [
    {"title": "Words dictated with Wispr Flow while building this", "why": "Only Wispr's own Insights can show this. The app can read your local Wispr history, but a self-computed count is not the verified one, so the builder supplies the Insights card."},
    {"title": "A real coding-agent answer through FlowMesh", "why": "The agent plumbing is tested against mock CLIs and a real Codex run started and finished, but Codex's own Windows sandbox failed to read the test file on the build machine, so no real answer has come through yet."},
    {"title": "Relays and councils with real models", "why": "Tested end to end against scripted and mock agents in both runtimes; never run with real models, so how useful the votes and scores are is unmeasured."},
    {"title": "MCP servers against real services", "why": "The protocol client is tested against a mock server. Discord, Slack, Notion and Switch are templates that were never run against a real workspace."},
    {"title": "Wispr key press into the capture field, and the wake word hearing a real voice", "why": "The harness and the recogniser are tested with typed events and a fake recogniser; nobody has spoken to either on record."},
    {"title": "Wispr account sign-in after the person approves", "why": "Discovery, registration and the redirect to Wispr's real login page were checked against Wispr's live servers; the token exchange after sign-in was not re-verified."},
    {"title": "Windows system-volume keys and real tab capture", "why": "Tested with injected fakes; the automation environment blocks tab capture and no real volume change was observed."},
    {"title": "Plan quality against human judgement", "why": "There is no labelled corpus of dictated commands with correct plans. The eval measures routing, parity and safety invariants, not whether a plan matches intent."},
    {"title": "Time saved", "why": "No measurement exists, so none is claimed anywhere."},
]


def main() -> None:
    tests = test_counts()
    ev = eval_numbers()
    release = release_info()
    first = git("log", "--reverse", "--format=%aI", "--max-count=1", "--diff-filter=A", "--", "README.md") or git("log", "--reverse", "--format=%aI").splitlines()[0]
    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "commit": git("rev-parse", "--short", "HEAD"),
        "version": flowmesh_config.VERSION,
        "commits": int(git("rev-list", "--count", "HEAD") or 0),
        "first_commit": first,
        "tests": tests,
        "eval": ev,
        "release": release,
        "ci": ci_runs(),
        "still_measuring": STILL_MEASURING,
    }
    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    t = tests
    print(f"wrote {OUT.relative_to(ROOT)} commit={data['commit']} version={data['version']} tests py={t.get('python', {}).get('ran')} node={t.get('node', {}).get('ran')} "
          f"release={release and release['tag']} ci={len(data['ci'])} eval={ev['parity']}")


if __name__ == "__main__":
    main()
