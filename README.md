# FlowMesh

**Say the work. See it happen.**

FlowMesh turns one dictated sentence into a bounded, line-by-line plan you approve once — then performs the actions you allowed, and shows an honest receipt for each one.

Built for **No Hands: The Wispr Challenge** (WeMakeDevs × Wispr Flow), Builders track, by Hamza Shaikh.

- **Try it in the browser — no install:** https://flowmesh-nohands.netlify.app/
- **Desktop app — download and run:** https://github.com/HamzaShaikh-source/flowmesh/releases
  - `FlowMesh-1.3.0-win-x64.exe` — Electron app for **Windows**, a single portable executable (no install; 99 MiB)
  - `FlowMesh-1.3.0-mac-arm64.dmg` — Electron app for **Apple-silicon macOS**
  - `FlowMesh-1.3.0-linux-x86_64.AppImage` — Electron app for **Linux x64** (`chmod +x`, then run)
  - `FlowMesh-Windows.zip` — the smaller Windows-only Python build (13 MiB, no Node)
- **Source:** this repository. Stdlib-only runtime, no build step for the UI.

**New in this build — FlowMesh reads Wispr Flow directly.** Hold your Wispr key, speak, then press **Use my last dictation**: FlowMesh pulls that sentence out of your own Wispr Flow history, read-only, and hands it to the plan-approve-run loop. No copying, no retyping, no second app to alt-tab to. It reads a fixed allow-list of metadata columns and never touches the audio, screenshots or surrounding app text that live in the same file. If Wispr Flow is not installed, the panel says so instead of pretending. Details: [`docs/WISPR-CONNECTOR.md`](docs/WISPR-CONNECTOR.md).

---

## The problem it solves

My workday is a stream of small, real switches: open the board for this call, start a focus block, ping my phone that I'm heads-down, dim the lamp, jot the follow-up before it evaporates. Each one is trivial. Together they cost the first ten minutes of every block and they are exactly the moments where dictation is faster than a mouse.

The failure mode of "AI computer control" is not capability, it is **trust**: a model that turns a sentence straight into shell commands is unusable for real work. So FlowMesh inverts the usual demo: the model (or the local rules) may only **choose among registered workflows and parameters**. What actually runs is a fixed, allowlisted action set, executed once, after you read the plan.

Three registered routines:

| Routine | What it plans |
| --- | --- |
| `focus` | Open the board, launch Notepad, start a timer of the length you said |
| `meeting` | Open the board, start the timer, notify your phone, save the follow-up |
| `research` | Open docs or the board, start the sprint timer, notify your phone, set the lamp |
| `capture` | Save exactly what you said as a structured note, verbatim |

Anything else is refused, out loud, with a reason — including "delete my files".

## The 90-second judge path

1. Open https://flowmesh-nohands.netlify.app/ — the badge reads **Browser edition · live**.
2. Type or dictate into the command box (a real `textarea`, so Wispr Flow can insert text there):

   > I finished the pricing call with Rohan. Open the project board and start a 25 minute research sprint. Notify my phone and set the desk lamp to 40 percent.

3. **Create plan** → the exact five actions, their surface, and the parameters appear.
4. **Approve & run** → the timer starts, the approved URL opens in a new tab, and every row returns a receipt: `verified`, `sent`, or `not_configured` with the reason nothing was attempted.
5. Every run writes a Markdown record (`Record generated in this page` in the browser, a real file on disk in the desktop app) so the plan, the receipts and the verbatim command survive the session.

The browser edition is not a simulation: the plan is real, the timer is real, the tab really opens, the record is really generated and downloaded. It cannot touch your filesystem, Notepad, Home Assistant or your phone — and it says so on every such row instead of faking a success.

If one dictated sentence holds two jobs — *"capture the release link, and start a 20 minute research sprint"* — the plan says so out loud: **"Also heard in this sentence: Research sprint. Not part of this plan — dictate that as its own command."** Nothing is silently dropped, and nothing is silently added.

