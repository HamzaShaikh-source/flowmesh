'use strict';
/**
 * The page pilot's two desktop abilities: the real system volume (Windows media keys) and a
 * screenshot of the app window. Port of pilot.py; read that file's header for the policy.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VOLUME_KEYS = { up: 0xaf, down: 0xae, mute: 0xad }; // VK_VOLUME_UP, VK_VOLUME_DOWN, VK_VOLUME_MUTE
const DEFAULT_STEPS = 5; // each press moves the Windows volume by 2%
const MAX_STEPS = 25;

// Fixed text. The only values that reach it are numbers this module computed from the table above.
const REPEAT_SCRIPT = [
  "Add-Type -Namespace FM -Name V -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);'",
  '$code = [byte]$env:FLOWMESH_KEY',
  'for ($i = 0; $i -lt [int]$env:FLOWMESH_REPEAT; $i++) {',
  '  [FM.V]::keybd_event($code, 0, 0, [UIntPtr]::Zero)',
  '  [FM.V]::keybd_event($code, 0, 2, [UIntPtr]::Zero)',
  '  Start-Sleep -Milliseconds 30',
  '}',
].join('\n');

function defaultPress(code, count, platform = process.platform) {
  if (platform !== 'win32') return false;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(REPEAT_SCRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, FLOWMESH_KEY: String(code | 0), FLOWMESH_REPEAT: String(count | 0) },
    windowsHide: true, timeout: 15_000, stdio: 'ignore',
  });
  return result.status === 0;
}

/** Press a volume key `steps` times. Returns { ok, detail }; never throws on bad input. */
function pressVolume(action, steps, { press = defaultPress, platform = process.platform } = {}) {
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(VOLUME_KEYS, action)) return { ok: false, kind: 'bad_request', detail: 'Volume is up, down or mute.' };
  const count = steps === undefined || steps === null ? DEFAULT_STEPS : steps;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_STEPS) {
    return { ok: false, kind: 'bad_request', detail: `Steps must be a whole number from 1 to ${MAX_STEPS}.` };
  }
  if (platform !== 'win32') {
    return { ok: false, kind: 'unsupported', detail: 'System volume control uses Windows media keys, so it is Windows-only for now.' };
  }
  const presses = action === 'mute' ? 1 : count;
  if (!press(VOLUME_KEYS[action], presses, platform)) return { ok: false, kind: 'failed', detail: 'Windows did not accept the key press.' };
  const words = { up: 'raised', down: 'lowered', mute: 'toggled mute on' }[action];
  return { ok: true, detail: action === 'mute' ? `System volume ${words}.` : `System volume ${words} by about ${presses * 2}%.` };
}

/** Write a PNG into `directory` under a generated name and return its receipt. */
function saveScreenshot(png, directory) {
  const data = Buffer.isBuffer(png) ? png : Buffer.from(png || []);
  if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('That is not a PNG image.');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  fs.mkdirSync(directory, { recursive: true });
  const name = `flowmesh-screenshot-${stamp}.png`;
  const file = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.tmp`);
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
  return { name, path: file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

module.exports = { pressVolume, saveScreenshot, VOLUME_KEYS, DEFAULT_STEPS, MAX_STEPS, REPEAT_SCRIPT };
