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
| language model planner | optional, untrusted: may only *propose* a routine or tool calls, every one re-validated and approved by a person |
| MCP servers and their output | third-party programs/services; output is untrusted text, shown and never interpreted |

## Controls in the local runtime

- **Loopback only.** The HTTP server binds `127.0.0.1` on an ephemeral port.
- **Host allowlist.** `Host`/`Origin` must match the bound address; anything else gets `403 Invalid host`.
- **Per-launch session token.** Generated at startup, printed only in the launch URL, required on every `/api/*` call. The page strips it from the address bar after load (`history.replaceState`), so it does not leak via a shared screenshot or a copied URL.
- **Cross-origin writes denied.** `POST` with a foreign `Origin` → `403`. There is no CORS allowance.
- **JSON-only bodies, size-capped**, malformed JSON → `400`.
- **No raw action payloads.** The client may only send a plan identifier. A body that tries to describe actions directly → `400 Invalid plan`. The server never executes anything the client composed.
- **Single-use, expiring plans.** 300-second lifetime, consumed on first execute, unknown/expired/replayed → `409`. Plans live in memory, so a restart invalidates everything.
- **Fixed routine registry.** The built-in routines are fixed; MCP tool calls are the only open-ended action and have their own controls (see "MCP tools" below). `open_url` only accepts the configured `board_url` / `docs_url`; `launch_app` only accepts `notepad` / `calculator`; `timer` only schedules; `write_note` only writes into the artifact directory; `notify` and `light` only call the configured Home Assistant service with a fixed payload shape.
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

## Controls specific to the Electron build

The Electron app reuses the same loopback contract and the same safety rules; what changes is the host. The renderer is treated as a hostile page even though FlowMesh authored it:

