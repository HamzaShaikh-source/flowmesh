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

## Published release — v1.3.0 (built by CI from `09264a0`)

All four assets were produced by CI run `39560592140` on the released SHA and uploaded
straight from that run, so no artifact predates the code it claims to contain. Sizes are
the published sizes; hashes are of the uploaded files.

| Asset | Bytes | SHA-256 |
| --- | --- | --- |
| `FlowMesh-1.3.0-win-x64.exe` | 103,346,467 | `839ee250613f7d77f1f178a7a101046c6460b17620b7b5548436b1283c7b5585` |
| `FlowMesh-1.3.0-mac-arm64.dmg` | 127,530,356 | `e442ad45ebadeb8a45aed73547c31f54412d4272f928a316782a17f538b78de8` |
| `FlowMesh-1.3.0-linux-x86_64.AppImage` | 125,117,298 | `0a21ae56d4e4f5867f07f42c5838d080db4df37da14d2a7cb8b943aa746efa0f` |
| `FlowMesh-Windows.zip` | 14,322,755 | `d1327e1cacc578449b84347d7f6987d60c6f874c9890f88d7ff161352051add9` |

Windows Electron is a **portable single executable** (`portable` target), not a zip —
double-click it, no installer and no extraction. macOS is **arm64 only**. All builds are
unsigned.

## Wispr connector, verified in the packaged runtime (v1.3.0)

Proved end to end against the **frozen** Windows build, not just the dev tree: launch
`dist/FlowMesh/FlowMesh.exe --headless`, read the launch URL, then call each endpoint
with the real session token.

```
$ curl -H "X-FlowMesh-Token: <redacted>" http://127.0.0.1:<port>/api/status
version: 1.3.0 | mode: desktop_app | platform: win32

$ curl -H "X-FlowMesh-Token: <redacted>" http://127.0.0.1:<port>/api/wispr
state: connected | dictations: 9 | usable: 2
read_only: True | supported_api: False
ignored: ['audio', 'screenshot', 'axText', 'axHTML']
stats: {"dictations": 9, "words": 7, "median_latency_ms": 1152,
        "dictionary_entries": 8, "snippets": 4,
        "apps": [{"app": "brave", "dictations": 2}]}
latest: null            <- correct: nothing dictated in the last 5 minutes

$ curl -H "X-FlowMesh-Token: <redacted>" http://127.0.0.1:<port>/api/wispr/dictionary
entries: 8 | state: connected

$ curl -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/wispr   # no token
401
```

The UI was verified in a real browser against the dev runtime: badge `connected`, stats
`9 dictations · 7 words · median 1152 ms`, zero console errors; a 1727-character
dictation pulled and trimmed to 968 at a sentence boundary with the tail absent; the
provenance line reading "From your Wispr Flow history (last dictated into synthapp) ·
8s ago · read-only", flipping to "Typed by you" after one edit.

The hosted browser edition shows the same panel as **desktop only** with the reason,
so the integration is visible to a judge who only opens the link. Deployed `ui.js` is
byte-identical to the repo (`sha256 e2aac2006683...`).

**Build-entry correction:** an initial local rebuild froze `bridge.py`, which serves a
bare bridge with no window and never writes `launch-url.txt`. The shipped artifact is
built from `desktop.py` (as CI does). Re-verified after the correction.

## No-hands control (Electron, v1.3.0)

Probe: `npx electron scripts/probe_hotkeys.js` — runs the real runtime, a real window, the
real `globalShortcut` / `Tray` APIs, and the same hash nudge the shell performs.

| Claim | Result |
| --- | --- |
| `Ctrl+Shift+Space` registers on this machine | **No** — already owned by another program (this is why the app uses a candidate list) |
| Fallback accelerator registers | **Yes** — `Ctrl+Shift+D` took effect |
| Approve accelerator registers | **Yes** — `Ctrl+Shift+Return` |
| Tray constructs with the app icon | **Yes** |
| Hotkey nudge fills the box from real Wispr data | **Yes** — `"start a 15 minute focus session"` |
| Provenance after a hotkey pull | **Yes** — `last dictated into probeapp · 22s ago · read-only, never sent anywhere` |
| Hash cleared so a stale nudge cannot re-fire | **Yes** — `""` |
| Approve nudge with no plan runs nothing | **Yes** — toast only |
| Page renders the accelerators actually registered | **Yes** — hint read `Ctrl+Shift+D … Ctrl+Shift+Enter`, 6 `kbd` chips |
| Physical keypress → action on a real keyboard | **not verified here** — the accelerator registration and the handler were both exercised, but no human pressed the key in this session |

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

