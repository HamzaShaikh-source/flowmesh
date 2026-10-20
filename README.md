# FlowMesh

**Say the work. See it happen.**

FlowMesh turns one dictated sentence into a bounded, line-by-line plan you approve once — then performs the actions you allowed, and shows an honest receipt for each one.

Built for **No Hands: The Wispr Challenge** (WeMakeDevs × Wispr Flow), Builders track, by Hamza Shaikh.

- **Try it in the browser — no install:** https://flowmesh-nohands.netlify.app/
- **Windows app (unzip, run `FlowMesh.exe`):** https://github.com/HamzaShaikh-source/flowmesh/releases
- **Source:** this repository. Stdlib-only runtime, no build step for the UI.

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

## Two runtimes, one source

`web/` is the only UI. `web/core.js` is a line-for-line port of `planner.py`, and `tests/test_parity.py` fails CI if the two ever disagree.

| Capability | Browser edition (hosted) | Desktop edition (Windows / macOS / Linux) |
| --- | --- | --- |
| Plan, review, approve, one-use enforcement | yes, in-page | yes, server-owned |
| Approved URL | new tab (opener severed) | default browser via the OS |
| Timer | in-page countdown | server-side timer, receipt on schedule |
| Run record | generated + downloaded | written to `~/FlowMesh/runs/` with SHA-256 |
| Settings persistence | no | yes (`settings.json`, secrets in the OS credential store) |
| Notepad / Calculator | marked `desktop_only` | launched, allowlisted |
| Phone notification (Home Assistant Companion) | `not_configured` | `sent` only when the service is configured; never called "verified" |
| Lamp brightness | `not_configured` | `verified` **only** after a state read-back matches |
| Jev Choice routing | local rules, labelled as such | Jev when a key is configured, labelled as such |

Nothing is shared between the two except the planner: the hosted page has no server, no storage, and no access to your machine.

## Install (Windows)

1. Download `FlowMesh-Windows.zip` from [releases](https://github.com/HamzaShaikh-source/flowmesh/releases).
2. Unzip anywhere (no installer, no admin).
3. Run `FlowMesh.exe`. Windows may show a SmartScreen prompt for an unsigned build — *More info → Run anyway*.
4. The app opens its own window on `127.0.0.1` with a per-launch session token in the URL.

## Run from source (any OS)

```bash
python desktop.py            # native window if pywebview is installed
python desktop.py --browser  # plain browser tab, zero GUI dependencies
python desktop.py --headless --port 8765   # server only, prints one URL with its token
```

Stdlib only. `pywebview` and `keyring` are optional; without them you get a browser tab and a `0600` secrets file instead of the OS credential store. Full details in [docs/JUDGE-QUICKSTART.md](docs/JUDGE-QUICKSTART.md).

## How Wispr Flow is used here

Wispr Flow is a separate dictation product; FlowMesh contains no speech engine and claims none. The honest split:

- **In the build** — requirements, follow-ups and bug reports for this rewrite were spoken through Wispr Flow into the coding tools, which is what the challenge asks for.
- **In the product** — FlowMesh's input is an ordinary text field. Whatever puts text there — Wispr Flow, another dictation tool, or a keyboard — produces the same plan. The command box is deliberately a plain `textarea` so dictation lands where the cursor is.
- **Evidence** — `docs/SUBMISSION.md` lists exactly which claims are engineering facts verified by tests, and which are personal evidence the author must supply (Insights card, video). Nothing in this repo pretends to be a screenshot or a time-saving number.

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
python -m unittest discover -s tests -v   # 54 tests: planner, HTTP contract, adapters, artifacts, parity
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
docs/                 decision record, quickstart, architecture, security, verification, submission kit
dist/                 legacy v1.0 product page, kept only because the old ChatGPT-hosted site deploys from it
```

## Status and limits

- Windows is the only packaged desktop build. The runtime is cross-platform and tested on macOS/Linux in CI, but only Windows ships a binary.
- Home Assistant and Jev are implemented adapters; both are `not_configured` until you add your own URL, token and entity. No hardware was available to the author, so those paths are covered by fixtures, not by a physical device.
- FlowMesh does not control a phone beyond a Home Assistant Companion notification, and does not claim arbitrary appliance control.
- Not a medical, financial or accessibility-certified tool.

MIT licensed. No telemetry, no accounts, no network calls except the URLs and services you configure.
