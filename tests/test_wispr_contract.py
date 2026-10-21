"""The two runtimes must answer the same Wispr connector, and never leak text.

A drift here is invisible in normal use: the page hides the panel when an endpoint
404s, so a missing route looks like "you have no dictations" instead of a bug. These
tests compare the two runtime sources directly.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Normalise line endings: these files are CRLF on Windows with LF in patched regions,
# and a regex written for one form silently fails on the other.
BRIDGE = (ROOT / "bridge.py").read_text(encoding="utf-8").replace("\r\n", "\n")
RUNTIME = (ROOT / "electron" / "runtime.js").read_text(encoding="utf-8").replace("\r\n", "\n")
MODULE = (ROOT / "electron" / "wispr.js").read_text(encoding="utf-8").replace("\r\n", "\n")
READER = (ROOT / "wispr_source.py").read_text(encoding="utf-8").replace("\r\n", "\n")


def python_routes() -> set[str]:
    return set(re.findall(r'self\.path == "(/api/wispr[^"]*)"', BRIDGE)) | (
        {"/api/type"} if 'self.path == "/api/type"' in BRIDGE else set()
    )


def node_routes() -> set[str]:
    return set(re.findall(r"pathname === '(/api/wispr[^']*)'", RUNTIME)) | (
        {"/api/type"} if "pathname === '/api/type'" in RUNTIME else set()
    )


class ConnectorContractTest(unittest.TestCase):
    def test_both_runtimes_serve_the_same_connector_endpoints(self):
        expected = {"/api/wispr", "/api/wispr/latest", "/api/wispr/dictionary", "/api/type"}
        self.assertEqual(python_routes(), expected, "bridge.py route set drifted")
        self.assertEqual(node_routes(), expected, "electron/runtime.js route set drifted")

    def test_a_documented_endpoint_exists_in_both_runtimes(self):
        # docs/VERIFICATION.md and README point people at these; documenting a route
        # that does not exist is the same class of error as a false receipt.
        for route in ("/api/wispr", "/api/wispr/latest", "/api/wispr/dictionary"):
            self.assertIn(route, python_routes())
            self.assertIn(route, node_routes())

    def test_neither_reader_selects_a_blob_column_outside_its_denylist(self):
        for name, source in (("wispr_source.py", READER), ("electron/wispr.js", MODULE)):
            code = re.sub(r"#.*", "", source)
            code = re.sub(r'"""(?:.|\n)*?"""', "", code)
            code = re.sub(r"/\*(?:.|\n)*?\*/", "", code)
            # The denial list itself is allowed to name them; nothing else may.
            code = re.sub(r"BLOB_COLUMNS\s*=\s*\[[^\]]*\]", "", code)
            code = re.sub(r"BLOB_COLUMNS\s*=\s*\([^)]*\)", "", code)
            for blob in ("audio", "screenshot", "axText", "axHTML"):
                self.assertNotIn(blob, code, f"{name} names {blob} outside its denylist")
            self.assertNotIn("SELECT *", code, f"{name} must never use SELECT *")

    def test_the_python_bridge_never_returns_transcript_text_from_the_summary(self):
        # wispr_overview feeds the always-visible panel. It carries counts and ages.
        overview = re.search(r"def wispr_overview\(\)(?:.|\n)*?\n\ndef ", BRIDGE).group(0)
        self.assertNotIn('"text"', overview, "the overview must not carry dictation text")
        self.assertIn("latest", overview)

    def test_the_type_path_reads_its_text_from_the_database(self):
        # POST /api/type may not accept caller-supplied text, in either runtime.
        for name, source in (("bridge.py", BRIDGE), ("electron/runtime.js", RUNTIME)):
            self.assertNotIn('body.get("text")', source, name)
            self.assertNotIn("body.text", source, name)

    def test_only_windows_claims_the_focus_was_verified(self):
        self.assertIn("_FOCUS_CHECKED", BRIDGE)
        self.assertIn("_FOCUS_UNCHECKED", BRIDGE)
        # Scope to type_text() itself: app_command() has its own darwin branch.
        body = re.search(r"def type_text\((?:.|\n)*?\n\ndef ", BRIDGE).group(0)
        # A comment can sit between the branch and its return, so allow any lines.
        macos = re.search(r'if sys\.platform == "darwin":\n(?:.*\n)*?\s+return ([^\n]+)', body).group(1)
        self.assertIn("_FOCUS_UNCHECKED", macos)
        windows = re.search(r'if os\.name == "nt":\n(?:.*\n)*?\s+return ([^\n]+)', body).group(1)
        self.assertIn("_FOCUS_CHECKED", windows)


if __name__ == "__main__":
    unittest.main()
