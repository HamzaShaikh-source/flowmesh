'use strict';
/** The proof data and page: real numbers, an honest "not measured" list, and nothing the generator would not produce. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const WEB = path.join(__dirname, '..', '..', 'web');
const ROOT = path.join(__dirname, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(WEB, 'proof.json'), 'utf8'));
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const generator = fs.readFileSync(path.join(ROOT, 'scripts', 'build_proof.py'), 'utf8');

test('proof.json has the evidence a judge needs, from a real commit and a real run', () => {
  assert.match(data.commit, /^[0-9a-f]{7,}$/);
  assert.match(data.version, /^\d+\.\d+\.\d+$/);
  assert.ok(!Number.isNaN(Date.parse(data.generated_at)));
  assert.ok(data.commits > 10);
  assert.ok(data.tests.python.ran > 100 && data.tests.python.ok === true);
  assert.ok(data.tests.node.ran > 100 && data.tests.node.failed === 0 && data.tests.node.passed === data.tests.node.ran);
  assert.match(String(data.eval.parity), /\d+ \/ \d+/);
  assert.equal(data.eval.verdict, 'every invariant held.');
  const [done, all] = String(data.eval.parity).split('/').map((n) => Number(n.trim()));
  assert.equal(done, all, 'the cross-runtime parity numbers must be complete');
  assert.ok(data.ci.length > 0 && data.ci.every((r) => r.sha && r.url.startsWith('https://github.com/')));
  assert.ok(data.release.assets.some((a) => /win-x64\.exe$/.test(a.name) && /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 1e6));
  assert.ok(data.release.url.startsWith('https://github.com/HamzaShaikh-source/flowmesh/releases/'));
});

test('the "still being measured" list is present, specific, and covers what the project cannot claim', () => {
  const list = data.still_measuring;
  assert.ok(list.length >= 8);
  for (const item of list) {
    assert.ok(item.title.length > 8 && item.why.length > 40, item.title);
  }
  const titles = list.map((i) => i.title).join(' | ').toLowerCase();
  for (const topic of ['words dictated', 'coding-agent answer', 'councils with real models', 'mcp servers', 'time saved', 'plan quality']) {
    assert.ok(titles.includes(topic), `the list must keep "${topic}"`);
  }
  // The list in the data must be the one in the generator: a claim cannot leave one without a diff in the other.
  for (const item of list) assert.ok(generator.includes(item.title), `generator is missing "${item.title}"`);
});

test('the proof numbers are not invented: every figure the page prints comes from proof.json', () => {
  const page = fs.readFileSync(path.join(WEB, 'proof.js'), 'utf8');
  assert.match(page, /fetch\('proof\.json'/);
  assert.doesNotMatch(page, /\b(?:3[0-9]{2}|1[0-9]{2}) tests\b/, 'no hard-coded test counts');
  assert.match(html, /id="proofMeasured"/);
  assert.match(html, /id="proofPending"/);
  assert.match(html, /Still being measured/);
});

test('the proof section never claims time saved, wins or a score', () => {
  const text = JSON.stringify(data).toLowerCase() + fs.readFileSync(path.join(WEB, 'proof.js'), 'utf8').toLowerCase();
  for (const banned of ['minutes saved', 'x faster', 'best in class', 'winner', 'ranked #1', 'top 1']) {
    assert.ok(!text.includes(banned), banned);
  }
});
