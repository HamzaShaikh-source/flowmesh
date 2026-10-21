'use strict';
/**
 * Does the no-hands path work in a REAL Electron runtime?
 *
 * This is not a mock: it starts the real runtime, loads the real page in a real window,
 * registers the same accelerator the shell registers, and then performs the same nudge
 * the shell performs (set location.hash), checking that the page's own handler ran.
 *
 * Run: npx electron scripts/probe_hotkeys.js
 */
const { app, BrowserWindow, globalShortcut, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setName('FlowMeshHotkeyProbe');
app.commandLine.appendSwitch('disable-gpu');

// Same accelerators the shell registers.
const HOTKEY_PULL = 'CommandOrControl+Shift+Space';
const HOTKEY_APPROVE = 'CommandOrControl+Shift+Return';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function syntheticDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-hotkey-'));
  const file = path.join(dir, 'flow.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE History (transcriptEntityId TEXT PRIMARY KEY, timestamp TEXT, status TEXT, app TEXT, duration REAL, numWords INTEGER, e2eLatency INTEGER, asrText TEXT, formattedText TEXT, editedText TEXT, numWordsCorrected INTEGER, audio BLOB, screenshot BLOB, axText TEXT, axHTML TEXT)');
  const when = new Date(Date.now() - 20000);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getUTCFullYear()}-${p(when.getUTCMonth() + 1)}-${p(when.getUTCDate())} ${p(when.getUTCHours())}:${p(when.getUTCMinutes())}:${p(when.getUTCSeconds())}.000 +00:00`;
  db.prepare('INSERT INTO History (transcriptEntityId,timestamp,status,app,numWords,e2eLatency,editedText,formattedText) VALUES (?,?,?,?,?,?,?,?)')
    .run('hotkey-row', stamp, 'completed', 'probeapp', 6, 200, 'start a 15 minute focus session', null);
  db.close();
  return file;
}

app.whenReady().then(async () => {
  const out = [];
  const line = (k, v) => out.push(`${k.padEnd(32)} ${v}`);
  process.env.FLOWMESH_WISPR_DB = syntheticDb();

  const { createRuntime } = require('../electron/runtime.js');
  const runtime = createRuntime({ port: 0, host: '127.0.0.1' });
  const port = await runtime.listen(0);
  const url = `http://127.0.0.1:${port}/?k=${encodeURIComponent(runtime.sessionToken)}`;
  line('runtime port', port);

  const window = new BrowserWindow({
    width: 1100, height: 800, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(url);
  await wait(1500);

  // 1. Do the real accelerators register in this environment? Mirrors the shell's
  // candidate list, so a collision is visible here before it ships.
  const PULL = ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+D', 'Alt+Shift+V'];
  const APPROVE = ['CommandOrControl+Shift+Return', 'CommandOrControl+Alt+Return', 'CommandOrControl+Shift+A'];
  const takeFirst = (list) => {
    for (const acc of list) {
      try { if (globalShortcut.register(acc, () => {})) return acc; } catch (error) { /* try next */ }
    }
    return null;
  };
  const pullAcc = takeFirst(PULL);
  const approveAcc = takeFirst(APPROVE);
  line('registered pull hotkey', pullAcc ? `${pullAcc}` : 'NONE FREE');
  line('registered approve hotkey', approveAcc ? `${approveAcc}` : 'NONE FREE');
  line('pull fell back to a later cand', pullAcc && pullAcc !== PULL[0] ? 'YES' : 'no');

  // 2. Does a tray actually construct with our icon?
  let trayOk = false;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'electron', 'assets', 'icon.png'));
    const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('FlowMesh hotkey probe');
    trayOk = true;
    void tray;
  } catch (error) { trayOk = false; }
  line('tray constructed', trayOk);

  // 3. The nudge itself: does the page's own hash handler fire and act?
  const before = await window.webContents.executeJavaScript('document.getElementById("commandInput").value');
  line('box before nudge', JSON.stringify(before));
  await window.webContents.executeJavaScript('window.location.hash = "pull"');
  await wait(2000);
  const after = await window.webContents.executeJavaScript('document.getElementById("commandInput").value');
  line('box after pull nudge', JSON.stringify(after));
  const provenance = await window.webContents.executeJavaScript('document.getElementById("provenanceLine").textContent');
  line('provenance line', JSON.stringify(provenance));
  const hashCleared = await window.webContents.executeJavaScript('window.location.hash');
  line('hash cleared after use', JSON.stringify(hashCleared));

  // 4. The approve nudge with no plan must say so rather than run anything.
  await window.webContents.executeJavaScript('window.location.hash = "approve"');
  await wait(800);
  const live = await window.webContents.executeJavaScript('document.getElementById("liveRegion").textContent');
  line('approve nudge with no plan', JSON.stringify(live));

  // 5. Does the page render the accelerators the shell pushes (no dead keys advertised)?
  await window.webContents.executeJavaScript(
    `window.__flowmeshHotkeys = ${JSON.stringify({ pull: pullAcc, approve: approveAcc })};
     window.dispatchEvent(new Event('flowmesh:hotkeys'));`,
  );
  await wait(400);
  const hint = await window.webContents.executeJavaScript('document.getElementById("hotkeyHint").textContent');
  const kbds = await window.webContents.executeJavaScript('document.querySelectorAll("#hotkeyHint kbd").length');
  line('hint text from push', JSON.stringify(hint));
  line('kbd chips in hint', kbds);

  line('delivered keystrokes attempted', 'NO - this probe never types into another app');

  console.log('\n=== hotkey / tray probe ===');
  out.forEach((row) => console.log(row));

  globalShortcut.unregisterAll();
  runtime.close();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`probe failed: ${error && error.message}\n`);
  app.exit(1);
});
