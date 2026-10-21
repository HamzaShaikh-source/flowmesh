# Verification

Everything below was run on this machine on **20 October 2026** (Windows 11,
Python 3.11.16, Node 22, Electron 44.4.3). Where something is *not* verified it
says so in the last section instead of being implied.

## Test suites

```
$ python -m unittest discover -s tests -q
Ran 57 tests in 10.354s
OK

$ npm test
# tests 18
# pass 18
# fail 0

$ node scripts/e2e_electron.js
10/10 checks passed        # real Electron window, real renderer, real actions
```

The 57 Python tests cover: planner routing and refusals, second-intent detection,
plan lifetime and single use, the HTTP contract (host, origin, token, content
type, body allowlist, body size), settings validation and secret redaction, run
record hashing, parity between `planner.py` and `web/core.js`, and the planner
golden shared with the Node suite.

The 18 Node tests run the same contract against the Electron runtime over a real
loopback socket, plus the planner golden — so neither language can drift alone.

## The planner golden (how the two languages stay honest)

```
$ python scripts/export_planner_golden.py     # writes electron/test/fixtures/planner_golden.json
```

- `tests/test_planner_golden.py` asserts `planner.py` still produces every entry.
- `electron/test/parity.test.js` asserts `web/core.js` still produces every entry.

Both sides are pinned to one file, so a change on either side fails CI.

## Browser edition — live at https://flowmesh-nohands.netlify.app/

Verified in a fresh Chromium at 1512×950 after the 1.2.0 deploy:

- badge `Browser edition · live`;
- `focus for 25 minutes, open the board and start a timer` → plan **Deep focus**;
- `Approve & run` → receipts
  `Open project board:sent · Start 25 minute timer:verified · Notify my phone:desktop_only · Set desk lamp to 30%:desktop_only · Save run record:verified`,
  and the run record downloaded as `flowmesh-20261020-232606-focus.md`;
- screenshot `shots/13-live-after-1.2.0.png`.

Byte comparison, local vs. served (`sha256sum`): `ui.js` `6411c5a44bb1…`,
identical. `app.css` and `core.js` likewise; `index.html` differs only by the two
blocks Netlify injects at serve time. Deploy is reproducible:
`python scripts/deploy_netlify.py` (token read from the Netlify CLI config, never
printed).

## Python desktop runtime

Verified against `desktop.py --headless` and the packaged binary:

- plan → approve → receipts with the run record written to disk
  (`~/FlowMesh/runs/<stamp>-<route>-<id>.md`) plus byte count and SHA-256;
- the approved board URL is handed to the default browser (`sent`);
- the 25-minute timer is scheduled (`verified`);
- phone and lamp report `not_configured` — nothing is sent, nothing is claimed;
- `"delete my files"` → `422`, no plan; replay → `409`; foreign `Origin` → `403`;
  malformed JSON → `400`; client-composed actions → `400`;
- plans live in memory, expire in 300 s, and are single use.

## Published artifacts (release `v1.2.0`, tag on `ccf1527`)

| Asset | Bytes | sha256 |
| --- | --- | --- |
| `FlowMesh-1.2.0-win-x64.zip` (Electron, Windows x64) | 141,980,631 | `9da162ac81b53242721b10f5f6557312725d7d6849e03fdc8cb7c5261a6a8cf7` |
| `FlowMesh-1.2.0-mac-arm64.dmg` (Electron, Apple silicon) | 127,498,455 | `8613dd8b80888ef0ceeefa4321a9514cd80ffaa09e0ed1a841a697de9acce16e` |
| `FlowMesh-1.2.0-linux-x86_64.AppImage` (Electron, Linux x64) | 125,100,893 | `1eb68c74ca0b61d3882b61f4aa92f43c4dcb420f061574c39b42abc4762da03c` |
| `FlowMesh-Windows.zip` (Python desktop, Windows x64) | 12,645,620 | `814e6a41b6e3a9951521634c86d580d6d0463a152c87a43c6129d71fc53f95cd` |

The digest GitHub reports for each asset was read back from the API and matches the
local file byte for byte. The two Windows artifacts were additionally executed from
a clean extraction. The macOS and Linux artifacts come from CI runners of their own
OS; they are **not** executed here (no such machine) — the honest limit is recorded
in the last section.

## Packaged Windows build (Python)

