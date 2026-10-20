# Architecture

One planner, one UI, two runtimes. The point of the split is that the thing a judge can open in a browser is the same product logic as the thing that can actually drive a Windows machine — not a mock of it.

```
                 ┌───────────────────────────────┐
                 │  web/index.html + web/ui.js   │  same file, both modes
                 └───────────────┬───────────────┘
        GET /api/status → 404    │    GET /api/status → 200
                 ┌───────────────┴───────────────┐
                 │                               │
   browser edition (hosted, static)      desktop edition (local)
   web/core.js  ← port of planner.py     bridge.py  (127.0.0.1, token)
   Blob download of the record           ~/FlowMesh/runs/*.md + SHA-256
   window.open, in-page timer            OS browser, server timer, Notepad,
                                         Home Assistant, credential store
```

## Planner (authoritative)

`planner.py` is deterministic and dependency-free: text in, bounded plan out.

- **Route** — keyword rules for `focus`, `meeting`, `research`, `capture`; optionally Jev Choice when a key is configured, and the plan records which one was used (`via local rules` / `via Jev`).
- **Parameters** — minutes are clamped to 1–180, brightness to 1–100; nonsense is ignored rather than guessed.
- **Actions** — drawn from a fixed registry (`ACTION_LIB`) with a `kind`, a target and a surface. There is no free-form command field anywhere in the plan or the API.
- **Refusal** — destructive or unregistered intent returns `route: refuse` with a spoken reason, before any plan exists.

`web/core.js` is a line-for-line port. `tests/parity.js` prints the JS planner's output for every fixture in `tests/fixtures/planner_cases.json`; `tests/test_parity.py` compares it to Python's. Drift fails CI on all three operating systems, in both directions.

## Review, approval, single use

- In desktop edition the plan lives in server memory with a 5-minute expiry and a one-use ID. The client only ever sends `{"plan": "<id>"}` to `/api/execute`.
- In browser edition there is no server, so the plan object lives in the page; the one-use rule is enforced by the same state machine and the record is generated client-side.
- Approval is a distinct, explicit click (`Approve & run`), reachable from the keyboard (`Ctrl/Cmd+Shift+Enter`) and cancellable (`Esc`).

## Execution

Each action maps to one adapter, and each adapter returns a receipt rather than throwing:

| Receipt | Meaning |
| --- | --- |
| `verified` | Observed: process spawned, timer scheduled server-side, file hash matches, Home Assistant state read back and equal |
| `sent` | Handed off, not observed: browser open requested, HTTP notify accepted |
| `not_configured` | No credentials/device — nothing was attempted |
| `desktop_only` | Real in the desktop edition, impossible in a web page |
| `failed` | Tried and did not work; error text is shown |
| `denied` | Blocked by policy before execution |

`performed` never upgrades `sent` to `verified`. That is a product rule, not a nicety: a browser opening a URL cannot be confirmed from inside the app, so it is not claimed.

## Run records

Every completed run produces Markdown containing the approved plan, the receipt table, and the command verbatim, plus platform and route provenance. In desktop edition it is written atomically (`.tmp` then `replace`) to `~/FlowMesh/runs/`, and the receipt carries byte count and SHA-256 so the file can be checked independently. In browser edition the same Markdown is generated in-page and offered as a download — it is never uploaded anywhere.

## Configuration and secrets

`flowmesh_config.py` keeps non-secret settings in `settings.json` under the platform config dir, and secrets in the OS credential store when `keyring` is available (Windows Credential Manager, macOS Keychain, Secret Service), else a `0600` JSON file. `public_settings()` exposes only `jev_connected` / `ha_token_connected` booleans and the backend name — never a secret value, over any route.

## What deliberately does not exist

- No shell, no arbitrary path, no file deletion, no purchase, no account action, no credential read.
- No remote control surface. The bridge binds to `127.0.0.1` and requires a per-launch token.
- No microphone, no speech model, no claim to contain Wispr Flow.
- No telemetry and no server-side storage.

## Failure behaviour

Killed mid-run, the page reports the failure and the plan is spent. A stale plan ID returns `409`. A missing integration is `not_configured` on that row and does not stop the others — a run is allowed to be partially real, as long as every row says which part.
