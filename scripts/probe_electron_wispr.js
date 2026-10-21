'use strict';
/**
 * Does the *Electron* runtime have node:sqlite, and can it read a live Wispr Flow DB?
 *
 * `node:sqlite` is experimental and Electron builds can withhold it. The connector
 * degrades honestly when it is missing, but we need to know which it is on each
 * runtime rather than assume. Run: npx electron scripts/probe_electron_wispr.js
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function line(label, value) { console.log(String(label).padEnd(34), value); }

app.whenReady().then(() => {
  line('electron', process.versions.electron);
  line('node', process.versions.node);
  line('chrome', process.versions.chrome);

  let DatabaseSync = null;
  let err = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { err = e.message; }
  line('node:sqlite available', DatabaseSync ? 'YES' : `NO (${err})`);

  const wispr = require(path.join(__dirname, '..', 'electron', 'wispr.js'));
  line('sqliteAvailable()', wispr.sqliteAvailable());

  const st = wispr.status();
  line('status.state', st.state);
  line('status.path', st.path);
  line('status.detail', st.detail);

  if (st.state === 'connected') {
    const newest = wispr.latest();
    line('latest.text length', newest ? newest.text.length : 'none');
    line('latest.source_column', newest ? newest.source_column : '-');
    line('latest.age_seconds', newest ? Math.round(newest.age_seconds) : '-');
    line('freshness sentence', wispr.describeFreshness(newest));
    const s = wispr.stats();
    line('stats.dictations', s.dictations);
    line('stats.avg_latency_ms', s.avg_latency_ms);
    line('stats.apps', JSON.stringify(s.apps));
    line('dictionary entries', wispr.dictionary().length);

    // Prove the blobs never entered memory: the object keys are a fixed allowlist.
    const allowed = new Set(['id', 'text', 'source_column', 'timestamp', 'age_seconds', 'app',
      'duration', 'num_words', 'latency_ms', 'status', 'corrected_words']);
    const keys = Object.keys(newest);
    line('unexpected keys on transcript', keys.filter((k) => !allowed.has(k)).join(',') || 'none');
    line('blob columns selected', wispr.SAFE_COLUMNS.filter((c) => wispr.BLOB_COLUMNS.includes(c)).join(',') || 'none');
  }

  console.log('PROBE_DONE');
  app.exit(0);
}).catch((error) => {
  console.log('PROBE_FAILED', error && error.message);
  app.exit(1);
});
