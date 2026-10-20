'use strict';
/**
 * End-to-end probe of a running FlowMesh desktop runtime.
 *
 *   node scripts/probe_electron_runtime.js [launch-url-file]
 *
 * Reads the tokenised URL the app wrote at launch (never prints the token),
 * then walks status → plan → approve → receipts and the refusal paths that
 * matter: replay, amended body, missing token, cross-origin.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function launchUrl() {
  const candidates = [
    process.argv[2],
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'FlowMesh', 'launch-url.txt'),
    path.join(os.homedir(), '.config', 'FlowMesh', 'launch-url.txt'),
    path.join(os.homedir(), 'Library', 'Application Support', 'FlowMesh', 'launch-url.txt'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  }
  throw new Error('no launch-url.txt found; pass the URL file as argv[2]');
}

const url = new URL(launchUrl());
const base = url.origin;
const token = url.searchParams.get('k');
if (!token) throw new Error('launch URL carries no session token');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function call(pathname, { method = 'GET', body, headers = {}, withToken = true } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(withToken ? { 'X-FlowMesh-Token': token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

(async () => {
  const status = await call('/api/status');
  check('status 200', status.status === 200, `mode=${status.json?.mode} version=${status.json?.version} platform=${status.json?.platform}`);
  check('status reports desktop_app', status.json?.mode === 'desktop_app');
  check('status never leaks secrets', !('ha_token' in (status.json || {})) && !('jev_key' in (status.json || {})));

  const noToken = await call('/api/status', { withToken: false });
  check('missing token refused 401', noToken.status === 401, noToken.json?.error);

  const plan = await call('/api/plan', { method: 'POST', body: { command: 'focus for 25 minutes, open the board, start a timer' } });
  check('plan 200', plan.status === 200, `${plan.json?.route} · ${plan.json?.actions?.length} actions · also="${plan.json?.also}"`);
  check('plan has a one-use id', Boolean(plan.json?.id));
  check('plan omits internals', plan.json && !('expires' in plan.json) && !('command' in plan.json));
  const planId = plan.json?.id;

  const tampered = await call('/api/execute', { method: 'POST', body: { plan_id: planId, command: 'rm -rf /' } });
  check('amended execute refused 400', tampered.status === 400, tampered.json?.error);

  const crossOrigin = await call('/api/plan', { method: 'POST', body: { command: 'focus for 25 minutes' }, headers: { Origin: 'https://evil.example' } });
  check('cross-origin POST refused 403', crossOrigin.status === 403, crossOrigin.json?.error);

  const run = await call('/api/execute', { method: 'POST', body: { plan_id: planId } });
  const verdicts = (run.json?.results || []).map((r) => `${r.action?.kind}:${r.status}`);
  check('execute 200', run.status === 200, verdicts.join(', '));

  const record = (run.json?.results || []).find((r) => r.path && r.sha256);
  if (record) {
    const exists = fs.existsSync(record.path);
    const digest = exists ? require('node:crypto').createHash('sha256').update(fs.readFileSync(record.path)).digest('hex') : null;
    check('run record on disk with matching sha256', exists && digest === record.sha256, record.path.replace(os.homedir(), '~'));
  } else {
    check('run record on disk with matching sha256', false, 'no record in receipts');
  }

  const replay = await call('/api/execute', { method: 'POST', body: { plan_id: planId } });
  check('replay refused 409', replay.status === 409, replay.json?.error);

  const refuse = await call('/api/plan', { method: 'POST', body: { command: 'delete every file in my documents folder' } });
  check('destructive command refused', refuse.status === 422, refuse.json?.error);

  const unknownSetting = await call('/api/settings', { method: 'POST', body: { nope: 'x' } });
  check('unknown setting refused 400', unknownSetting.status === 400, unknownSetting.json?.error);

  const setSecret = await call('/api/settings', { method: 'POST', body: { ha_token: 'probe-token-not-real', board_url: 'https://github.com/HamzaShaikh-source/flowmesh/issues' } });
  const after = await call('/api/settings');
  check('settings applied without echoing the secret',
    setSecret.status === 200 && after.json?.ha_token_connected === true && !after.text.includes('probe-token-not-real'),
    `backend=${after.json?.secret_backend}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error('probe failed:', error.message);
  process.exit(1);
});