## Three runtimes, one source

`web/` is the only UI. `web/core.js` is a line-for-line port of `planner.py`, pinned by a shared golden file (`electron/test/fixtures/planner_golden.json`) that both sides are tested against — so a drift in either language fails CI.

| Capability | Browser edition (hosted) | Desktop — Electron (Win/macOS/Linux) | Desktop — Python (Windows) |
| --- | --- | --- | --- |
| Plan, review, approve, one-use enforcement | yes, in-page | yes, server-owned in the main process | yes, server-owned |
| Approved URL | new tab (opener severed) | default browser via the OS | default browser via the OS |
| Timer | in-page countdown | in-process timer, receipt on schedule | server-side timer, receipt on schedule |
| Run record | generated + downloaded | written to `~/FlowMesh/runs/` with SHA-256 | written to `~/FlowMesh/runs/` with SHA-256 |
| Settings persistence | no | yes (`settings.json`, secrets encrypted with the OS keystore) | yes (`settings.json`, secrets in the OS credential store) |
| Notepad / Calculator | marked `desktop_only` | launched from a per-OS allowlist | launched from a Windows allowlist |
| Phone notification (Home Assistant Companion) | `not_configured` | `sent` only when configured; never called "verified" | `sent` only when configured; never called "verified" |
| Lamp brightness | `not_configured` | `verified` **only** after a state read-back matches | `verified` **only** after a state read-back matches |
| Jev Choice routing | local rules, labelled as such | Jev when a key is configured, labelled as such | Jev when a key is configured, labelled as such |

Nothing is shared between the browser page and the desktop runtimes except the planner and the UI: the hosted page has no server, no storage, and no access to your machine. The two desktop runtimes share the same loopback contract (same paths, same status codes, same receipt vocabulary) and the same `settings.json`, so a judge can move between them without relearning anything.

## Install

**Electron app (Windows, macOS, Linux)**