- **No Node in the renderer.** `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and a preload that exposes nothing but `platform` and `version` — no filesystem, no `ipcRenderer`, no shell.
- **No privileged IPC that can act.** Every action goes through the same token-authenticated HTTP endpoints, validated in the main process. There is no `ipcMain.handle('run-something')` that a compromised renderer could call.
- **Navigation is pinned.** The window only loads the loopback origin; every other navigation and every `window.open` is intercepted and handed to the OS browser instead, so a redirected page cannot inherit the app frame.
- **Secrets encrypted at rest.** On Windows/macOS/Linux the two secrets are sealed with Electron's `safeStorage` (DPAPI / Keychain / libsecret) and stored as ciphertext; if the OS keystore is unavailable the app falls back to a `0600` file in the user profile, and says so in Settings.
- **Same allowlists, same refusals.** `open_url` still only opens the configured board/docs URL, launcher targets come from a per-OS fixed list (`notepad`/`calc` on Windows, `TextEdit`/`Calculator` on macOS, `gedit`/`gnome-calculator` on Linux), bodies are capped, plans are single-use and expire in 300 seconds.
- **Unsigned binaries.** The Windows `.exe`, macOS `.dmg` and Linux `.AppImage` are not code-signed or notarized; SmartScreen and Gatekeeper will warn. There is no auto-updater and no telemetry.

## MCP tools (added after the routines above)

Full detail in [MCP.md](MCP.md). The important changes to the threat model:

- **The action set is no longer fixed.** A registered MCP server can do whatever that server
  does, but only through a plan whose exact calls a person read and approved. Risk is derived by
  FlowMesh (a server cannot lower its own), `danger` calls need a second confirmation, and
  plans/execute carry only an id plus that confirmation, never arguments.
- **Starting a local server is running a program.** Started without a shell, with a minimal
  environment (FlowMesh's secrets are not inherited), server-initiated requests refused, output
  capped and sanitised, children killed on close/idle/exit, `cmd.exe` metacharacters refused for
  Windows shims. Adding or changing a program needs a UI acknowledgement; **Electron additionally
  asks through a native OS dialog the page cannot click.** `FLOWMESH_MCP_STDIO=off` disables
  local-program servers on any install.
- **Server credentials** (environment values, headers) are stored in the credential store or a
  `0600` file and returned to the page masked.
- **The model planner is not a trust boundary**: its JSON is validated like hostile input, and
  sentences with forbidden vocabulary never reach it.

## Voice (added in 1.5)

Full detail in [VOICE.md](VOICE.md). A spoken sentence is untrusted input: only a *whole utterance*
matching a short fixed grammar acts as a command, approval by voice is off by default and can never
approve a plan containing a `danger` call, and everything else becomes a normal plan that a person
approves. Live pickup reads Wispr's local history read-only through the existing connector. The
hosted page allows the microphone for itself only; the Electron app denies every permission except
audio capture for its own loopback page. The sign-in callback (`/oauth/wispr/callback`) is the one
route that needs no session token; it is guarded by an unguessable single-use `state`, answers under
a locked-down CSP, and its one-time code is redacted from the request log.

## Coding agents (added after 1.5)

Full detail in [AGENTS.md](AGENTS.md). Running a coding agent is the highest-impact thing FlowMesh
does, because the agent edits files and can run commands. The controls:

- **Sign-in stays with the vendor.** FlowMesh never sees, stores or proxies a Claude, ChatGPT/Codex
  or Google token. It only reads a fixed fact from each CLI's own status command and opens that CLI's
  own login in a real terminal.
- **Risk is the permission mode, chosen by FlowMesh.** Plan/read-only is `read`, edit is `write`, and
  every mode that bypasses the agent's own approvals (or that FlowMesh cannot restrict, as with
  OpenCode headless) is `danger` and needs the second confirmation. A coding plan is never auto-run.
- **Registered folders only**, resolved to their real path when planned and again when run; drive
  roots, the home folder itself and system folders are refused.
- **The task never reaches a shell or option parser**: standard input or a private temp file where the
  CLI allows, otherwise an argument that may not start with a dash; Windows `.cmd` shims refuse
  `& | < > ^ % !` and quotes.
- **Child environment** is yours minus `FLOWMESH_*` and `TYPESAFE_*`.
- **Output is untrusted**: escapes stripped, capped, rendered as text. Runs have a timeout, at most 3
  run at once, and cancel kills the process tree.
- **Receipts are observations, not judgements**: `returned` at best, plus what git saw change.
- `FLOWMESH_AGENTS=off` disables the feature.

A process running as the same user can read the loopback token and approve its own coding plan, as
with MCP tools (see Known limits). Coding agents raise the stakes of that, so the danger modes need a
second gesture and the feature can be switched off.

## Messaging templates

The Discord, Slack, Notion and Agent Switch entries on the Tools page are *templates* that fill in a
documented MCP server command. FlowMesh does not bundle, vendor or verify those servers. Their tokens
are entered in a password field, written into the credential store (or a `0600` file) and returned to
the page masked, like any other server credential. The Agent Switch template points at a Switch
instance **you** host; it is not a hosted integration.

## Receipt integrity

`returned` (an MCP tool answered) is likewise not `verified`, and a tool timeout is `unknown`. `sent` means "handed to the OS or an HTTP client". It is never promoted to `verified` without an observation: a spawned process, a scheduled timer, a file hash, or a Home Assistant state read-back that equals the requested brightness. This is enforced in the adapters, and `tests/test_actions.py` asserts that an unconfigured integration can never produce a success-looking status.

## Known limits (stated, not hidden)

- The desktop bridge is protected by a loopback bind plus a token, not by OS-level IPC permissions: another process running **as the same user** that reads the token from the launch URL could drive it. For the built-in routines that is no more than a human at the keyboard could do. **With coding agents configured it can also plan and approve a task for an installed agent inside a registered project folder.** **With MCP configured it can also call any tool on an already-registered server after producing a plan (it can approve its own plan, as the page can), and on the Python runtime it can register a new local program, since only the Electron app has a native confirmation.** Same-user local malware can do all of this without FlowMesh anyway, but it is a real change; set `FLOWMESH_MCP_STDIO=off` or do not register servers you do not want reachable.
- The Windows build is unsigned, so SmartScreen may warn on first run.
- Home Assistant over plain `http://` on your LAN is allowed if you configure it; use `https://` or a local-only host if you care about that hop.
- There is no multi-user model: one machine, one user, no accounts, no remote access.

## Reporting

Open an issue at https://github.com/HamzaShaikh-source/flowmesh/issues. Please do not include tokens, URLs with credentials, or Home Assistant long-lived access tokens.