## The connector on the hosted page (21 October 2026)

The browser cannot read a local SQLite file, so the hosted link used to describe the
connector without ever showing it. `web/media/connector-live.mp4` (12.3 s, 161,545 bytes)
is a capture of the **desktop runtime** reading the **real** database on this machine:

| Check | Result |
| --- | --- |
| Recording source | `bridge.serve(0)` on this machine, real `flow.sqlite`, real session token |
| Panel state during capture | `connected` |
| Stats shown in the recording | `9 dictations · 7 words · median 1152 ms` — the same numbers `docs/EVAL.md` reads |
| Pressing "Use my last dictation" | reports `No fresh dictation to use.` (nothing landed in the 5-minute window) |
| Shown on the hosted page | only in `paintWisprDesktopOnly()`, so the desktop runtimes still show the live panel instead |
| Live URL | `https://flowmesh-nohands.netlify.app/media/connector-live.mp4` → 200, `video/mp4`, 161,545 bytes |
| Poster | `connector-live-poster.jpg` → 200, 62,913 bytes |

Two console CSP violations appear on the hosted page. They come from Netlify's own
injected HUD snippet being refused by this page's `style-src 'self'` / `script-src 'self'`
policy — the page's own scripts are unaffected, and the CSP is doing its job.

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

## Coding agents and messaging templates (23 October 2026)

Windows 11, the author's machine, Python 3.12, Node 24 test runner.

| Check | Result |
| --- | --- |
| Detection of the six CLIs | all six found on `PATH`; Claude Code reported `loggedIn: true` via claude.ai, Codex reported "Logged in using ChatGPT" |
| Real Codex run through the HTTP bridge (read-only, empty throwaway repo) | plan `risk: read`; command `codex exec -s read-only -C <folder> -` with the task on stdin; receipt `returned`; git saw 0 changed files. Codex could not start PowerShell inside its Windows sandbox, so it did not answer the question: a good demonstration that `returned` is not `verified` |
| Real Claude Code run through the browser UI (read-only) | plan, approve and the live panel worked; the run ended `failed` with Claude's own "OAuth session expired and could not be refreshed". git saw two untracked files, written by hooks in the author's own Claude setup, and the receipt lists them without claiming the agent made them |
| Full suites | Python 337 tests OK, Node 186 tests OK (after relays, the wake word and councils; the earlier 34+15+15+7 agent tests are part of these) (includes 34 agent module, 15 Python bridge, 15 Electron runtime and 7 parity tests, all against a mock agent) |
| Templates: Discord, Slack, Notion, Agent Switch | the Tools page fills command, arguments and the token placeholder correctly (checked in the UI); the servers themselves were **not** started |

**Not verified:** an agent run that edits files with a real model; any real run of Antigravity,
OpenCode, Gemini CLI or Aider; any of the four messaging servers talking to a real Discord, Slack,
Notion or Switch.

## Relays and the wake word (23 October 2026)

| Check | Result |
| --- | --- |
| Relays (review, chain, compare) | planned and run through both runtimes against the mock agent: handoff text arrives as untrusted data, a failed step skips the rest, full access needs the second confirmation, an agent with no read-only mode is refused as a reviewer. The three-agent plan renders in the real UI with real agent names; it was **not run** with real models |
| Wake word | the Windows recogniser (en-US) started on this machine's default microphone through the real UI: state `listening`, badge shown, then switched off. **Nobody spoke to it**, so hearing accuracy, false wakes and a real Wispr shortcut press are not verified |

## Councils (23 October 2026)

| Check | Result |
| --- | --- |
| Debate and judge panel, both runtimes | scripted agents (with banners and echoed prompts, like real CLIs) and the mock agent CLI: anonymous shuffled ideas, no self-votes, tie-breaking, silent or invalid agents, withdrawals, cancellation, blind prompts, median and caps, partial scorecards rejected, secrets never shown; Python and Node produce identical parses, tallies, audits, aggregates and reports (parity tests) |
| Real UI | a three-agent debate plan (Claude Code, Codex, Antigravity) was created: `read` risk, not auto-run, three commands listed; it was **not run** |
| Not verified | any council with real models: whether real CLIs return parseable JSON reliably, how long four rounds take, and how useful the votes and scores are |

