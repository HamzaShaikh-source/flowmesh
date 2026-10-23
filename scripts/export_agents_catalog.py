"""Write electron/agents_catalog.js from agents.py so the two runtimes can never disagree.

Run:  python scripts/export_agents_catalog.py
tests/test_agents_parity.py fails when the committed file is stale.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import agents  # noqa: E402
import council  # noqa: E402
import wake  # noqa: E402

HEADER = """'use strict';
/**
 * The coding agents FlowMesh can drive. GENERATED from agents.py by
 * scripts/export_agents_catalog.py; do not edit by hand (tests/test_agents_parity.py
 * fails when this file is stale).
 */

"""


def render() -> str:
    body = "const CATALOG = " + json.dumps(agents.CATALOG, indent=2) + ";\n\n"
    body += "const ALIASES = " + json.dumps(agents.ALIASES, indent=2) + ";\n\n"
    body += "module.exports = { CATALOG, ALIASES };\n"
    return HEADER + body


def render_wake() -> str:
    header = HEADER.replace("The coding agents FlowMesh can drive. GENERATED from agents.py", "The wake-word listener script and constants. GENERATED from wake.py")
    parts = ["const SCRIPT = " + json.dumps(wake.SCRIPT) + ";",
             "const WAKE_PHRASES = " + json.dumps(wake.WAKE_PHRASES) + ";",
             "const CONFIDENCE_FLOOR = " + json.dumps(wake.CONFIDENCE_FLOOR) + ";",
             "module.exports = { SCRIPT, WAKE_PHRASES, CONFIDENCE_FLOOR };"]
    return header + (chr(10) * 2).join(parts) + chr(10)


def render_council() -> str:
    header = HEADER.replace("The coding agents FlowMesh can drive. GENERATED from agents.py", "The council prompts, rubric and limits. GENERATED from council.py")
    names = ["PROPOSE", "CRITIQUE", "REBUT", "VOTE", "RUBRIC", "SCALE", "JUDGE_SYSTEM"]
    parts = [f"const {n} = " + json.dumps(getattr(council, n)) + ";" for n in names]
    parts.append("const CRIT = " + json.dumps(list(council.CRIT)) + ";")
    parts.append("const CRITERIA = " + json.dumps([list(c) for c in council.CRITERIA], indent=2) + ";")
    parts.append("const LIMITS = " + json.dumps({"COUNCIL_PROMPT_CHARS": council.COUNCIL_PROMPT_CHARS, "CALL_TIMEOUT_S": council.CALL_TIMEOUT_S, "MIN_AGENTS": council.MIN_AGENTS, "MAX_AGENTS": council.MAX_AGENTS}) + ";")
    parts.append("module.exports = { " + ", ".join(names + ["CRIT", "CRITERIA", "LIMITS"]) + " };")
    return header + (chr(10) * 2).join(parts) + chr(10)


if __name__ == "__main__":
    (ROOT / "electron" / "agents_catalog.js").write_text(render(), encoding="utf-8", newline="\n")
    (ROOT / "electron" / "wake_script.js").write_text(render_wake(), encoding="utf-8", newline=chr(10))
    (ROOT / "electron" / "council_text.js").write_text(render_council(), encoding="utf-8", newline=chr(10))
    print("wrote electron/agents_catalog.js, wake_script.js and council_text.js")
