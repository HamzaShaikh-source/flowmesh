"""Read the user's own Wispr Flow dictation history, read-only.

Why this file exists
--------------------
Wispr Flow has no supported public API. It is a closed desktop app. But it keeps
a local SQLite database, and that database is the honest source of truth for "what
did I just dictate". `pedramamini/WisprMCP` (MIT) does the same thing on macOS;
this module generalises it to Windows and macOS, and to a stdlib-only codebase.

Hard rules (each one is enforced below, not promised):

1. **Read-only.** The connection is opened with SQLite's `mode=ro` URI, so a write
   raises `OperationalError: attempt to write a readonly database` instead of
   corrupting an app we do not own.
2. **Never the blobs.** `History` carries `audio`, `screenshot`, `axText` and
   `axHTML` columns. We never `SELECT *`; every query names the columns it wants,
   so those four can never be loaded into memory, logged, or written into a receipt.
3. **Never a fabrication.** If the database is missing, locked or empty, the caller
   gets an explicit state (`not_found` / `locked` / `empty`), never an empty string
   dressed up as a transcript.
4. **Nothing leaves the machine.** No network call exists in this module.

macOS vs Windows
----------------
macOS: `~/Library/Application Support/Wispr Flow/flow.sqlite`
Windows: `%APPDATA%\\Wispr Flow\\flow.sqlite`
Neither is an official integration point, and that is stated in the UI rather than
hidden. `FLOWMESH_WISPR_DB` overrides both for tests and unusual installs.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

# The order matters: Wispr writes edited text only when the user fixes the output,
# so the most human-intended version is edited, then formatted, then raw ASR.
TEXT_COLUMNS = ("editedText", "formattedText", "asrText")

# Named explicitly and used in every query. `audio`, `screenshot`, `axText` and
# `axHTML` are deliberately absent, and `tests/test_wispr_source.py` fails if any
# query in this file selects a column outside this tuple.
SAFE_COLUMNS = (
    "transcriptEntityId", "timestamp", "status", "app", "url", "duration",
    "numWords", "e2eLatency", "appVersion", "language", "micDevice", "platform",
    "numWordsCorrected", "numDictionaryReplacements", "transcriptCommand",
    "editedText", "formattedText", "asrText",
)

BLOB_COLUMNS = ("audio", "screenshot", "axText", "axHTML")
MAX_AGE_SECONDS = 300.0


@dataclass(frozen=True)
class Transcript:
    """One dictation, reduced to what an intent needs and nothing more."""

    id: str
    text: str
    source_column: str
    timestamp: str
    age_seconds: float | None
    app: str | None
    duration: float | None
    num_words: int | None
    latency_ms: int | None
    status: str | None
    corrected_words: int | None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "source_column": self.source_column,
            "timestamp": self.timestamp,
            "age_seconds": self.age_seconds,
            "app": self.app,
            "duration": self.duration,
            "num_words": self.num_words,
            "latency_ms": self.latency_ms,
            "status": self.status,
            "corrected_words": self.corrected_words,
        }


def _selectable(con, table: str = "History") -> list[str]:
    """SAFE_COLUMNS filtered to the columns this table actually has.

    Selecting a column that does not exist raises OperationalError, which the readers
    swallow as "no data" - so a schema difference would silently present as an empty
    history. Intersecting keeps a partially-matching install readable.
    """
    present = _table_columns(con, table)
    chosen = [column for column in SAFE_COLUMNS if column in present]
    return chosen or list(SAFE_COLUMNS)


def _table_columns(con, table: str) -> set[str]:
    """Real column names of a table.

    Guards against schema drift: the live History table has 63 columns and its primary
    key is `transcriptEntityId`, not `id`. Querying a column that does not exist raises
    OperationalError, which callers swallow as "no data" - a silent wrong answer.
    """
    try:
        return {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def candidate_paths() -> list[Path]:
    """Every place Wispr Flow is known to keep its database, best guess first."""
    out: list[Path] = []
    override = os.environ.get("FLOWMESH_WISPR_DB")
    if override:
        out.append(Path(override))
    if sys.platform == "darwin":
        out.append(Path.home() / "Library" / "Application Support" / "Wispr Flow" / "flow.sqlite")
    elif sys.platform.startswith("win"):
        appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        out.append(Path(appdata) / "Wispr Flow" / "flow.sqlite")
    else:
        # The unofficial Linux port is a different project; we look, but we do not claim.
        out.append(Path.home() / ".config" / "Wispr Flow" / "flow.sqlite")
    return out


def resolve_db_path() -> Path | None:
    """Locate the database, honouring an explicit override above all else.

    If FLOWMESH_WISPR_DB is set, it is authoritative: quietly falling back to a
    platform default would read a *different* database than the one the caller asked
    for, which is exactly the kind of silent wrongness this module exists to avoid.
    """
    override = os.environ.get("FLOWMESH_WISPR_DB")
    if override:
        candidate = Path(override)
        return candidate if candidate.is_file() else None
    for path in candidate_paths():
        if path.is_file():
            return path
    return None


def connect(path: Path) -> sqlite3.Connection:
    """Open read-only. A live app owns this file; we are a guest."""
    uri = "file:" + path.as_posix() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=2.0)
    con.execute("PRAGMA busy_timeout = 2000")
    return con


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f %z", "%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _pick_text(row: sqlite3.Row | dict) -> tuple[str, str]:
    for column in TEXT_COLUMNS:
        value = row[column]
        if isinstance(value, str) and value.strip():
            return value.strip(), column
    return "", "none"


def _row_to_transcript(row: sqlite3.Row, now: datetime | None = None) -> Transcript:
    text, column = _pick_text(row)
    stamp = row["timestamp"]
    parsed = _parse_timestamp(stamp)
    reference = now or datetime.now(timezone.utc)
    age = (reference - parsed).total_seconds() if parsed else None
    return Transcript(
        id=str(row["transcriptEntityId"] or ""),
        text=text,
        source_column=column,
        timestamp=str(stamp or ""),
        age_seconds=age,
        app=row["app"],
        duration=row["duration"],
        num_words=row["numWords"],
        latency_ms=row["e2eLatency"],
        status=row["status"],
        corrected_words=row["numWordsCorrected"],
    )


def _has_history(con: sqlite3.Connection) -> bool:
    row = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='History'"
    ).fetchone()
    return row is not None


def status() -> dict:
    """What the UI needs to tell the truth about the connection."""
    path = resolve_db_path()
    if path is None:
        return {
            "state": "not_found",
            "path": str(candidate_paths()[0]),
            "rows": 0,
            "detail": "Wispr Flow's local database was not found in any known location.",
        }
    try:
        con = connect(path)
    except sqlite3.Error as exc:
        return {"state": "locked", "path": str(path), "rows": 0, "detail": f"{type(exc).__name__}: {exc}"}
    try:
        if not _has_history(con):
            return {"state": "unexpected_schema", "path": str(path), "rows": 0,
                    "detail": "Database opened but has no History table."}
        total = con.execute("SELECT COUNT(*) FROM History").fetchone()[0]
        newest = con.execute("SELECT MAX(timestamp) FROM History").fetchone()[0]
        # SQLite's TRIM only strips spaces, so a transcript of "\n" would otherwise
        # count as usable. Normalise whitespace inside SQL to keep this one query.
        stripped = "TRIM(REPLACE(REPLACE(REPLACE({c}, char(10), ' '), char(13), ' '), char(9), ' '))"
        usable = con.execute(
            "SELECT COUNT(*) FROM History WHERE "
            + " OR ".join(
                f"({column} IS NOT NULL AND {stripped.format(c=column)} <> '')"
                for column in TEXT_COLUMNS
            )
        ).fetchone()[0]
    except sqlite3.Error as exc:
        return {"state": "locked", "path": str(path), "rows": 0, "detail": f"{type(exc).__name__}: {exc}"}
    finally:
        con.close()
    if not total:
        return {"state": "empty", "path": str(path), "rows": 0,
                "detail": "Wispr Flow is installed but has no dictations yet."}
    return {
        "state": "connected",
        "path": str(path),
        "rows": total,
        "usable_rows": usable,
        "newest_timestamp": str(newest or ""),
        "detail": f"{total} dictations on this machine, {usable} with text.",
    }


def recent(limit: int = 10) -> list[Transcript]:
    path = resolve_db_path()
    if path is None:
        return []
    try:
        con = connect(path)
        con.row_factory = sqlite3.Row
        columns = ", ".join(_selectable(con))
        rows = con.execute(
            f"SELECT {columns} FROM History ORDER BY timestamp DESC LIMIT ?", (int(limit),)
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        try:
            con.close()
        except Exception:
            pass
    return [_row_to_transcript(row) for row in rows]


def latest(max_age_seconds: float = MAX_AGE_SECONDS) -> Transcript | None:
    """The most recent dictation that still holds text and is not stale.

    Staleness is the whole point: without this, a hotkey pressed hours later would
    cheerfully plan yesterday's sentence.
    """
    for transcript in recent(limit=10):
        if not transcript.text:
            continue
        if max_age_seconds is not None and transcript.age_seconds is not None:
            if transcript.age_seconds > max_age_seconds:
                return None
        return transcript
    return None


def dictionary(limit: int = 200) -> list[dict]:
    """The user's own custom words and snippets — their vocabulary, not ours."""
    path = resolve_db_path()
    if path is None:
        return []
    try:
        con = connect(path)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT phrase, replacement, isSnippet FROM Dictionary"
            " WHERE isDeleted IS NOT 1 LIMIT ?", (int(limit),)
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        try:
            con.close()
        except Exception:
            pass
    return [{"phrase": r["phrase"], "replacement": r["replacement"], "snippet": bool(r["isSnippet"])} for r in rows]


