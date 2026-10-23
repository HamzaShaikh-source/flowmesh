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
