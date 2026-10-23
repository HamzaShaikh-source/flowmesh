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


if __name__ == "__main__":
    (ROOT / "electron" / "agents_catalog.js").write_text(render(), encoding="utf-8", newline="\n")
    print("wrote electron/agents_catalog.js")
