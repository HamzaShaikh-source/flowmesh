# Submission kit — No Hands: The Wispr Challenge

Track: **Builders**. Deadline: **30 October 2026, 11:59 pm IST**.
This file separates three things that are easy to blur: what the code proves, what was run on this machine, and what only the author can supply.

## 1. The four required submission items

| # | Required | Status |
| --- | --- | --- |
| 1 | Link to the working project | `https://flowmesh-nohands.netlify.app/` (browser edition, no install) + source repo + Windows release |
| 2 | Demo video, ≤ 2 minutes | **Not recorded yet.** Shot list and timings in [VIDEO-SHOTLIST.md](VIDEO-SHOTLIST.md). Only the author can record it. |
| 3 | Genuine Wispr Insights usage card | **Not supplied here.** Must be the author's own screenshot from Wispr Flow. Nothing in this repo imitates or approximates it. |
| 4 | Short truthful explanation (problem, user, Wispr use) | Draft below — **edit the bracketed parts to your own words and facts before submitting.** |

## 2. Draft explanation (edit before submitting)

> **The problem.** [Describe the specific recurring moment in your own work — e.g. the ten minutes at the start of every focus block spent opening the board, starting a timer, silencing the phone and dimming the lamp, then losing the thread of what you actually meant to do.]
>
> **Who it is for.** [Yourself, and people with the same shape of work: developers and researchers who context-switch all day and already dictate rather than type.]
>
> **What it does.** One dictated sentence becomes a bounded plan — at most five actions, each with its surface and parameter — which you read once and approve once. Then it runs, once, and writes a receipt per action: `verified`, `sent`, `not_configured`, `desktop_only` or `failed`. Anything unregistered is refused before a plan exists.
>
> **How Wispr Flow was used in the build.** [Say what you actually did, with real examples: which requirements you dictated into which tool, which follow-ups you spoke, what broke and how you dictated the fix. Keep it specific and short.] The product side is deliberately plain: the command box is an ordinary textarea so dictation lands at the caret. FlowMesh contains no speech engine and claims none.
>
> **What is real.** The plan engine, the approval gate, the single-use enforcement, the timer, the run record and its hash, the refusals, and the HTTP/security contract are covered by 49 stdlib-only tests (CI on Ubuntu, macOS and Windows). The browser edition runs the same planner and really opens the tab, runs the timer and generates the record. Windows/macOS/Linux desktop runtime performs the OS actions.

## 3. What is verified by engineering (do not overstate beyond this)

- `python -m unittest discover -s tests -v` → **54 tests, OK** (planner, HTTP contract, security boundaries, adapters, artifacts, Python↔JS parity). Exact dated run in [VERIFICATION.md](VERIFICATION.md).
- Planner parity: the browser planner produces byte-identical plans to the Python planner for every fixture, enforced by `tests/test_parity.py`.
- Replay of a spent plan → `409`; cross-origin `POST` → `403`; malformed JSON → `400`; client-composed actions → `400`; destructive command → `422`.
- Run records written atomically with byte count + SHA-256; hash re-checked from disk in tests.
- Browser edition exercised end-to-end in a real Chromium via Playwright: plan → approve → receipts → downloaded Markdown record.
- Desktop edition exercised end-to-end: same flow against the local runtime, real OS file written, real tab opened, timer scheduled, `not_configured` reported honestly for Home Assistant.

## 4. What is explicitly NOT verified (say so if asked)

- Home Assistant phone notification and lamp brightness: adapter implemented and unit-tested against fixtures, **never run against real hardware** (no device or token available to the author). Rows report `not_configured`.
- Jev Choice routing: implemented, unit-tested with a stub, **no live key used**.
- No physical phone buzz and no lamp photograph exist, so none is claimed.
- The Windows binary is unsigned and was not virus-scanned by a third party.
- No time-saved metric is claimed anywhere; there is no measurement to support one.

## 5. Judging-facing links

- Live (no install): `https://flowmesh-nohands.netlify.app/`
- Source: `https://github.com/HamzaShaikh-source/flowmesh`
- Windows release: `https://github.com/HamzaShaikh-source/flowmesh/releases`
- Judge quick-start: [JUDGE-QUICKSTART.md](JUDGE-QUICKSTART.md)
- Architecture / security: [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md)
- Decision record (what changed from v1.0 and why): [DECISION.md](DECISION.md)

## 6. Before you press submit

1. Record the ≤2-minute video per the shot list; check the runtime is under 120 s.
2. Screenshot your own Wispr Insights card. Do not crop out the date range.
3. Replace every bracketed paragraph in section 2 with your own experience.
4. Open the live link in a private window (no cache) and complete one run.
5. Keep the submission claim inside section 3. Anything in section 4 stays labelled unverified.
