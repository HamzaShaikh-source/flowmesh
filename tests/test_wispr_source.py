"""Tests for the read-only Wispr Flow reader.

Everything here runs against a **synthetic** database built in a temp directory, so
the suite never touches a real Wispr Flow install and never carries anybody's
dictation text. That is deliberate: a test fixture containing real transcripts
would be exactly the privacy leak the module is written to prevent.
"""

from __future__ import annotations

import importlib
import os
import re
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import wispr_source


def build_fake_db(path: Path, rows: list[dict], dictionary: list[tuple] | None = None) -> None:
    """A miniature of Wispr Flow's schema — same names, same blob columns."""
    con = sqlite3.connect(str(path))
    con.executescript(
        """
        CREATE TABLE History (
            transcriptEntityId TEXT PRIMARY KEY,
            timestamp TEXT,
            status TEXT,
            app TEXT,
            url TEXT,
            duration REAL,
            numWords INTEGER,
            e2eLatency INTEGER,
            appVersion TEXT,
            language TEXT,
            micDevice TEXT,
            platform TEXT,
            numWordsCorrected INTEGER,
            numDictionaryReplacements INTEGER,
            transcriptCommand TEXT,
            editedText TEXT,
            formattedText TEXT,
            asrText TEXT,
            audio BLOB,
            screenshot BLOB,
            axText TEXT,
            axHTML TEXT
        );
        CREATE TABLE Dictionary (
            phrase TEXT, replacement TEXT, isSnippet INTEGER, isDeleted INTEGER DEFAULT 0
        );
        """
    )
    for row in rows:
        con.execute(
            "INSERT INTO History (transcriptEntityId, timestamp, status, app, duration, numWords,"
            " e2eLatency, numWordsCorrected, editedText, formattedText, asrText, audio, screenshot,"
            " axText, axHTML) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                row["id"], row["timestamp"], row.get("status", "raw_transcript"),
                row.get("app"), row.get("duration", 1.5), row.get("numWords", 4),
                row.get("latency", 300), row.get("corrected", 0),
                row.get("edited"), row.get("formatted"), row.get("asr"),
                b"\x00\x01FAKEAUDIO", b"\x00\x02FAKEPNG", "window text", "<html>",
            ),
        )
    for phrase, replacement, snippet in (dictionary or []):
        con.execute("INSERT INTO Dictionary (phrase, replacement, isSnippet) VALUES (?,?,?)",
                    (phrase, replacement, snippet))
    con.commit()
    con.close()


def ago(minutes: float) -> str:
    stamp = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return stamp.strftime("%Y-%m-%d %H:%M:%S.%f") + " +00:00"


class WisprSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "flow.sqlite"
        os.environ["FLOWMESH_WISPR_DB"] = str(self.db)
        importlib.reload(wispr_source)

    def tearDown(self) -> None:
        os.environ.pop("FLOWMESH_WISPR_DB", None)
        importlib.reload(wispr_source)
        self.tmp.cleanup()

    # --- the promise: we read text, never the blobs -----------------------------

    def test_module_never_selects_a_blob_column(self) -> None:
        """A query built with SELECT * would silently drag audio into memory."""
        source = Path(wispr_source.__file__).read_text(encoding="utf-8")
        code = re.sub(r'""".*?"""', "", source, flags=re.S)   # drop docstrings
        code = re.sub(r"#.*", "", code)                       # drop comments
        # BLOB_COLUMNS is the one place these names may appear — it exists so tests
        # and callers can see exactly what is refused. Remove it, then nothing may
        # mention a blob column anywhere else in the module.
        code = re.sub(r"BLOB_COLUMNS\s*=\s*\([^)]*\)", "", code, flags=re.S)
        self.assertNotIn("SELECT *", code.upper())
        for blob in wispr_source.BLOB_COLUMNS:
            self.assertNotIn(blob, code, f"{blob} must not appear outside BLOB_COLUMNS")
        for safe in wispr_source.SAFE_COLUMNS:
            self.assertNotIn(safe, wispr_source.BLOB_COLUMNS)

    def test_blob_columns_exist_in_the_fixture_but_are_not_read(self) -> None:
        build_fake_db(self.db, [{"id": "a", "timestamp": ago(0.1), "formatted": "open the board"}])
        con = sqlite3.connect(str(self.db))
        self.assertIsNotNone(con.execute("SELECT audio FROM History").fetchone()[0])
        con.close()
        transcript = wispr_source.latest()
        self.assertNotIn("FAKEAUDIO", str(transcript.as_dict()))
        self.assertEqual(transcript.text, "open the board")

    # --- read-only is enforced, not promised ------------------------------------

    def test_writing_is_refused_by_sqlite_itself(self) -> None:
        build_fake_db(self.db, [])
        con = wispr_source.connect(self.db)
        with self.assertRaises(sqlite3.OperationalError) as ctx:
            con.execute("INSERT INTO Dictionary (phrase) VALUES ('x')")
        con.close()
        self.assertIn("readonly", str(ctx.exception).lower())

    # --- honest states ----------------------------------------------------------

    def test_missing_database_reports_not_found_with_the_path_it_looked_at(self) -> None:
        # Point every candidate at a path that cannot exist, so this test also passes
        # on a machine that really does have Wispr Flow installed (like the one this
        # was written on) instead of silently reading the developer's own history.
        ghost = self.db.parent / "no-such-dir" / "flow.sqlite"
        os.environ["FLOWMESH_WISPR_DB"] = str(ghost)
        with mock.patch.object(wispr_source, "candidate_paths", return_value=[ghost]):
            status = wispr_source.status()
            self.assertEqual(status["state"], "not_found")
            self.assertIn("flow.sqlite", status["path"])
            self.assertEqual(wispr_source.recent(), [])
            self.assertIsNone(wispr_source.latest())
            self.assertIsNone(wispr_source.stats()["avg_latency_ms"])

    def test_empty_database_is_not_dressed_up_as_a_transcript(self) -> None:
        build_fake_db(self.db, [])
        self.assertEqual(wispr_source.status()["state"], "empty")
        self.assertIsNone(wispr_source.latest())

    def test_foreign_database_is_reported_not_guessed(self) -> None:
        con = sqlite3.connect(str(self.db))
        con.execute("CREATE TABLE something_else (x TEXT)")
        con.commit()
        con.close()
        self.assertEqual(wispr_source.status()["state"], "unexpected_schema")

    # --- picking the right text -------------------------------------------------

    def test_prefers_edited_then_formatted_then_raw(self) -> None:
        build_fake_db(self.db, [
            {"id": "1", "timestamp": ago(1), "edited": "edited wins", "formatted": "formatted", "asr": "raw"},
            {"id": "2", "timestamp": ago(2), "formatted": "formatted wins", "asr": "raw"},
            {"id": "3", "timestamp": ago(3), "asr": "raw only"},
        ])
        got = [t.source_column for t in wispr_source.recent(3)]
        self.assertEqual(got, ["editedText", "formattedText", "asrText"])
        self.assertEqual(wispr_source.recent(3)[0].text, "edited wins")

    def test_whitespace_only_text_is_not_treated_as_a_dictation(self) -> None:
        build_fake_db(self.db, [{"id": "1", "timestamp": ago(0.1), "formatted": "   \n  "}])
        self.assertIsNone(wispr_source.latest())
        self.assertEqual(wispr_source.status()["usable_rows"], 0)

    # --- freshness, the guard against acting on yesterday's sentence ------------

    def test_stale_dictation_is_refused(self) -> None:
        build_fake_db(self.db, [{"id": "old", "timestamp": ago(45), "formatted": "open the board"}])
        self.assertIsNone(wispr_source.latest(max_age_seconds=300))
        fresh = wispr_source.latest(max_age_seconds=3600)
        self.assertIsNotNone(fresh)
        self.assertIn("45 minute", wispr_source.describe_freshness(fresh))
        self.assertEqual(wispr_source.describe_freshness(None), "No recent dictation found to act on.")

    def test_fresh_dictation_is_accepted_and_described_in_seconds(self) -> None:
        build_fake_db(self.db, [{"id": "new", "timestamp": ago(0.2), "formatted": "start a focus timer"}])
        transcript = wispr_source.latest()
        self.assertIsNotNone(transcript)
        self.assertIn("second", wispr_source.describe_freshness(transcript))

    def test_latest_skips_a_newer_row_without_text(self) -> None:
        """Wispr records failed captures too; those must not shadow a real sentence."""
        build_fake_db(self.db, [
            {"id": "silent", "timestamp": ago(0.2), "status": "no_audio", "formatted": None},
            {"id": "spoken", "timestamp": ago(0.5), "status": "raw_transcript", "formatted": "notify my phone"},
        ])
        self.assertEqual(wispr_source.latest().id, "spoken")

    # --- dictionary and stats ---------------------------------------------------

    def test_dictionary_returns_the_users_own_phrases(self) -> None:
        build_fake_db(self.db, [], dictionary=[("btw", "by the way", 0), ("standup", "long text", 1)])
        entries = wispr_source.dictionary()
        self.assertEqual([e["phrase"] for e in entries], ["btw", "standup"])
        self.assertTrue(entries[1]["snippet"])

    def test_stats_are_aggregates_only_and_carry_no_text(self) -> None:
        build_fake_db(self.db, [
            {"id": "1", "timestamp": ago(1), "formatted": "first secret sentence", "app": "brave",
             "latency": 300, "numWords": 10, "corrected": 1},
            {"id": "2", "timestamp": ago(2), "formatted": "second secret sentence", "app": "brave",
             "latency": 500, "numWords": 6, "corrected": 0},
        ])
        stats = wispr_source.stats()
        self.assertEqual(stats["dictations"], 2)
        self.assertEqual(stats["words"], 16)
        self.assertEqual(stats["avg_latency_ms"], 400)
        self.assertEqual(stats["apps"], [{"app": "brave", "dictations": 2}])
        self.assertNotIn("secret", str(stats))

    # --- locked databases -------------------------------------------------------

    def test_locked_database_reports_locked_instead_of_crashing(self) -> None:
        build_fake_db(self.db, [{"id": "1", "timestamp": ago(1), "formatted": "hello"}])
        with mock.patch.object(wispr_source, "connect", side_effect=sqlite3.OperationalError("database is locked")):
            self.assertEqual(wispr_source.status()["state"], "locked")
            self.assertEqual(wispr_source.recent(), [])
            self.assertIsNone(wispr_source.latest())
            self.assertEqual(wispr_source.stats()["state"], "locked")

    def test_override_environment_variable_wins_over_platform_defaults(self) -> None:
        build_fake_db(self.db, [{"id": "1", "timestamp": ago(1), "formatted": "hello"}])
        self.assertEqual(wispr_source.resolve_db_path(), self.db)


if __name__ == "__main__":
    unittest.main(verbosity=2)
