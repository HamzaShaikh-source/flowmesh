'use strict';
/**
 * Node-side tests for the read-only Wispr Flow reader.
 *
 * Same discipline as tests/test_wispr_source.py: everything runs against a synthetic
 * database in a temp directory, so the suite never reads a real install and never
 * carries anybody's dictation text into the repository.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { /* handled below */ }

const wispr = require('../wispr.js');

function mkTempDb(rows, dict) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-wispr-'));
  const file = path.join(dir, 'flow.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE History (
      transcriptEntityId TEXT PRIMARY KEY, timestamp TEXT, status TEXT, app TEXT, url TEXT,
      duration REAL, numWords INTEGER, e2eLatency INTEGER, appVersion TEXT, language TEXT,
      micDevice TEXT, platform TEXT, numWordsCorrected INTEGER, numDictionaryReplacements INTEGER,
      transcriptCommand TEXT, editedText TEXT, formattedText TEXT, asrText TEXT,
      audio BLOB, screenshot BLOB, axText TEXT, axHTML TEXT
    );
    CREATE TABLE Dictionary (phrase TEXT, replacement TEXT, isSnippet INTEGER, isDeleted INTEGER DEFAULT 0);
  `);
  const insert = db.prepare(
    `INSERT INTO History (transcriptEntityId, timestamp, status, app, duration, numWords, e2eLatency,
       numWordsCorrected, editedText, formattedText, asrText, audio, screenshot, axText, axHTML)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of rows) {
    insert.run(r.id, r.timestamp, r.status || 'raw_transcript', r.app ?? null, r.duration ?? 1.5,
      r.numWords ?? 4, r.latency ?? 300, r.corrected ?? 0, r.edited ?? null, r.formatted ?? null,
      r.asr ?? null, Buffer.from('FAKEAUDIO'), Buffer.from('FAKEPNG'), 'window text', '<html>');
  }
  const dictInsert = db.prepare('INSERT INTO Dictionary (phrase, replacement, isSnippet) VALUES (?,?,?)');
  for (const [phrase, replacement, snippet] of dict || []) dictInsert.run(phrase, replacement, snippet);
  db.close();
  return file;
}

