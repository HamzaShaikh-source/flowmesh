'use strict';
/**
 * A local wake word ("Hey FlowMesh") that can press your Wispr Flow hotkey for you.
 * Port of wake.py; read that file's header for the policy: offline (the Windows speech
 * recogniser, driven by one fixed script), opt-in every launch, a wake word only wakes (nothing
 * is transcribed or stored), the shortcut comes from a strict grammar, and the limits are stated.
 */

const { spawn, spawnSync } = require('node:child_process');

const { SCRIPT, WAKE_PHRASES, CONFIDENCE_FLOOR } = require('./wake_script.js');

const BLOB = 'wake';
const COOLDOWN_MS = 6000;
const MAX_HOLD_S = 30;

const MODIFIERS = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, windows: 0x5b, super: 0x5b };
const NAMED = { space: 0x20, enter: 0x0d, return: 0x0d, tab: 0x09 };

/** `ctrl+alt+space` -> [0x11, 0x12, 0x20] (virtual-key codes); throws Error with a sentence. */
function parseCombo(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 40) throw new Error('Enter a shortcut such as ctrl+alt+space.');
  const parts = text.split('+').map((p) => p.trim().toLowerCase());
  if (parts.length > 4 || parts.some((p) => !p)) throw new Error('Use at most three modifiers and one key, joined with +.');
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  if (!mods.length || mods.some((m) => !(m in MODIFIERS)) || new Set(mods.map((m) => MODIFIERS[m])).size !== mods.length) {
    throw new Error('Start with one or more of ctrl, alt, shift, win.');
  }
  const endError = 'End with a key (a letter, digit, F1-F12, space, enter or tab).';
  if (key in MODIFIERS) throw new Error(endError);
  let code;
  if (key in NAMED) code = NAMED[key];
  else if (/^[a-z0-9]$/.test(key)) code = key.toUpperCase().charCodeAt(0);
  else if (/^f([1-9]|1[0-2])$/.test(key)) code = 0x6f + Number(key.slice(1));
  else throw new Error(endError);
  return [...mods.map((m) => MODIFIERS[m]), code];
}

// Fixed text. The only values that reach it are numbers this module computed from a validated combo.
const PRESS_SCRIPT = [
  "Add-Type -Namespace FM -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);'",
  '$codes = $env:FLOWMESH_KEYS.Split(",") | ForEach-Object { [byte]$_ }',
  'foreach ($c in $codes) { [FM.K]::keybd_event($c, 0, 0, [UIntPtr]::Zero) }',
  'Start-Sleep -Milliseconds ([int]$env:FLOWMESH_HOLD_MS)',
  '[array]::Reverse($codes)',
  'foreach ($c in $codes) { [FM.K]::keybd_event($c, 0, 2, [UIntPtr]::Zero) }',
].join('\n');

function pressKeys(codes, holdS = 0, platform = process.platform) {
  if (platform !== 'win32') return false;
  const hold = Math.round(Math.max(0.05, Math.min(Number(holdS) || 0, MAX_HOLD_S)) * 1000);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(PRESS_SCRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, FLOWMESH_KEYS: codes.map((c) => String(Number(c) | 0)).join(','), FLOWMESH_HOLD_MS: String(hold) },
    windowsHide: true, timeout: hold + 15_000, stdio: 'ignore',
  });
  return result.status === 0;
}

function defaultOpener() {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false,
  });
}

function createWake({ store, opener = defaultOpener, press = pressKeys, platform = process.platform } = {}) {
  let proc = null;
  let state = 'off';
  let detail = '';
  let wakes = 0;
  let lastWake = '';
  let lastWakeAt = -COOLDOWN_MS;
  let summoned = 0;
  const windows = platform === 'win32';

  function config() {
    const data = store.loadBlob(BLOB) || {};
    const hold = Number(data.hold_s);
    return {
      summon: typeof data.summon === 'string' ? data.summon : '',
      hold_s: Number.isFinite(hold) ? Math.max(0, Math.min(hold, MAX_HOLD_S)) : 0,
    };
  }

  function setConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => !['summon', 'hold_s'].includes(k))) {
      throw new Error('Unknown setting.');
    }
    const current = config();
    if ('summon' in raw) {
      if (raw.summon === '' || raw.summon === null) current.summon = '';
      else {
        parseCombo(raw.summon);
        current.summon = String(raw.summon).split('+').map((p) => p.trim().toLowerCase()).join('+');
      }
    }
    if ('hold_s' in raw) {
      if (typeof raw.hold_s !== 'number' || !(raw.hold_s >= 0 && raw.hold_s <= MAX_HOLD_S)) {
        throw new Error(`Hold time must be between 0 and ${MAX_HOLD_S} seconds.`);
      }
      current.hold_s = raw.hold_s;
    }
    store.saveBlob(BLOB, current);
    return current;
  }

  function status() {
    let shownState = state;
    let shownDetail = detail;
    if (!windows) {
      shownState = 'unsupported';
      shownDetail = 'The wake word uses the speech recogniser built into Windows, so it is Windows-only for now.';
    }
    return { state: shownState, detail: shownDetail, wakes, last_wake_at: lastWake, summoned, phrases: WAKE_PHRASES, ...config() };
  }

  function summon() {
    const c = config();
    if (!c.summon) return false;
    const sent = Boolean(press(parseCombo(c.summon), c.hold_s));
    if (sent) summoned += 1;
    return sent;
  }

  function onWake(owner) {
    const now = Date.now();
    if (proc !== owner || now - lastWakeAt < COOLDOWN_MS) return;
    lastWakeAt = now;
    wakes += 1;
    lastWake = new Date().toISOString().slice(0, 19) + '+00:00';
    if (config().summon) setImmediate(summon); // a held shortcut must not stall the reader
  }

  function start() {
    if (!windows) return status();
    if (proc && proc.exitCode === null) return status();
    state = 'starting';
    detail = '';
    let child;
    try {
      child = opener();
    } catch (error) {
      proc = null;
      state = 'error';
      detail = `Could not start the recogniser (${error.name}).`;
      return status();
    }
    proc = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line === 'READY') {
          if (proc === child) { state = 'listening'; detail = ''; }
        } else if (line.startsWith('WAKE ')) {
          onWake(child);
        } else if (line.startsWith('ERROR ') && proc === child) {
          state = 'error';
          detail = `The Windows speech recogniser could not start: ${line.slice(6).replace(/[^\w .,:'-]/g, ' ').slice(0, 160)}`;
        }
      }
    });
    child.once('close', () => {
      if (proc === child) {
        proc = null;
        if (state !== 'error') { state = 'off'; detail = 'The recogniser stopped.'; }
      }
    });
    child.once('error', () => {
      if (proc === child) { proc = null; state = 'error'; detail = 'Could not start the recogniser.'; }
    });
    return status();
  }

  function stop() {
    const child = proc;
    proc = null;
    state = 'off';
    detail = '';
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
    }
    return status();
  }

  return { config, setConfig, status, start, stop, summon, simulateWake: () => proc && onWake(proc), killNow: stop };
}

module.exports = { createWake, parseCombo, pressKeys, defaultOpener, WAKE_PHRASES, CONFIDENCE_FLOOR, SCRIPT, PRESS_SCRIPT };