1. Download the artifact for your OS from [releases](https://github.com/HamzaShaikh-source/flowmesh/releases): `FlowMesh-1.3.0-win-x64.exe` (portable — double-click it), `FlowMesh-1.3.0-mac-arm64.dmg` (Apple silicon), or `FlowMesh-1.3.0-linux-x86_64.AppImage`.
2. Run it. No installer, no admin, no Node install required.
3. Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn: *More info → Run anyway* on Windows, *right-click → Open* on macOS.
4. The app opens its own window on `127.0.0.1` with a per-launch session token in the URL.

**Python app (Windows)**

1. Download `FlowMesh-Windows.zip` from [releases](https://github.com/HamzaShaikh-source/flowmesh/releases).
2. Unzip anywhere (no installer, no admin).
3. Run `FlowMesh.exe`. Windows may show a SmartScreen prompt for an unsigned build — *More info → Run anyway*.

## Run from source (any OS)

```bash
# Electron desktop app (cross-platform)
npm install
npm start                     # real window
npx electron . --server-only  # headless bridge, prints one URL with its token

# Python desktop app
python desktop.py            # native window if pywebview is installed
python desktop.py --browser  # plain browser tab, zero GUI dependencies
python desktop.py --headless --port 8765   # server only, prints one URL with its token
```

The Python runtime is stdlib only; `pywebview` and `keyring` are optional. The Electron runtime needs Node 20+ for development only — the shipped binary bundles everything. Full details in [docs/JUDGE-QUICKSTART.md](docs/JUDGE-QUICKSTART.md) and [docs/ELECTRON.md](docs/ELECTRON.md).

## How Wispr Flow is used here

Wispr Flow is a separate dictation product; FlowMesh contains no speech engine and claims none. The honest split:

- **In the build** — requirements, follow-ups and bug reports for this rewrite were spoken through Wispr Flow into the coding tools, which is what the challenge asks for.
- **In the product** — FlowMesh's input is an ordinary text field. Whatever puts text there — Wispr Flow, another dictation tool, or a keyboard — produces the same plan. The command box is deliberately a plain `textarea` so dictation lands where the cursor is.
- **Evidence** — `docs/SUBMISSION.md` lists exactly which claims are engineering facts verified by tests, and which are personal evidence the author must supply (Insights card, video). Nothing in this repo pretends to be a screenshot or a time-saving number.

## No-hands control

The desktop build installs two global hotkeys and a tray icon, so you can work without
reaching for the mouse:

- **Pull my last dictation** — the first accelerator that is free among
  `Ctrl+Shift+Space`, `Ctrl+Alt+Space`, `Ctrl+Shift+D`, `Alt+Shift+V`.
- **Approve the plan on screen** — first free among `Ctrl+Shift+Return`,
  `Ctrl+Alt+Return`, `Ctrl+Shift+A`.

A global shortcut can only belong to one program, so collisions are normal and the app
takes the first free candidate rather than failing silently. Whatever registered is what
the tray and the page display — the UI never advertises a key that is listening to
nothing. Two distinct gestures, never one, so an accidental double-tap cannot run
anything: the plan has to be on screen before approval does something.

The tray keeps the app resident with no window open, with `Pull last dictation`,
`Approve pending plan`, `Show FlowMesh`, and `Quit`.

## Security model (short version)

The browser UI, and every other local process, is treated as untrusted.

- Bound to `127.0.0.1`; `/api/*` requires the per-launch token; cross-origin `POST` rejected (`403`).
- Origin/Host checks; JSON-only bodies; no raw action payloads — the client may only reference a plan ID (`400` otherwise).
- Plans are server-owned, single-use, expiring; replay returns `409`.
- Actions come from a fixed registry. Model output can select a routine and clamp its parameters; it can never emit a command, a path, a purchase, or a credential read.
- Secrets live in the OS credential store (or a `0600` file) and are never returned by the API — only `connected: true/false`.
- A `sent` receipt means "handed to the OS/HTTP client". It is never upgraded to `verified` without a read-back or a file hash.

Full detail: [docs/SECURITY.md](docs/SECURITY.md).

## Tests and what has actually been run

```bash
python -m unittest discover -s tests -v   # 57 tests: planner, HTTP contract, adapters, artifacts, parity
npm test                                  # 18 tests: Electron runtime + planner golden
node --check web/core.js && node --check web/ui.js
```

Verified on this machine, 20 October 2026 — see [docs/VERIFICATION.md](docs/VERIFICATION.md) for the dated log with exact commands and results, including what is *not* verified (no Home Assistant hardware, no Jev key, no physical phone proof).

## Repository layout

```
planner.py            deterministic plans (Python, authoritative)
web/core.js           exact port of planner.py (browser edition)
web/index.html        product page + live console
web/ui.js             plan → approve → receipts, both runtimes
bridge.py             local runtime: token, plans, execution, run records
flowmesh_config.py    settings + OS credential store
desktop.py            launcher: window / browser / headless
tests/                planner, HTTP/security, adapters, artifacts, parity
docs/                 decision record, quickstart, architecture, security, electron, verification, Wispr connector, demo script, submission kit
dist/                 legacy v1.0 product page, kept only because the old ChatGPT-hosted site deploys from it
```

## Status and limits

- Windows is the only packaged desktop build. The runtime is cross-platform and tested on macOS/Linux in CI, but only Windows ships a binary.
- Home Assistant and Jev are implemented adapters; both are `not_configured` until you add your own URL, token and entity. No hardware was available to the author, so those paths are covered by fixtures, not by a physical device.
- FlowMesh does not control a phone beyond a Home Assistant Companion notification, and does not claim arbitrary appliance control.
- Not a medical, financial or accessibility-certified tool.

MIT licensed. No telemetry, no accounts, no network calls except the URLs and services you configure.