function ago(minutes) {
  const d = new Date(Date.now() - minutes * 60000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)} +00:00`;
}

function withDb(file, fn) {
  const previous = process.env.FLOWMESH_WISPR_DB;
  process.env.FLOWMESH_WISPR_DB = file;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.FLOWMESH_WISPR_DB; else process.env.FLOWMESH_WISPR_DB = previous;
    try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

test('module never selects a blob column and never uses SELECT *', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'wispr.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/.*/g, '')             // line comments
    .replace(/const BLOB_COLUMNS\s*=\s*\[[^\]]*\]/, ''); // the one legitimate mention
  assert.ok(!/SELECT\s+\*/i.test(src), 'SELECT * would drag audio into memory');
  for (const blob of wispr.BLOB_COLUMNS) {
    assert.ok(!src.includes(blob), `${blob} must not appear outside BLOB_COLUMNS`);
  }
  for (const safe of wispr.SAFE_COLUMNS) {
    assert.ok(!wispr.BLOB_COLUMNS.includes(safe), `${safe} must not be a blob column`);
  }
});

test('blob data exists in the fixture but never reaches the caller', () => {
  const file = mkTempDb([{ id: 'a', timestamp: ago(0.1), formatted: 'open the board' }]);
  withDb(file, () => {
    const raw = new DatabaseSync(file, { readOnly: true });
    assert.ok(raw.prepare('SELECT audio FROM History').get().audio, 'fixture must carry a blob');
    raw.close();
    const t = wispr.latest();
    assert.strictEqual(t.text, 'open the board');
    assert.ok(!JSON.stringify(t).includes('FAKEAUDIO'));
  });
});

test('write attempts are refused by sqlite itself', () => {
  const file = mkTempDb([]);
  withDb(file, () => {
    const db = wispr._internal.connect(file);
    assert.throws(() => db.exec("INSERT INTO Dictionary (phrase) VALUES ('x')"), /readonly/i);
    db.close();
  });
});

test('missing database reports not_found with the path it looked at', () => {
  const ghost = path.join(os.tmpdir(), 'flowmesh-nope-' + Date.now(), 'flow.sqlite');
  const previous = process.env.FLOWMESH_WISPR_DB;
  process.env.FLOWMESH_WISPR_DB = ghost;
  try {
    const st = wispr.status();
    assert.strictEqual(st.state, 'not_found');
    assert.ok(st.path.includes('flow.sqlite'));
    assert.deepStrictEqual(wispr.recent(), []);
    assert.strictEqual(wispr.latest(), null);
    assert.strictEqual(wispr.stats().avg_latency_ms, null);
  } finally {
    if (previous === undefined) delete process.env.FLOWMESH_WISPR_DB; else process.env.FLOWMESH_WISPR_DB = previous;
  }
});

test('empty database is not dressed up as a transcript', () => {
  const file = mkTempDb([]);
  withDb(file, () => {
    assert.strictEqual(wispr.status().state, 'empty');
    assert.strictEqual(wispr.latest(), null);
  });
});

test('a foreign database is reported, not guessed at', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-foreign-'));
  const file = path.join(dir, 'flow.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE something_else (x TEXT)');
  db.close();
  withDb(file, () => assert.strictEqual(wispr.status().state, 'unexpected_schema'));
});

test('prefers edited, then formatted, then raw', () => {
  const file = mkTempDb([
    { id: '1', timestamp: ago(1), edited: 'edited wins', formatted: 'formatted', asr: 'raw' },
    { id: '2', timestamp: ago(2), formatted: 'formatted wins', asr: 'raw' },
    { id: '3', timestamp: ago(3), asr: 'raw only' },
  ]);
  withDb(file, () => {
    const rows = wispr.recent(3);
    assert.deepStrictEqual(rows.map((r) => r.source_column),
      ['editedText', 'formattedText', 'asrText']);
    assert.strictEqual(rows[0].text, 'edited wins');
  });
});

test('whitespace-only text is not a dictation', () => {
  const file = mkTempDb([{ id: '1', timestamp: ago(0.1), formatted: '   \n\t ' }]);
  withDb(file, () => {
    assert.strictEqual(wispr.latest(), null);
    assert.strictEqual(wispr.status().usable_rows, 0);
  });
});

test('stale dictation is refused, fresh one is described in seconds', () => {
  const stale = mkTempDb([{ id: 'old', timestamp: ago(45), formatted: 'open the board' }]);
  withDb(stale, () => {
    assert.strictEqual(wispr.latest(300), null, '45 min old must not be actionable');
    const t = wispr.latest(3600);
    assert.ok(t, 'an hour-long window should surface it');
    assert.ok(/45 minute/.test(wispr.describeFreshness(t)));
  });
  assert.strictEqual(wispr.describeFreshness(null), 'No recent dictation found to act on.');

  const fresh = mkTempDb([{ id: 'new', timestamp: ago(0.2), formatted: 'start a focus timer' }]);
  withDb(fresh, () => {
    const t = wispr.latest();
    assert.ok(t);
    assert.ok(/second/.test(wispr.describeFreshness(t)));
  });
});

test('a newer row without text does not shadow a real sentence', () => {
  const file = mkTempDb([
    { id: 'silent', timestamp: ago(0.2), status: 'no_audio' },
    { id: 'spoken', timestamp: ago(0.5), status: 'raw_transcript', formatted: 'notify my phone' },
  ]);
  withDb(file, () => assert.strictEqual(wispr.latest().id, 'spoken'));
});

test('timestamps with a space-separated offset parse correctly', () => {
  // This exact shape silently produced age=null before the fix; a null age disables
  // the freshness guard, which is how you end up executing yesterday's sentence.
  const parsed = wispr._internal.parseTimestamp('2026-10-21 04:36:38.365 +00:00');
  assert.ok(parsed instanceof Date);
  assert.strictEqual(parsed.toISOString(), '2026-10-21T04:36:38.365Z');
  assert.strictEqual(wispr._internal.parseTimestamp('nonsense'), null);
});

test('dictionary returns the user\'s own phrases', () => {
  const file = mkTempDb([], [['btw', 'by the way', 0], ['standup', 'long text', 1]]);
  withDb(file, () => {
    const entries = wispr.dictionary();
    assert.deepStrictEqual(entries.map((e) => e.phrase), ['btw', 'standup']);
    assert.strictEqual(entries[1].snippet, true);
  });
});

test('stats are aggregates only and carry no text', () => {
  const file = mkTempDb([
    { id: '1', timestamp: ago(1), formatted: 'first secret sentence', app: 'brave', latency: 300, numWords: 10, corrected: 1 },
    { id: '2', timestamp: ago(2), formatted: 'second secret sentence', app: 'brave', latency: 500, numWords: 6, corrected: 0 },
  ]);
  withDb(file, () => {
    const s = wispr.stats();
    assert.strictEqual(s.dictations, 2);
    assert.strictEqual(s.words, 16);
    assert.strictEqual(s.avg_latency_ms, 400);
    assert.deepStrictEqual(s.apps, [{ app: 'brave', dictations: 2 }]);
    assert.ok(!JSON.stringify(s).includes('secret'));
  });
});

test('an unreadable database reports locked instead of crashing', () => {
  // A file that exists but is not a database at all: sqlite opens lazily and then
  // fails on the first query. That must surface as an honest state, never a throw
  // and never an empty string pretending to be a transcript.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-garbage-'));
  const file = path.join(dir, 'flow.sqlite');
  fs.writeFileSync(file, 'this is not a sqlite database, it is a decoy');
  withDb(file, () => {
    assert.strictEqual(wispr.status().state, 'locked');
    assert.deepStrictEqual(wispr.recent(), []);
    assert.strictEqual(wispr.latest(), null);
    assert.strictEqual(wispr.stats().state, 'locked');
  });
});

test('the platform default paths are the documented ones', () => {
  const paths = wispr.candidatePaths();
  assert.ok(paths.length >= 1);
  if (process.platform === 'win32') {
    assert.ok(paths.some((p) => /Wispr Flow[\\/]flow\.sqlite$/.test(p)));
  }
  assert.ok(paths.every((p) => p.endsWith('flow.sqlite') || p === process.env.FLOWMESH_WISPR_DB));
});
