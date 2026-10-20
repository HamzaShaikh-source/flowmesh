# Security

FlowMesh can open programs and talk to your home automation. It is designed so that a hostile sentence, a hostile web page, or a hostile local process cannot turn that into arbitrary code execution.

## Trust boundaries

| Component | Trust |
| --- | --- |
| `planner.py` / `web/core.js` | trusted code, untrusted **input** (your dictation can be adversarial by accident) |
| browser UI | untrusted — it is a client, and in a browser it is a page that could be cross-origin |
| any other local process | untrusted |
| Home Assistant | authenticated remote service; responses are data, never instructions |
| Jev Choice | optional, untrusted model output used **only** to pick a registered route and numbers |

## Controls in the local runtime

- **Loopback only.** The HTTP server binds `127.0.0.1` on an ephemeral port.
- **Host allowlist.** `Host`/`Origin` must match the bound address; anything else gets `403 Invalid host`.
- **Per-launch session token.** Generated at startup, printed only in the launch URL, required on every `/api/*` call. The page strips it from the address bar after load (`history.replaceState`), so it does not leak via a shared screenshot or a copied URL.
- **Cross-origin writes denied.** `POST` with a foreign `Origin` → `403`. There is no CORS allowance.
- **JSON-only bodies, size-capped**, malformed JSON → `400`.
- **No raw action payloads.** The client may only send a plan identifier. A body that tries to describe actions directly → `400 Invalid plan`. The server never executes anything the client composed.
- **Single-use, expiring plans.** 300-second lifetime, consumed on first execute, unknown/expired/replayed → `409`. Plans live in memory, so a restart invalidates everything.
- **Fixed action registry.** `open_url` only accepts the configured `board_url` / `docs_url`; `launch_app` only accepts `notepad` / `calculator`; `timer` only schedules; `write_note` only writes into the artifact directory; `notify` and `light` only call the configured Home Assistant service with a fixed payload shape.
- **Deny list before planning.** Destructive, payment, credential and physical-safety vocabulary (`delete`, `purchase`, `password`, `oven`, `door`, …) returns `422` with a reason and no plan.
- **Artifact writes are contained.** Names are generated (`flowmesh-<timestamp>-<route>-<id>.md`), never taken from input; writes are atomic (`.tmp` → `replace`); the byte count and SHA-256 are returned so the file can be verified independently.
- **Secrets never cross the API.** `public_settings()` returns `jev_connected` / `ha_token_connected` booleans and a backend name only. Secret values come from the OS credential store (Windows Credential Manager / macOS Keychain / Secret Service) or a `0600` fallback file, and are read at call time.
- **URLs are validated.** `board_url`, `docs_url`, `ha_url` must be `http(s)`, must have a host, and must not carry embedded credentials. `light_entity` must look like `light.…`; `phone_service` must look like `mobile_app_…` — so a typo cannot become a call to an arbitrary HA service.
- **No shell, ever.** No `subprocess` with a string, no `shell=True`, no path from user input.

## Controls in the browser edition

There is no server, so the controls are about honesty and blast radius rather than privilege:

- The page has no filesystem, process, or device access. Every such row is `desktop_only` or `not_configured`.
- Approved URLs open with `window.open(url, '_blank')` and `opener` is severed immediately, so the opened page cannot script the console.
- The run record is generated in-page and offered as a download; nothing is uploaded.
- Deployed with a strict CSP (`default-src 'self'`, no inline script, no third-party requests), `noindex`, and `no-store` caching so a judge never sees a stale build. See `web/_headers`.

## Receipt integrity

`sent` means "handed to the OS or an HTTP client". It is never promoted to `verified` without an observation: a spawned process, a scheduled timer, a file hash, or a Home Assistant state read-back that equals the requested brightness. This is enforced in the adapters, and `tests/test_actions.py` asserts that an unconfigured integration can never produce a success-looking status.

## Known limits (stated, not hidden)

- The desktop bridge is protected by a loopback bind plus a token, not by OS-level IPC permissions: another process running **as the same user** that reads the token from the launch URL could drive it. It cannot do more than a human at the keyboard could, since the action set is fixed.
- The Windows build is unsigned, so SmartScreen may warn on first run.
- Home Assistant over plain `http://` on your LAN is allowed if you configure it; use `https://` or a local-only host if you care about that hop.
- There is no multi-user model: one machine, one user, no accounts, no remote access.

## Reporting

Open an issue at https://github.com/HamzaShaikh-source/flowmesh/issues. Please do not include tokens, URLs with credentials, or Home Assistant long-lived access tokens.
