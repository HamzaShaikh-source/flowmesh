# Verification log

Every line here was produced on the author's Windows machine on **20 October 2026** (IST), against this checkout. Nothing is projected or estimated. If a line says *not verified*, it stays that way until someone runs it.

## Test suite — local, Windows 11, Python 3.11.16

```
$ python -m unittest discover -s tests -v
Ran 49 tests in 10.435s
OK

$ node --check web/core.js && node --check web/ui.js
JS_OK
```

Coverage by file: planner behaviour and refusals, HTTP contract and trust boundaries (token, host, origin, replay, malformed bodies, client-composed actions), adapter receipt semantics, artifact writing + SHA-256, and Python↔JS planner parity over the shared fixtures.

Command run: `.venv/Scripts/python.exe -m unittest discover -s tests`

## Browser edition — real Chromium (Playwright), viewport 1440×900

Verified in `http://127.0.0.1:8774/` served as a plain static directory (no `/api`):

- badge reads `Browser edition · live`;
- command → plan with five actions and surfaces, `EXPIRES IN …`, single use;
- `Approve & run` → timer receipt `verified`, URL receipt `sent`, phone and lamp `not_configured` with reasons;
- run record generated in-page and downloaded as `flowmesh-<stamp>-capture.md`;
- `desktop_only` shown where the page cannot act;
- console clean: no errors; two harmless warnings (unused preload) fixed by adding `crossorigin`;
- the session token is stripped from the address bar after load.

Screenshots: `shots/01-console-1440.png`, `shots/02-plan.png`, `shots/03-receipts.png`, `shots/05-browser-edition.png`.

## Desktop edition — local runtime on 127.0.0.1

Verified against `desktop.py --headless` with a real token in the URL:

- `GET /api/status` reports platform, version and capability flags;
- plan → approve → receipts, with the run record **written to disk** (`~/FlowMesh/runs/flowmesh-20261020-214117-research-9dOWEV.md`) and byte count + SHA-256 in the receipt;
- the approved board URL was opened in the default browser (`sent`);
- the 25-minute timer was scheduled server-side (`verified`);
- phone notification and lamp returned `not_configured` (no Home Assistant configured on this machine) — no request was sent and none is claimed;
- `"delete my files"` refused with `422` and no plan;
- replay of a spent plan → `409`; foreign `Origin` → `403`; malformed JSON → `400`; client-composed action payload → `400`;
- plan expiry is 300 s and plans live in memory only.

## Packaged Windows build — `release/FlowMesh-Windows.zip`

```
$ python -m PyInstaller --noconfirm --clean --onedir --windowed --name FlowMesh \
    --distpath release --workpath build --add-data "web;web" --collect-all keyring desktop.py
Build complete! The results are available in: D:\projects\flowmesh-handsfree
elease

$ sha256sum FlowMesh-Windows.zip
30E15A268BFFDDDC727CC72856EC500AB2BC770C07507F57F647412E75DC38E1
12.97 MB (12,971,876 bytes)
```

Exercised on the **binary**, not the source tree:

- windowed launch → real window, `MainWindowTitle = FlowMesh`, `Responding = True`;
- `--headless --port 8782` → `GET /api/status` `200`, `version 1.1.0`, `platform win32`,
  capabilities `{launch_app: ready, open_url: ready, timer: ready, write_note: ready, notify: not_configured, light: not_configured}`;
- plan → execute → **5 receipts**: `sent` (board URL handed to the browser), `verified` (25-minute timer),
  `not_configured` ×2 (phone, lamp), `verified` (record written, 1,474 bytes + SHA-256);
- replay → `409`; foreign `Origin` → `403`; `delete my files` → `422`; amended payload (`plan_id` + `actions`) → `400`; malformed JSON → `400`;
- unauthenticated `GET /api/status` → `401`;
- ZIP extracted to a clean temp directory → `FlowMesh.exe` runs there, serves the UI (`200`), writes `launch-url.txt` (0600) and completes the same five-receipt run.

`launch-url.txt` lives at `%APPDATA%\FlowMesh\launch-url.txt`; it carries the per-launch token, is user-only, and is overwritten on every launch.

## What is NOT verified (stated plainly)

| Item | Status |
| --- | --- |
| Home Assistant phone notification against a real phone | not verified — no device or token on this machine; adapter covered by fixtures only |
| Home Assistant lamp brightness read-back against a real lamp | not verified — same |
| Jev Choice live routing | not verified — no API key used; stub-tested |
| macOS / Linux desktop run | not verified locally; both run the same stdlib runtime and are exercised in CI |
| Wispr Flow dictation | belongs to the author's own machine and account; see `SUBMISSION.md` |
| Demo video, Insights card | not produced here, by design |

## Prior claims re-checked

The v1.0 notes claimed 19 tests. That number is superseded: the suite is now **49 tests**, all passing. The v1.0 release ZIP hash `43AEDFF2…819B5FBF` described the previous build and does **not** describe v1.1.0; the v1.1.0 hash is published in the release notes and below.
