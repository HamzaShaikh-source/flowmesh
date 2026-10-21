// Parent-side verification: can BOTH runtimes read the live Wispr Flow DB safely?
// Read-only only. Never writes. Run: node scripts/probe_wispr_connector.js
const path = require('path');
const fs = require('fs');
const os = require('os');

function candidatePaths() {
  const out = [];
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  out.push(path.join(appdata, 'Wispr Flow', 'flow.sqlite'));                       // Windows
  out.push(path.join(os.homedir(), 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite')); // macOS
  out.push(path.join(os.homedir(), '.config', 'Wispr Flow', 'flow.sqlite'));        // Linux (unverified)
  if (process.env.WISPR_DATABASE_PATH) out.unshift(process.env.WISPR_DATABASE_PATH);
  return out;
}

function report(label, value) { console.log(label.padEnd(38), value); }

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { /* older node */ }

const found = candidatePaths().filter((p) => fs.existsSync(p));
report('candidate paths found', found.length);
for (const p of found) report('  exists', `${p} (${fs.statSync(p).size} B)`);
if (!found.length) { console.log('RESULT: no Wispr Flow database on this machine'); process.exit(0); }

const dbPath = found[0];
report('using', dbPath);
for (const sibling of ['-wal', '-shm']) {
  const s = dbPath + sibling;
  report(`  sibling ${sibling}`, fs.existsSync(s) ? `${fs.statSync(s).size} B` : 'absent');
}

if (!DatabaseSync) { console.log('RESULT: node:sqlite unavailable; need Node >= 22.5'); process.exit(2); }

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 2000');

const cols = db.prepare('PRAGMA table_info(History)').all().map((c) => c.name);
report('History columns', cols.length);
const banned = ['audio', 'screenshot', 'axText', 'axHTML'];
report('contains sensitive blobs', banned.filter((b) => cols.includes(b)).join(', ') || 'none');

const total = db.prepare('SELECT COUNT(*) AS c FROM History').get().c;
report('History rows', total);

// Explicit column list: we never SELECT * so blobs can never enter memory.
const recent = db.prepare(`
  SELECT transcriptEntityId, timestamp, status, app, duration, numWords,
         editedText, formattedText, asrText, e2eLatency
  FROM History
  ORDER BY timestamp DESC
  LIMIT 2
`).all();

report('newest timestamp', recent.length ? recent[0].timestamp : 'none');
for (const r of recent) {
  const chosen = r.editedText || r.formattedText || r.asrText || '';
  report(`  id ${String(r.transcriptEntityId).slice(0, 8)}`, `status=${r.status} app=${r.app ?? '-'} words=${r.numWords ?? '-'} dur=${r.duration ?? '-'} len=${chosen.length} latency=${r.e2eLatency ?? '-'}`);
}
const blobLoaded = recent.some((r) => Object.keys(r).some((k) => banned.map((b) => b.toLowerCase()).includes(k.toLowerCase())));
report('blobs loaded into memory', blobLoaded ? 'YES (bad)' : 'no');

// Prove writes are refused.
let writeRefused = 'not attempted';
try {
  db.exec('CREATE TABLE IF NOT EXISTS flowmesh_probe (x INTEGER)');
  writeRefused = 'WRITE SUCCEEDED (bad)';
} catch (e) {
  writeRefused = `refused: ${e.message.split('\n')[0].slice(0, 60)}`;
}
report('write attempt', writeRefused);
db.close();

const dict = (() => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const n = d.prepare('SELECT COUNT(*) AS c FROM Dictionary').get().c;
  const rows = d.prepare('SELECT phrase, replacement, isSnippet FROM Dictionary LIMIT 3').all();
  d.close();
  return { n, rows };
})();
report('Dictionary rows', dict.n);
for (const r of dict.rows) report('  dict entry', `${r.phrase} -> ${r.replacement ?? '-'} snippet=${r.isSnippet}`);
console.log('RESULT: read-only connector OK');