def get(transcript_id: object) -> Transcript | None:
    """Fetch one dictation by id.

    Used by the type-through endpoint: the client names an id, and the text is
    re-read here, so no caller can ever supply the characters that reach the
    keyboard. No freshness window applies — the caller is not acting on "the latest",
    it is acting on one specific row it already showed the user.
    """
    path = resolve_db_path()
    if path is None:
        return None
    try:
        con = connect(path)
        con.row_factory = sqlite3.Row
        # The primary key is transcriptEntityId on every platform inspected so far, but
        # match either name so a variant schema still resolves.
        present = _table_columns(con, "History")
        key = "transcriptEntityId" if "transcriptEntityId" in present else "id"
        columns = ", ".join(_selectable(con))
        row = con.execute(
            f"SELECT {columns} FROM History WHERE {key} = ? LIMIT 1", (transcript_id,)
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        try:
            con.close()
        except Exception:
            pass
    return _row_to_transcript(row) if row is not None else None


def stats() -> dict:
    """Honest aggregates for the UI. Counts and averages only — never the text.

    Includes the median latency because the mean is skewed by the odd slow
    dictation, and the dictionary size because it is the one piece of the user's
    personal vocabulary this integration can see — worth surfacing, never storing.
    """
    path = resolve_db_path()
    empty = {"state": "not_found", "dictations": 0, "words": 0, "avg_latency_ms": None,
             "median_latency_ms": None, "corrected_words": 0, "dictionary_entries": 0,
             "snippets": 0, "apps": [], "first": None, "last": None}
    if path is None:
        return empty
    try:
        con = connect(path)
        row = con.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(numWords),0) AS words,"
            " COALESCE(SUM(numWordsCorrected),0) AS corrected,"
            " AVG(e2eLatency) AS latency, MIN(timestamp) AS first, MAX(timestamp) AS last"
            " FROM History"
        ).fetchone()
        latencies = sorted(
            float(r[0]) for r in con.execute(
                "SELECT e2eLatency FROM History WHERE e2eLatency IS NOT NULL AND e2eLatency > 0"
            ).fetchall()
        )
        dict_row = con.execute(
            "SELECT COUNT(*) AS n,"
            " COALESCE(SUM(CASE WHEN LENGTH(COALESCE(replacement,'')) > 0 THEN 1 ELSE 0 END),0) AS s"
            " FROM Dictionary"
        ).fetchone()
        apps = con.execute(
            "SELECT app, COUNT(*) AS n FROM History WHERE app IS NOT NULL"
            " GROUP BY app ORDER BY n DESC LIMIT 5"
        ).fetchall()
    except sqlite3.Error:
        return {**empty, "state": "locked"}
    finally:
        try:
            con.close()
        except Exception:
            pass
    if not row or not row[0]:
        return {**empty, "state": "empty"}
    return {
        "state": "connected",
        "dictations": row[0],
        "words": row[1],
        "corrected_words": row[2],
        "avg_latency_ms": round(row[3]) if row[3] is not None else None,
        "median_latency_ms": round(latencies[len(latencies) // 2]) if latencies else None,
        "dictionary_entries": int(dict_row[0] or 0),
        "snippets": int(dict_row[1] or 0),
        "first": row[4],
        "last": row[5],
        "apps": [{"app": a[0], "dictations": a[1]} for a in apps],
    }


def describe_freshness(transcript: Transcript | None) -> str:
    """One honest sentence about whether a transcript is fresh enough to act on."""
    if transcript is None:
        return "No recent dictation found to act on."
    if transcript.age_seconds is None:
        return "Dictation age could not be read from Wispr Flow."
    seconds = int(transcript.age_seconds)
    if seconds < 60:
        return f"Dictated {seconds} second{'s' if seconds != 1 else ''} ago."
    minutes = seconds // 60
    return f"Dictated {minutes} minute{'s' if minutes != 1 else ''} ago — check this is the sentence you meant."
