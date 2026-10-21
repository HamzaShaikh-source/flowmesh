"""The UI's connector helpers must behave the way the honesty contract promises.

These are source-level assertions on web/ui.js. The behaviour itself was verified in a
real browser against the real runtime; these tests exist so a later edit cannot quietly
undo it.
"""
import pathlib
import re
import unittest

UI = (pathlib.Path(__file__).resolve().parent.parent / "web" / "ui.js").read_text(
    encoding="utf-8"
).replace("\r\n", "\n")


class UiContractTest(unittest.TestCase):
    def test_typing_over_a_dictation_flips_the_provenance(self):
        # Otherwise editing one word would leave a line claiming the text was dictated.
        bind = re.search(r"\$\('commandInput'\)\.addEventListener\('input'(?:.|\n)*?\}\);", UI).group(0)
        self.assertIn("kind: 'typed'", bind)
        self.assertIn("S.dictation = null", bind)

    def test_the_provenance_line_is_driven_by_the_words_not_by_a_dictation_existing(self):
        show = re.search(r"function showProvenance\(\)(?:.|\n)*?\n  \}", UI).group(0)
        self.assertIn("S.wordsFrom", show)
        self.assertIn("Typed by you", show)
        # It must read the derived state, never probe the connector directly.
        self.assertNotIn("/api/wispr", show)

    def test_a_long_dictation_is_trimmed_on_a_boundary_and_says_so(self):
        fit = re.search(r"function fitToBox\(text, limit\)(?:.|\n)*?\n  \}", UI).group(0)
        self.assertIn("lastIndexOf('. ')", fit)
        self.assertIn("lastIndexOf(' ')", fit)
        self.assertIn("clipped: true", fit)
        pull = re.search(r"function pullDictation\(\)(?:.|\n)*?\n  \}", UI).group(0)
        self.assertIn("fitToBox(info.text, BOX_LIMIT)", pull)
        self.assertIn("trimmed to the last complete sentence", pull)
        self.assertIn("BOX_LIMIT", pull)
        # The line that carries "trimmed to fit the box" is render-time, in showProvenance.
        show = re.search(r"function showProvenance\(\)(?:.|\n)*?\n  \}", UI).group(0)
        self.assertIn("trimmed to fit the box", show)

    def test_the_counter_and_the_box_limit_agree(self):
        # A hardcoded 1000 in the counter is how the two drift apart.
        self.assertNotIn("length + ' / 1000'", UI)
        self.assertIn("var BOX_LIMIT = 1000;", UI)

    def test_transcript_text_is_never_sent_to_a_third_party(self):
        # The session token lives in sessionStorage (tab-scoped, cleared on close).
        # What must never appear is any path that ships transcript text off-machine.
        for pattern in ("localStorage", "document.cookie", "sendBeacon", "navigator.sendBeacon"):
            self.assertNotIn(pattern, UI, f"web/ui.js must not use {pattern}")
        # The only network calls are same-origin API routes.
        for match in re.finditer(r"fetch\((['\"])([^'\"]+)", UI):
            self.assertTrue(match.group(2).startswith("/api/") or match.group(2).startswith("/"),
                            f"unexpected cross-origin fetch: {match.group(2)}")
        self.assertNotIn("http://", UI.replace("http://127.0.0.1", ""))
        self.assertNotIn("https://" + "api.", UI)

    def test_the_strip_hides_itself_when_the_runtime_has_no_connector(self):
        load = re.search(r"function loadWispr\(\)(?:.|\n)*?\n  \}", UI).group(0)
        self.assertIn("catch", load)
        self.assertIn("hidden = true", load)


if __name__ == "__main__":
    unittest.main()
