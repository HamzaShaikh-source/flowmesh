'use strict';
/**
 * FlowMesh desktop shell (Electron).
 *
 * The window is a client of the same loopback contract the packaged Python app
 * serves: a per-launch token in the URL, a Host check, an Origin check, and
 * one-use plans. Renderer privileges are locked down — no node integration, no
 * remote content, no in-app navigation off 127.0.0.1 — so a stray script in the
 * page cannot reach the OS. All OS effects happen in this process, through the
 * allowlist in runtime.js.
 */

const { app, BrowserWindow, Menu, dialog, safeStorage, shell, globalShortcut, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { createStore, VERSION } = require('./config.js');
const { createRuntime } = require('./runtime.js');

const SERVER_ONLY = process.argv.includes('--server-only');
const HEADLESS = SERVER_ONLY || process.argv.includes('--headless');

// No-hands control. Two distinct gestures, never one, so an accidental double-tap
// cannot run anything: the first pulls the sentence you just dictated, the second
// approves the plan you are looking at. Approval stays a deliberate act.
// Accelerators collide with other apps in the wild (a global shortcut can only belong
// to one program). The first free candidate wins, and whichever was chosen is shown in
// the tray and in the page — so the UI never advertises a key that is not listening.
const PULL_CANDIDATES = [
  "CommandOrControl+Shift+Space", "CommandOrControl+Alt+Space",
  "CommandOrControl+Shift+D", "Alt+Shift+V",
];
const APPROVE_CANDIDATES = [
  "CommandOrControl+Shift+Return", "CommandOrControl+Alt+Return",
  "CommandOrControl+Shift+A",
];
let trayRef = null;
const hotkeyState = { pull: null, approve: null };

app.setName('FlowMesh');
if (process.platform === 'win32') app.setAppUserModelId('dev.flowmesh.app');

const cipher = {
  // Lazy: safeStorage only reports readiness once the app is ready, and the
  // store is created after that. A getter keeps the answer honest.
  get available() {
    return safeStorage.isEncryptionAvailable();
  },
  get label() {
    return 'OS keystore (DPAPI / Keychain / libsecret)';
  },
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (buffer) => safeStorage.decryptString(buffer),
};

let runtime = null;
let windowRef = null;
// Kept so the tray and the hotkeys can bring the window back after it is closed.
let launchUrl = null;

function writeLaunchUrl(url) {
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'launch-url.txt'), `${url}\n`);
  } catch {
    /* the URL is a convenience for verification, not a requirement */
  }
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'FlowMesh',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    if (!HEADLESS) window.focus();
  });

  // Tell the page which accelerators actually took effect. Pushing the truth beats
  // hardcoding a key in the UI that might be listening to nothing on this machine.
  const publishHotkeys = () => {
    const payload = JSON.stringify({ pull: hotkeyState.pull, approve: hotkeyState.approve });
    window.webContents.executeJavaScript(
      `window.__flowmeshHotkeys = ${payload}; window.dispatchEvent(new Event('flowmesh:hotkeys'));`,
    ).catch(() => {});
  };
  window.webContents.on('did-finish-load', publishHotkeys);

  const origin = new URL(url).origin;
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (/^https?:/i.test(target)) shell.openExternal(target);
    }
  });

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.loadURL(url).catch((error) => {
    dialog.showErrorBox('FlowMesh could not start', String(error && error.message ? error.message : error));
    app.quit();
  });

  window.on('closed', () => {
    windowRef = null;
  });

  return window;
}

/**
 * Ask the page to run one of its own actions.
 *
 * The hash is used rather than any privileged channel: the page already owns the plan
 * it is showing, so a hash change nudges the SAME code path the buttons use. Nothing
 * gains OS reach here, and a hotkey plan is exactly as visible and gated as a clicked
 * one. `executeJavaScript` runs in the isolated world and only sets the hash.
 */
