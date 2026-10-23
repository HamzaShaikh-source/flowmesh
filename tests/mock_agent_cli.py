"""A stand-in coding-agent CLI with deliberately awkward behaviour, for tests.

Usage mirrors a real agent: it reads its task from stdin (`--stdin`), an argument
(`--prompt TEXT`) or a file (`--file PATH`), prints what it received as JSON, then acts on
keywords in the task so tests can exercise the manager without any real model.
"""

import json
import os
import re
import subprocess
import sys
import time

argv = sys.argv[1:]

if argv[:1] == ["--version"]:
    print("mock-agent 1.2.3 (test)")
    sys.exit(0)
if argv[:2] == ["auth", "status"]:
    print("Logged in using MockPlan")
    sys.exit(0)
if argv[:2] == ["auth", "login"]:
    print("login flow would start here")
    sys.exit(0)

task = ""
if "--stdin" in argv:
    task = sys.stdin.read()
elif "--prompt" in argv:
    task = argv[argv.index("--prompt") + 1]
elif "--file" in argv:
    with open(argv[argv.index("--file") + 1], encoding="utf-8") as handle:
        task = handle.read()

leaked = sorted(k for k in os.environ if k.upper().startswith(("FLOWMESH_", "TYPESAFE_")))
print(json.dumps({"argv": argv, "cwd": os.getcwd(), "task": task, "leaked": leaked, "no_color": os.environ.get("NO_COLOR")}), flush=True)

def council_reply(text):
    """What a cooperative agent would answer to a council prompt (debate rounds or a judge scorecard)."""
    ids = re.findall(r"^(I\d+): ", text, re.M)
    own_match = re.search(r"Your own approaches are ([I0-9, ]+?)[ (:]", text)
    mine = set(re.findall(r"I\d+", own_match.group(1))) if own_match else set()
    others = [i for i in ids if i not in mine]
    if "distinct, concrete" in text:
        who = str(os.getpid())
        return {"ideas": [{"title": f"approach {who} {n}", "pitch": "a pitch", "research": ["r"], "stack": "py", "mvp": "m", "risks": "x"} for n in (1, 2)]}
    if "reviewing approaches" in text:
        return {"reviews": [{"id": i, "strengths": "s", "weaknesses": "w", "scores": {"impact": 7, "feasibility": 6, "novelty": 5, "demo": 8, "fit": 7}} for i in others]}
    if "were reviewed anonymously" in text:
        return {"revisions": [{"id": i, "withdraw": False, "response": "ok", "pitch": "better", "mvp": "better"} for i in ids]}
    if "Final vote" in text:
        return {"scores": [{"id": i, "score": 7} for i in others], "vote": others[0], "reason": "first other idea"}
    if "member of a panel judging" in text:
        keys = ["fit", "function", "quality", "testing", "docs", "security", "innovation"]
        return {"scores": {k: {"score": 7.0, "evidence": k} for k in keys}, "strengths": ["clear"], "improvements": [], "summary": "fine"}
    return None


reply = council_reply(task) if task else None
if reply is not None:
    print(json.dumps(reply), flush=True)
    sys.exit(0)

if "ANSI" in task:
    print("\x1b[31mred\x1b[0m \x1b]0;title\x07plain \x07bell \x00nul")
if m := re.search(r"WRITE:([\w.]+)", task):
    with open(m.group(1), "w", encoding="utf-8") as handle:
        handle.write("created by the mock agent\n")
if "SPLIT" in task:  # one character delivered in two separate writes
    sys.stdout.buffer.write(b"caf\xc3")
    sys.stdout.buffer.flush()
    time.sleep(0.3)
    sys.stdout.buffer.write(b"\xa9 ok\n")
    sys.stdout.buffer.flush()
if "BIG" in task:
    sys.stdout.write("A" * 400_000 + "\n")
if m := re.search(r"SLEEP:(\d+)", task):
    if "SPAWN" in task:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        with open("child.pid", "w") as handle:
            handle.write(str(child.pid))
    print("sleeping", flush=True)
    time.sleep(int(m.group(1)))
if "FAIL" in task:
    print("something went wrong", file=sys.stderr)
    sys.exit(3)
print("done")
