'use strict';
/**
 * Real end-to-end run of the Electron app: launches the actual app, drives the
 * actual renderer, approves a plan, and reads back the receipts the runtime
 * produced.
 *
 *   node scripts/e2e_electron.js
 *
 * Playwright is not a dependency of the product (it would add ~10 MB and browser
 * downloads to every clone), so this looks for it in the usual global spots and
 * says what to install if it cannot find one. CI covers the same behaviour
 * headlessly through `npm test`; this script is the human-runnable proof.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    'D:/Tools/npm-global/node_modules/@playwright/cli/node_modules/playwright',
    path.join(process.env.APPDATA || '', 'npm/node_modules/playwright'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try the next one */ }
  }
  throw new Error('playwright not found — set PLAYWRIGHT_PATH or run: npm i -g playwright');
}

const { _electron } = loadPlaywright();
const root = path.resolve(__dirname, '..');
const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const app = await _electron.launch({
    executablePath: require(path.join(root, 'node_modules', 'electron')),
    args: ['.'],
    cwd: root,
    env: { ...process.env, FLOWMESH_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1200);

    check('window title', /FlowMesh/.test(await page.title()), await page.title());

    const badge = (await page.textContent('#runtimeBadge').catch(() => '')) || '';
    check('renderer detected the desktop runtime', /Desktop runtime/i.test(badge), badge.trim());

    const sandboxed = await page.evaluate(() => ({
      node: typeof require,
      process: typeof process,
    }));
    check('renderer has no node access', sandboxed.node === 'undefined' && sandboxed.process === 'undefined');

    await page.screenshot({ path: path.join(shots, '09-electron-home.png') });

    await page.evaluate(() => document.getElementById('console').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await page.fill('#commandInput', 'focus for 25 minutes, open the board, start a timer');
    await page.click('#planButton');
    await page.waitForSelector('#planPanel:not([hidden])', { timeout: 8000 });
    const planTitle = (await page.textContent('#planTitle')).trim();
    const actionCount = await page.locator('#planActions li').count();
    check('plan rendered from the runtime', actionCount === 5, `${planTitle} · ${actionCount} actions`);
    await page.screenshot({ path: path.join(shots, '10-electron-plan.png') });

    await page.click('#approveButton');
    await page.waitForSelector('#receiptList li', { timeout: 15000 });
    await page.waitForTimeout(2500);
    const receipts = await page.locator('#receiptList li').evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: (node.querySelector('.receipt-label')?.textContent || '').trim(),
        detail: (node.querySelector('.receipt-detail')?.textContent || '').trim(),
        status: node.querySelector('.status')?.getAttribute('data-s') || '',
      })));
    check('receipts rendered', receipts.length >= 4, `${receipts.length} rows`);
    const vocabulary = new Set(['verified', 'sent', 'not_configured', 'denied', 'failed', 'unavailable']);
    const unknown = receipts.filter((r) => !vocabulary.has(r.status)).map((r) => r.status);
    check('every receipt uses a known verdict', unknown.length === 0, unknown.join(',') || 'all known');
    check('approve stayed single use', await page.locator('#approveButton').isDisabled(), 'approve disabled after run');
    await page.evaluate(() => document.getElementById('receipts').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, '11-electron-receipts.png') });

    const artifact = (await page.textContent('#artifactName').catch(() => '')) || '';
    check('run record surfaced in the artifact panel', /flowmesh-.*\.md/.test(artifact), artifact.trim());

    const dir = path.join(require('node:os').homedir(), 'FlowMesh', 'runs');
    const recordPath = path.join(dir, artifact.trim());
    check('the receipt names a record that exists on disk', Boolean(artifact.trim()) && fs.existsSync(recordPath), recordPath.replace(require('node:os').homedir(), '~'));

    console.log('  receipts:', receipts.map((r) => `${r.status}:${r.label}`).join(' | '));

    const status = await app.evaluate(async () => 'main-ok');
    check('main process responsive', status === 'main-ok');
  } finally {
    await app.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error('e2e failed:', error);
  process.exit(1);
});