function nudgeWindow(action) {
  // The window may have been closed while the app stayed resident for the hotkeys.
  if (!windowRef && launchUrl) windowRef = createWindow(launchUrl);
  if (!windowRef) return false;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.show();
  windowRef.focus();
  windowRef.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(action)}`).catch(() => {});
  return true;
}

function registerFirst(candidates, name) {
  for (const accelerator of candidates) {
    let ok = false;
    try {
      // A taken accelerator is a normal outcome, not a crash: try the next one.
      ok = globalShortcut.register(accelerator, () => nudgeWindow(name));
    } catch (error) {
      ok = false;
    }
    if (ok) return accelerator;
  }
  return null;
}

function registerHotkeys() {
  hotkeyState.pull = registerFirst(PULL_CANDIDATES, 'pull');
  hotkeyState.approve = registerFirst(APPROVE_CANDIDATES, 'approve');
  if (!hotkeyState.pull) {
    process.stderr.write('FlowMesh: no free accelerator for "pull my last dictation"; use the button or the tray.\n');
  }
  if (!hotkeyState.approve) {
    process.stderr.write('FlowMesh: no free accelerator for "approve the plan"; use the button.\n');
  }
}

function hotkeySummary() {
  const lines = [];
  lines.push(hotkeyState.pull
    ? `Pull my last dictation:  ${hotkeyState.pull}`
    : 'Pull hotkey unavailable: every candidate is taken by another app');
  lines.push(hotkeyState.approve
    ? `Approve the plan I am looking at:  ${hotkeyState.approve}`
    : 'Approve hotkey unavailable: every candidate is taken by another app');
  return lines.join('\n');
}

function buildTray(url) {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    trayRef = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } catch (error) {
    trayRef = null;
    return;
  }
  trayRef.setToolTip(`FlowMesh ${VERSION}\n${hotkeySummary()}`);
  trayRef.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show FlowMesh', click: () => nudgeWindow('') },
    { type: 'separator' },
    { label: 'Pull my last dictation', enabled: hotkeyState.pull, click: () => nudgeWindow('pull') },
    { label: 'Approve the plan on screen', enabled: hotkeyState.approve, click: () => nudgeWindow('approve') },
    { type: 'separator' },
    { label: hotkeySummary(), enabled: false },
    { type: 'separator' },
    { label: 'Quit FlowMesh', click: () => app.quit() },
  ]));
  trayRef.on('click', () => nudgeWindow(''));
  trayRef.setTitle?.('');
  return url;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'FlowMesh',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'How FlowMesh keeps you in control',
          click: () =>
            shell.openExternal('https://github.com/HamzaShaikh-source/flowmesh/tree/main/docs'),
        },
        {
          label: 'Open run records folder',
          click: () => shell.openPath(require('./runtime.js').artifactDir()),
        },
        {
          label: `Version ${VERSION}`,
          enabled: false,
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  const store = createStore({ cipher: cipher.available ? cipher : null });
  runtime = createRuntime({
    store,
    openExternal: (url) => shell.openExternal(url),
    // A native, out-of-band confirmation. The web layer (and any process holding the
    // session token) can send `acknowledged: true`, but cannot click this dialog.
    confirmProgram: async (server) => {
      const line = [server.command, ...(server.args || [])].join(' ');
      const { response } = await dialog.showMessageBox(windowRef || undefined, {
        type: 'warning',
        buttons: ['Cancel', 'Allow this program'],
        defaultId: 0,
        cancelId: 0,
        title: 'FlowMesh: run a program?',
        message: `Allow FlowMesh to run this program as an MCP server?`,
        detail: `${line.slice(0, 600)}

It will run with your permissions. Only allow programs you recognise.`,
      });
      return response === 1;
    },
  });

  const port = await runtime.listen(0);
  const url = `http://127.0.0.1:${port}/?k=${encodeURIComponent(runtime.sessionToken)}`;
  writeLaunchUrl(url);

  if (SERVER_ONLY) {
    process.stdout.write(`FlowMesh ${VERSION} bridge on ${url}\n`);
    return;
  }

  buildMenu();
  launchUrl = url;
  windowRef = createWindow(url);
  // The no-hands path: register after the window exists so a hotkey press has
  // somewhere to land. Failures are reported, never silently swallowed.
  registerHotkeys();
  buildTray(url);
}

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (windowRef) {
      if (windowRef.isMinimized()) windowRef.restore();
      windowRef.focus();
    }
  });

  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('FlowMesh could not start', String(error && error.message ? error.message : error));
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && runtime) {
      windowRef = createWindow(`http://127.0.0.1:${runtime.server.address().port}/?k=${encodeURIComponent(runtime.sessionToken)}`);
    }
  });

  app.on('window-all-closed', () => {
    // With a tray the app stays resident so the hotkeys keep working with no window
    // open; quitting is then an explicit choice from the tray or the app menu.
    if (process.platform !== 'darwin' && !trayRef) app.quit();
  });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    if (runtime) {
      runtime.killMcpNow();
      runtime.close();
    }
  });
}