## The page pilot and the on-site demo clip (23 October 2026)

| Check | Result |
| --- | --- |
| Pilot language | 8 Node test groups: zoom, volume, screenshot, movement, strict palette matching and its ambiguity rules, refused approval/deletion labels, sentences that merely contain command words, odd input |
| Desktop abilities | volume media keys and window screenshots in both runtimes with injected fakes (no real key pressed), Python-to-Node parity; two input-validation bugs found and fixed (an array as the volume action) |
| Real page | zoom in/set/reset changed the page zoom; mute and "set volume to 40 percent" changed the voice volume; "scroll to the receipts section" scrolled; "zoom to 130 percent" typed into the capture field took effect; a sentence beginning "zoom in on ..." and "approve the plan on screen" were not treated as pilot commands |
| Not verified | real tab capture and real full screen (the automation pane blocks both and the pilot reported that), a real Windows system-volume change, the Electron window screenshot against a real window |
| On-site clip | `web/media/demo.mp4`, 1280x720 H.264, 65 s, 2.6 MB, recorded from the real page in headless Edge with typed sentences standing in for dictation, a badge saying so on every frame, and real mouse clicks for the two approvals. The poster is a frame from the clip. It is **not** a recording of Wispr Flow |

## The Guide page (23 October 2026)

The hosted site already carried the voice harness, the page pilot and the demo clip, but nothing on screen said
how to use them: the command list was only reachable by saying "what can I say". A Guide page, a dock button and a
Home link now do. Checked in the real page at desktop and phone widths: nine nav items fit with no horizontal
overflow; the commands are generated (11 groups, 38 try-it buttons, 1 note); clicking "zoom in" and "reset zoom"
worked; a test fails if any offered phrase does nothing or could approve or delete.

## The shipped Windows build, run for real (23 October 2026)

Run: `FlowMesh-1.7.3-win-x64.exe` (the release asset) on the author's Windows 11 machine, driven through its own HTTP
API, once headless (`--server-only`) and once with its window.

| Check | Result |
| --- | --- |
| Starts, reports its version and platform | yes: `1.7.3`, `win32`, desktop runtime |
| Wispr history reader | **works**: `connected`, 21 dictations / 49 words read from the real local Wispr database |
| Wispr live pickup | reachable (`/api/wispr/latest` answered `none`: no fresh dictation); **not exercised with a real Wispr key press** |
| Wispr account (sign-in, Scratchpad) | `disconnected`; the post-sign-in token exchange is **still unverified** |
| Planner | `Rules` (local, deterministic) because no model key is configured. **Nothing is "AI-backed" by default**; a model only proposes plans if you add a key, and that path was not run here |
| Coding agents detected | all six found; Codex and OpenCode reported signed in, Claude Code signed out |
| A real read-only Codex task | **failed in 1.7.3** (see bugs); after the fixes, it ran and the receipt was `returned`, but Codex could not read the file because its own Windows sandbox failed (`setup refresh had errors`). **No real agent task has produced a real answer through FlowMesh yet** |
| Window screenshot (pilot) | **works**: a 130 KB PNG of the real window saved with a SHA-256; the image shows the app |
| MCP servers, Discord/Slack/Notion/Switch, Home Assistant, relays and councils with real models, wake word with a real voice, Windows volume keys | **not run** in this check |

Bugs this check found in the shipped 1.7.3 (fixed after it, not yet released):

1. **Windows command resolution (Electron).** `resolveCommand('codex')` returned npm's extensionless shell script
   instead of `codex.cmd`, so Codex, OpenCode and Gemini CLI could not be started, and neither could any
   `npx`-based MCP server, from the Electron app. The Python runtime was correct. A bare name now resolves through
   `PATHEXT` as `shutil.which` does, with a parity test against Python on Windows.
2. **Codex read-only in a folder that is not a git repository** was refused by Codex ("Not inside a trusted
   directory"). Read-only mode now passes `--skip-git-repo-check`; editing modes keep the check.
3. **A CLI error was displayed as a version** (Gemini's local wrapper on this machine fails when launched without a
   shell, in both runtimes). A version is now only a line that looks like one.
