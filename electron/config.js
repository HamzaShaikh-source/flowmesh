'use strict';
/**
 * Settings + secrets for the Electron runtime.
 *
 * Same contract as flowmesh_config.py: five plain fields, two secrets, env
 * fallbacks, and a public view that reports *whether* a secret exists and never
 * its value. Secrets are encrypted with the OS keychain (Electron safeStorage)
 * when the host provides a cipher, and fall back to a 0600 file otherwise.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'FlowMesh';
const VERSION = '1.2.0';

const FIELDS = {
  board_url: 'FLOWMESH_BOARD_URL',
  docs_url: 'FLOWMESH_DOCS_URL',
  ha_url: 'FLOWMESH_HA_URL',
  light_entity: 'FLOWMESH_LIGHT_ENTITY',
  phone_service: 'FLOWMESH_PHONE_NOTIFY_SERVICE',
};

const DEFAULTS = {
  board_url: 'https://github.com/HamzaShaikh-source/flowmesh/issues',
  docs_url: 'https://github.com/HamzaShaikh-source/flowmesh/tree/main/docs',
  ha_url: '',
  light_entity: '',
  phone_service: '',
};

const SECRET_ENV = { jev_key: 'TYPESAFE_API_KEY', ha_token: 'FLOWMESH_HA_TOKEN' };

function configDir(env = process.env) {
  if (env.FLOWMESH_CONFIG_DIR) return env.FLOWMESH_CONFIG_DIR;
  if (process.platform === 'win32') {
    const base = env.APPDATA || env.LOCALAPPDATA;
    if (base) return path.join(base, APP_NAME);
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, APP_NAME.toLowerCase()) : path.join(os.homedir(), `.${APP_NAME.toLowerCase()}`);
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, data);
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    /* Windows has no POSIX mode; the directory ACL is the boundary there. */
  }
  fs.renameSync(temporary, file);
}

function createStore({ dir = configDir(), env = process.env, cipher = null } = {}) {
  const settingsPath = path.join(dir, 'settings.json');
  const plainSecretsPath = path.join(dir, 'secrets.json');
  const encryptedSecretsPath = path.join(dir, 'secrets.enc.json');

  function settings() {
    const saved = readJson(settingsPath);
    const out = {};
    for (const [name, envName] of Object.entries(FIELDS)) {
      out[name] = String(saved[name] || env[envName] || DEFAULTS[name]);
    }
    return out;
  }

  function secret(name) {
    if (!(name in SECRET_ENV)) return '';
    let stored = '';
    if (cipher && cipher.available) {
      const blob = readJson(encryptedSecretsPath)[name];
      if (typeof blob === 'string' && blob) {
        try {
          stored = cipher.decrypt(Buffer.from(blob, 'base64'));
        } catch {
          stored = '';
        }
      }
    }
    if (!stored) stored = String(readJson(plainSecretsPath)[name] || '');
    return stored || env[SECRET_ENV[name]] || '';
  }

  function secretBackend() {
    return cipher && cipher.available ? cipher.label : 'local file (0600)';
  }

  function publicSettings() {
    return {
      ...settings(),
      jev_connected: Boolean(secret('jev_key')),
      ha_token_connected: Boolean(secret('ha_token')),
      secret_backend: secretBackend(),
    };
  }

  function validate(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Settings body must be an object');
    }
    const clean = {};
    for (const [name, value] of Object.entries(values)) {
      if (name in FIELDS) {
        if (typeof value !== 'string') throw new Error(`${name} must be text`);
        if (value.length > 500) throw new Error(`${name} is too long`);
        const trimmed = value.trim();
        if (trimmed && /^(board_url|docs_url|ha_url)$/.test(name) && !/^https?:\/\//i.test(trimmed)) {
          throw new Error(`${name} must start with http:// or https://`);
        }
        if (trimmed && name === 'light_entity' && !/^light\.[a-z0-9_]+$/i.test(trimmed)) {
          throw new Error('light_entity must look like light.desk');
        }
        if (trimmed && name === 'phone_service' && !/^mobile_app_[a-z0-9_]+$/i.test(trimmed)) {
          throw new Error('phone_service must look like mobile_app_phone');
        }
        clean[name] = trimmed;
        continue;
      }
      if (name in SECRET_ENV) {
        if (typeof value !== 'string') throw new Error(`${name} must be text`);
        if (value.length > 500) throw new Error(`${name} is too long`);
        storeSecret(name, value.trim());
        continue;
      }
      throw new Error('Unknown setting');
    }
    if (Object.keys(clean).length) {
      const merged = { ...settings(), ...clean };
      writePrivate(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    }
    return publicSettings();
  }

  function storeSecret(name, value) {
    if (cipher && cipher.available) {
      const file = readJson(encryptedSecretsPath);
      if (value) file[name] = cipher.encrypt(value).toString('base64');
      else delete file[name];
      writePrivate(encryptedSecretsPath, `${JSON.stringify(file, null, 2)}\n`);
      return;
    }
    const file = readJson(plainSecretsPath);
    if (value) file[name] = value;
    else delete file[name];
    writePrivate(plainSecretsPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  return { dir, settings, secret, publicSettings, validate, secretBackend };
}

module.exports = { APP_NAME, VERSION, FIELDS, DEFAULTS, SECRET_ENV, configDir, createStore, readJson, writePrivate };
