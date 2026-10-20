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

const { app, BrowserWindow, Menu, dialog, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { createStore, VERSION } = require('./config.js');
const { createRuntime } = require('./runtime.js');

const SERVER_ONLY = process.argv.includes('--server-only');
const HEADLESS = SERVER_ONLY || process.argv.includes('--headless');

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
  });

  const port = await runtime.listen(0);
  const url = `http://127.0.0.1:${port}/?k=${encodeURIComponent(runtime.sessionToken)}`;
  writeLaunchUrl(url);

  if (SERVER_ONLY) {
    process.stdout.write(`FlowMesh ${VERSION} bridge on ${url}\n`);
    return;
  }

  buildMenu();
  windowRef = createWindow(url);
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
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (runtime) runtime.close();
  });
}