```
$ .venv/Scripts/pyinstaller.exe --noconfirm --onedir --windowed --name FlowMesh \
    --distpath release --workpath build --add-data "web;web" --collect-all keyring desktop.py
=> Build complete. Output: release/FlowMesh (26 MB on disk)

$ sha256sum release/FlowMesh-Windows.zip
814e6a41b6e3a9951521634c86d580d6d0463a152c87a43c6129d71fc53f95cd
12,645,620 bytes
```

Exercised from a **clean extraction** of that zip (`%TEMP%\fmpy`), not the source
tree: `FlowMesh.exe --headless` serves the UI, writes `launch-url.txt`, and the
shared probe reports **15/15 checks passed** (status/auth, plan, execute,
receipts, record hash, replay, tamper, cross-origin, refusal, settings).

## Electron build — `FlowMesh-1.2.0-win-x64.zip`

```
$ npx electron-builder --win --dir -c.win.signAndEditExecutable=false
$ rcedit FlowMesh.exe --set-icon electron/assets/icon.ico --set-file-version 1.2.0 …
$ 7za a -tzip -mx=5 FlowMesh-1.2.0-win-x64.zip win-unpacked

$ sha256sum release-electron/FlowMesh-1.2.0-win-x64.zip
9da162ac81b53242721b10f5f6557312725d7d6849e03fdc8cb7c5261a6a8cf7
141,980,631 bytes (135.3 MiB), 320 MB unpacked
```

Exe metadata, read back with PowerShell after `rcedit`:
`ProductName FlowMesh · FileVersion 1.2.0 · CompanyName FlowMesh`.

Exercised from a **clean extraction** of the published zip (`%TEMP%\fmex2`):

- starts `FlowMesh.exe --server-only`, binds `127.0.0.1`, writes the tokenised
  `launch-url.txt`;
- the same probe as the Python build: **15/15 checks passed**, including
  `Unknown setting` (identical wording to the Python runtime),
  `Plan expired or already used` on replay, `Invalid plan` on an amended body,
  `Cross-origin requests are denied`, and `Command is unsupported, unclear, or not allowed`;
- `app.asar` inside the extraction is byte-identical to the built folder
  (`7e7dd9b730a4a215…`), so no stale assets shipped;
- secrets stored through Electron `safeStorage` report
  `backend=OS keystore (DPAPI / Keychain / libsecret)`; the Python build reports
  `WinVaultKeyring`. Both redact values on read.

Windowed run, captured from the packaged binary itself: title bar **FlowMesh**,
badge **`Desktop runtime · win32`**, the real console UI, no browser chrome
(`shots/12-electron-packaged.png`).

The renderer E2E (`scripts/e2e_electron.js`) drives the actual Electron window
through Playwright's Electron API: types the command, plans, approves, waits for
receipts, asserts `approve` is disabled afterwards, asserts every receipt label
and status, and asserts the run record it names exists on disk.

## CI

All seven jobs green on `ccf1527` (run `39471591777`):

```
test (ubuntu-latest)            success
test (macos-latest)             success
test (windows-latest)           success
package (python, windows)       success
package (electron, windows-latest) success
package (electron, macos-latest)   success
package (electron, ubuntu-latest)  success
```

The Electron packaging jobs produce real native artifacts on their own runners
(`.dmg`, `.AppImage`, portable `.exe`). Job IDs and artifact sizes are recorded
in the release notes.

## What is NOT verified (stated plainly)

| Item | Status |
| --- | --- |
| Home Assistant phone notification against a real phone | not verified — no device or token on this machine; adapter covered by fixtures only |
| Lamp state read-back | not verified — no Home Assistant instance |
| TypeSafe Jev model routing | not verified — no API key; the local planner path is what ships as default |
| Keystrokes from `POST /api/type` landing in a focused app | **not verified here** — this shell is a detached session (`GetConsoleWindow()` returned 0; a test window's `Shown` handler never fired), so there is no focused window. The `keybd_event` unicode sequence the action ships ran without error (`keystrokeCallCompleted=true`) but nothing received it. Receipts say **sent**, never verified. Only Windows re-reads `GetForegroundWindow` after typing; macOS and Linux report that they cannot confirm which window received the keystrokes |
| macOS and Linux desktop binaries, built and run by a human | not verified here — built by CI on those runners; this machine is Windows. CI built **arm64** macOS only; an Intel-Mac build would need a `macos-13` job (the browser edition covers Intel Macs today) |
| Code signing / notarisation | not signed — no certificates; Windows SmartScreen and macOS Gatekeeper will warn, and the docs say so |
| The judge's browser and OS combination | cannot verify |
