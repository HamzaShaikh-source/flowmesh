"""The two runtimes must agree on MCP policy, routes and presets.

Risk levels and schema checks decide what a person is asked to approve, so a silent
difference between bridge.py and runtime.js would mean the same server is "read" in one
app and "danger" in the other. These tests pin them to one shared fixture.
"""

import json
import pathlib
import re
import shutil
import subprocess
import unittest

import mcp_presets
import mcp_registry

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "mcp_cases.json").read_text(encoding="utf-8"))
BRIDGE = (ROOT / "bridge.py").read_text(encoding="utf-8").replace("\r\n", "\n")
RUNTIME = (ROOT / "electron" / "runtime.js").read_text(encoding="utf-8").replace("\r\n", "\n")
REGISTRY_PY = (ROOT / "mcp_registry.py").read_text(encoding="utf-8")
REGISTRY_JS = (ROOT / "electron" / "mcp_registry.js").read_text(encoding="utf-8")


class PolicyFixtureTest(unittest.TestCase):
    def test_python_classify_matches_the_fixture(self):
        for case in FIXTURE["classify"]:
            self.assertEqual(mcp_registry.classify(case["tool"]), case["risk"], case["tool"])

    def test_python_schema_validation_matches_the_fixture(self):
        for case in FIXTURE["validate"]:
            errors = mcp_registry.validate_arguments(case["schema"], case["value"])
            self.assertEqual(not errors, case["valid"], case)


class DriftTest(unittest.TestCase):
    def test_both_runtimes_serve_the_same_mcp_routes(self):
        python = set(re.findall(r'path == "(/api/mcp/[^"]*)"', BRIDGE)) | set(re.findall(r'self\.path == "(/api/mcp/[^"]*)"', BRIDGE))
        node = set(re.findall(r"pathname === '(/api/mcp/[^']*)'", RUNTIME))
        expected = {"/api/mcp/servers", "/api/mcp/tools", "/api/mcp/presets", "/api/mcp/servers/remove",
                    "/api/mcp/servers/test", "/api/mcp/plan"}
        self.assertEqual(python, expected, "bridge.py MCP routes drifted")
        self.assertEqual(node, expected, "electron/runtime.js MCP routes drifted")

    def test_the_destructive_name_pattern_is_identical(self):
        py = re.search(r'DANGER_NAME = re\.compile\(\s*r"(.+?)",', REGISTRY_PY, re.S).group(1)
        js = re.search(r"const DANGER_NAME = /(.+)/i;", REGISTRY_JS).group(1)
        self.assertEqual(py, js)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_presets_are_identical_in_both_runtimes(self):
        out = subprocess.run(["node", "-e", "process.stdout.write(JSON.stringify(require('./electron/mcp_presets.js').PRESETS))"],
                             cwd=ROOT, capture_output=True, encoding="utf-8", check=True).stdout
        self.assertEqual(json.loads(out), mcp_presets.PRESETS)

    def test_every_preset_has_the_fields_the_ui_relies_on(self):
        for preset in mcp_presets.PRESETS:
            self.assertTrue({"id", "label", "group", "description", "transport", "inputs", "docs"} <= set(preset), preset["id"])
            self.assertIn(preset["transport"], {"stdio", "http"})

    def test_the_execute_gate_and_receipt_vocabulary_exist_in_both(self):
        for source in (BRIDGE, RUNTIME):
            self.assertIn("returned", source)
            self.assertIn("428", source)
            self.assertIn("needs_confirm", source)


if __name__ == "__main__":
    unittest.main()
