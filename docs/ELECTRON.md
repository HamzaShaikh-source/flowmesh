# The Electron build

FlowMesh ships one UI and one planner with three runtimes. This document covers
the cross-platform desktop one.

## Why it exists

The packaged Python app is Windows-only: it renders through WebView2 and drives
Windows apps. That is the right build for the machine it was written on, and the
wrong answer for a judge on a Mac. The Electron build closes that gap — Windows,
macOS and Linux from the same source, with the same UI, the same planner, and the
same approval rules.

It is additive. Nothing in the Python runtime was removed or replaced; both are
built from `web/` and both answer the same HTTP contract.

## What is shared

| File | Role |
| --- | --- |
| `web/index.html`, `web/app.css`, `web/ui.js` | the console — unchanged, byte-identical to the hosted edition |
| `web/core.js` | the planner (ported from `planner.py`, gated by golden fixtures) |
| `electron/runtime.js` | plans, one-use IDs, actions, receipts, loopback HTTP |
| `electron/config.js` | settings + secrets (safeStorage / 0600 file), same fields as `flowmesh_config.py` |
| `electron/main.js` | window, menu, lifecycle, OS hooks (`shell.openExternal`, safeStorage) |
| `electron/preload.js` | read-only identity only — no privileged bridge |

The UI does not know which runtime it is talking to. It asks `/api/status`; if
that answers `mode: "desktop_app"` it enables the desktop features, otherwise it
stays in browser mode.

## Security model

The renderer is treated as hostile:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- no IPC that can act; the preload exposes `{ shell, platform }` and nothing else
- navigation is pinned to `http://127.0.0.1:<port>`; any other target is handed
  to the OS browser, never loaded in-app
- `will-attach-webview` is denied; window-open requests are denied
- CSP on the served page: `default-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'`

The runtime is treated as the only authority:

- listener bound to `127.0.0.1` on an ephemeral port
- every `/api` call needs the per-launch token, compared with `timingSafeEqual`
- `Host` must be the loopback pair; cross-origin `POST` is refused (`403`)
- `Content-Type` must be JSON (`415`); bodies over 8 KB are refused (`413`)
- `/api/execute` accepts `plan_id` and nothing else — any other key is `400 Invalid plan`
- plans expire after 300 s and are consumed exactly once (`409` on replay)
- actions come from a fixed registry; the two launchable apps are allowlisted per
  platform (`notepad.exe`/`calc.exe`, TextEdit/Calculator, gedit/gnome-calculator/
  kate/xed/mousepad, gnome-calculator/kcalc/galculator) and passed as
  `spawn(argv, { shell: false })`, never through a shell string
- URL actions only accept `http(s)` and only the two configured destinations
- secrets never leave the main process: `/api/settings` returns
  `jev_connected` / `ha_token_connected` booleans and the backend name only

## Receipts

Identical vocabulary to the Python runtime — `verified`, `sent`,
`not_configured`, `denied`, `failed`, `unavailable`. A `sent` receipt is never
upgraded to `verified`. Run records are written atomically to
`~/FlowMesh/runs/` and the receipt carries byte count and SHA-256.

## Run it from source

```bash
npm ci
npm start              # windowed
npm run serve          # bridge only, prints the tokenised URL
npm test               # node --test: parity + full loopback contract
```

`npm test` needs no Electron binary download beyond `npm ci`; the runtime is
plain Node so the security suite runs on a bare interpreter, exactly like the
Python `unittest` suite.

## Package it

```bash
npm run pack:dir       # unpacked folder, offline → release-electron/win-unpacked
npm run pack:win       # portable .exe          → release-electron/
npm run pack:mac       # .dmg                   (must run on macOS)
npm run pack:linux     # .AppImage              (must run on Linux)
```

The Windows artifact shipped for this challenge is the unpacked folder zipped:
`FlowMesh-1.2.0-win-x64.zip` (135 MiB) — unzip, run `FlowMesh.exe`. It is built
with `pack:dir`, branded with `rcedit` (icon, `ProductName`, `FileVersion`), and
verified from a clean extraction (see `docs/VERIFICATION.md`).

CI does all three on their native runners (`.github/workflows/ci.yml`,
`package-electron`), and uploads the artifacts. Nothing is signed or notarised:
the first launch will show the usual OS warning, and the honest way to run it is
to build from source or check the SHA-256 of the artifact you downloaded.

## Verified behaviour

Observed on 20 October 2026, from a clean extraction of the published zip:

- `node --test` → **18/18 pass** (planner golden + full loopback contract);
- `node scripts/probe_electron_runtime.js` → **15/15 checks pass**, same script
  that passes against the Python build;
- `node scripts/e2e_electron.js` → **10/10**, driving the real window: type →
  plan → approve → receipts → approve disabled → record present on disk;
- secrets report `backend=OS keystore (DPAPI / Keychain / libsecret)`.

Full commands and output: `docs/VERIFICATION.md`.
