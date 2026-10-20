'use strict';
/**
 * The renderer gets no privileged bridge: no filesystem, no shell, no IPC that
 * can act. It talks to the loopback HTTP contract like any other client and
 * carries the per-launch token in its URL. Only read-only identity is exposed
 * so the page can label itself honestly.
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('flowmeshHost', {
  shell: 'electron',
  platform: process.platform,
});
