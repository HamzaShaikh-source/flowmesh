# Product decision — FlowMesh v1.1 (No Hands 2026)

Evidence gathered on 20 Oct 2026 from the official pages, the v1.0.0 checkout, the
published release, and a local test run.

## What the judges are actually asked

`wemakedevs.org/wispr/judges` lists four questions: does it solve a real problem in
your work, was Wispr used meaningfully, does it work ("a live link the judges can
open and use"), is the demo clear ("a two-minute video anyone can follow"). The
percentages beside them render as `0%` on the public page, so no weighting is
assumed here. The Builders track asks for a working product plus dictated
requirements into coding tools.

## The problem v1.0 did not solve

v1.0 is a competent local runtime, but a judge on macOS, Linux, or a phone cannot
open it at all, and the product's only durable output is a receipt list held in
process memory. Three concrete defects, all verified in the checkout:

1. **No live link.** The public site is a download page; the app is a Windows
   PyInstaller build. "Judges can open and use it" fails for most of the panel.
2. **Nothing persists.** Run receipts live in `EVENTS` in memory and vanish when
   the app closes. The user gets no artefact they can keep, paste, or attach.
3. **Trust boundary is thin.** Any local process can `POST /api/plan` then
   `POST /api/execute`; the Origin check only fires when a browser supplies an
   `Origin` header. There is no per-session credential.

Also verified: 19 tests pass, `node --check` passes, the v1.0.0 asset SHA-256
matches the documented value, and CI is Windows-only so nothing proves the other
platforms the product claims.

## Decision

Evolve FlowMesh, do not replace it. One product, two runtimes, one planner.

- **`web/`** is the only UI source. It is a static site that runs the planner and a
  real browser-executable subset with no install and no account. This is the
  judge's live link.
- **The local runtime** serves that same UI at `127.0.0.1` and adds what a browser
  cannot do: launching allowlisted apps, Home Assistant notifications and lights,
  and writing files.
- **The planner is duplicated deliberately** (Python + JS) and guarded by a parity
  test over shared fixtures, because there is no server to call in browser mode.
  Drift fails CI.

Migration: `dist/app.html` + `dist/app.js` are deleted; `dist/` stops being a
second copy of the UI. The Windows packaging step bundles `web/` instead. This is
the only structural change, and it removes a duplication that already existed
(the old site and the old app shell re-implemented the same story).

## The workflow we ship

**Meeting reset**, four surfaces, one approval:

> "I just finished the pricing call. Follow-up: send Rohan the revised quote
> tomorrow, and ask about the November demo. Open my board, notify my phone, and
> put the lamp at 70 percent."

Plan → open board (browser), start 70% lamp (Home Assistant, read back), notify
phone (Companion), save run record (Markdown with the exact words, the plan, and
every receipt). On the web the first and last steps really run; the two device
steps are labelled `desktop_only` and never reported as done.

**Quick capture** is the zero-setup path: dictate one thought, approve, get a
timestamped Markdown file. It is the first thing a judge can succeed at.

## Judge's first minute

1. Open the Netlify URL. The console is above the fold, not behind a signup.
2. Type or dictate a command (example chips fill it in).
3. Review the numbered plan with surface tags and the exact values.
4. Approve. Receipts appear one per action, with browser-real results; two rows
   are marked unavailable in the browser.
5. Download the run record — a real file with the command, plan, and receipts.

No claim is made that the browser can control a PC, phone, or lamp.

## Scope and non-goals

In scope: keyboard-and-voice input, bounded plans, explicit approval, one-use
execution, honest per-action receipts, a persisted run record, four routines
(focus, meeting, research, capture), Windows/macOS/Linux source runs, Windows
binary, browser edition, Jev routing when a key exists, Home Assistant adapters.

Out of scope and not advertised: cloud speech recognition, arbitrary phone or
appliance control, reading arbitrary files, shell execution, purchases, account
actions, user-supplied filesystem paths, multi-user accounts, telemetry.

## Architecture

```
dictation (Wispr Flow, separate app)
        │  inserts text into the focused field
        ▼
web/index.html + ui.js ──(browser mode)──► planner (core.js) ──► real subset:
        │                                                        open URLs, timer,
        │                                                        note download
        │  (desktop mode: http://127.0.0.1:<port>/?k=<token>)
        ▼
bridge.py ──► /api/plan ──► planner.py ──► plan (id, expires 300s, one use)
        │                                   └─ Jev Choice, allowlisted routes only
        └──► /api/execute (token + same-origin) ──► adapters ──► receipts
                                                   └─ run record .md on disk
```

## Security boundaries

- Bind `127.0.0.1` only; `Host` must be the loopback host and port.
- Per-launch random token required on every `/api/*` call; absent → 401.
- `Origin`, when present, must be the loopback origin; JSON content type required.
- Plans are server-owned, expire in 300 s, are consumed once, and carry no client
  action payload — `/api/execute` accepts only a plan id.
- Targets are fixed allowlists (two URLs, two apps, one timer, one light pattern,
  one notify service shape). No raw paths, URLs, commands, or shell.
- Denied vocabulary (delete/purchase/password/… ) never produces a plan.
- Secrets go to the OS credential store when available, with a `0600` file
  fallback on platforms without one, and are never returned by the API.
- Run records are written only under a fixed directory, never to a caller path.

## Acceptance tests (and how each is checked)

| Claim | Check |
| --- | --- |
| Planner is identical in both runtimes | `tests/test_parity.py` over shared fixtures |
| One-use, expiring, server-owned plans | unit + HTTP replay test (409) |
| Token gate on the bridge | HTTP test without/with token (401/200) |
| Cross-origin and raw payloads rejected | HTTP tests (403/400) |
| Run record is real | unit test reads the file and its SHA-256 |
| Browser edition performs the real subset | Playwright run against the served page |
| Desktop path still works after changes | packaged binary smoke test, real UI |
| Other platforms really are supported | CI matrix ubuntu/macos/windows |
| Release download is intact | re-download asset, compare SHA-256 |

## Risks

- Cross-platform app launching is best-effort by design; it reports `unavailable`
  rather than pretending. Only Windows is live-tested here; Linux/macOS adapters
  are covered by contract tests, and the docs say exactly that.
- Home Assistant, Jev, and Wispr evidence require the owner's accounts and
  hardware. The submission materials separate verified engineering from
  owner-supplied evidence, and no numbers are invented.
