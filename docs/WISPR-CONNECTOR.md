# Wispr Flow connector

FlowMesh reads your own Wispr Flow history, read-only, so a dictation can become a
plan without you retyping it.

## Two integration surfaces, and why this one

Wispr Flow exposes two different things, and they are **not interchangeable**:

- **A supported MCP server** at `https://api.wisprflow.ai/connect/mcp`, with OAuth
  (`https://mcp-auth.wisprflow.com`, scopes `openid offline_access`) and tools including
  `search_scratchpad_notes` and `get_scratchpad_note`. It exposes **Scratchpad notes** —
  text you saved into Wispr's own notes — not the dictation log. Verified 21 Oct 2026: the
  discovery document at `/.well-known/oauth-protected-resource` returns `200`, and the MCP
  endpoint returns `401` without a bearer token.
- **The local database**, which holds the **dictation log**: each transcript, the app it
  landed in, latency, the dictionary. No supported interface exists for this one.

FlowMesh now uses **both**, for different jobs:

- **The local database** answers *the sentence you just spoke, which app it went into, and how
  old it is*. Broader data, unsupported path.
- **The supported MCP** answers *what you deliberately saved* — a Scratchpad note — over OAuth
  on Wispr's own sign-in page. Narrower data, vendor-sanctioned path. This is the integration
  two other entries in the challenge already had; the earlier version of this project did not,
  and said so. See [Wispr account](#wispr-account-the-supported-route) below.

## Where the database lives

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\Wispr Flow\flow.sqlite` |
| macOS | `~/Library/Application Support/Wispr Flow/flow.sqlite` |
| Override | `FLOWMESH_WISPR_DB` (authoritative: if set, nothing else is consulted) |

The override is deliberately authoritative. Falling back to a *different* database
when the named one is missing would silently read the wrong data, so a missing
override reports `not_found` instead.

## The four rules this reader follows

1. **Read-only, by URI.** `file:...?mode=ro` — proven to refuse writes
   (`attempt to write a readonly database`).
2. **Not `immutable=1`.** The tempting flag for read-only open ignores the
   `-wal` sidecar, and the live database keeps recent dictations only there. Measured
   on a real install: `?mode=ro` returned 8 rows, `?immutable=1` returned 7. The
   difference is a dictation that silently never appears.
3. **Explicit columns, never `SELECT *`.** The History table has 63 columns,
   including `audio`, `screenshot`, `axText` and `axHTML`. FlowMesh reads a fixed
   allow-list and never loads those four.
4. **Short-lived connections.** Opened, read, closed; read-only, so it cannot block
   the app the user is actively dictating into.

## Endpoints

All require the per-launch session token and are served only on the loopback bridge.

| Endpoint | Answers |
| --- | --- |
| `GET /api/wispr` | connection state, counts, latency, dictionary size — **metadata only, never transcript text** |
| `GET /api/wispr/latest` | the newest usable dictation within the freshness window, plus provenance |
| `GET /api/wispr/dictionary` | how many personal words/snippets exist, as counts and lengths |
| `POST /api/type` | types one dictation into the focused window, by id |

### Freshness

Only a dictation from the last **300 seconds** can be acted on. Without that window,
a hotkey pressed in the afternoon would happily plan the sentence you dictated at
breakfast. Stale input reports `state: none`, and the UI says
"No recent dictation found to act on."

### One id, no text

`POST /api/type` takes `{transcript_id}` and nothing else. The text is re-read from
the database inside the runtime, so a page cannot supply the characters that reach
the keyboard. A dictation is actioned once: a second attempt reports
"That dictation has already been typed".

## Dictionary words

Reading your custom vocabulary is treated as private. The endpoint reports how many
entries exist and how long they are — never the words themselves, because those are
usually names, addresses and email signatures.

## What is deliberately not verified

Typing into a focused window is unproven on the Windows build machine: it runs as a
detached session with no interactive window station, so no window can receive
keystrokes. The mechanism imports and runs; delivery is labelled `sent`, not
`verified`, in the receipt and in `docs/VERIFICATION.md`. Confirm it yourself by
running the desktop build and pressing **Type into my window**.

## Wispr account: the supported route

`wispr_account.py` (Python runtime) and `electron/wispr_account.js` (Electron runtime) sign
in to Wispr through its published OAuth server and read Scratchpad notes through its
published MCP server. Both implement the same contract and are pinned together by
`tests/test_wispr_contract.py`.

### Flow

1. **Discovery.** `GET https://api.wisprflow.ai/.well-known/oauth-protected-resource`, then
   the issuer's `/.well-known/oauth-authorization-server`. The resource and issuer must match
   what was asked for, and every endpoint must be on the issuer's own host over HTTPS.
2. **Registration.** A public client (`token_endpoint_auth_method: none`, no secret anywhere
   in the shipped app), registered once and remembered.
3. **Device sign-in (RFC 8628).** FlowMesh shows a short code and a link; you approve on
   Wispr's page. FlowMesh never sees a password and listens on no redirect port. It polls at
   the server's interval and backs off on `slow_down`.
4. **Refresh.** Only the refresh token and client id are stored (OS credential store or a
   `0600` file, the same policy as other secrets); access tokens live in memory. A rotated
   refresh token replaces the old one; a revoked grant reports `expired` and is dropped.
5. **Notes.** One short MCP session per request over streamable HTTP (`2025-06-18`), JSON or
   SSE. Only `search_scratchpad_notes` and `get_scratchpad_note` are ever called; any tool
   whose name mentions dictation, history or transcript is refused by name even if offered.

### Endpoints (both runtimes; all need the session token)

| Endpoint | Answers |
| --- | --- |
| `GET /api/wispr/account` | `disconnected` / `pending` (with the code to show) / `connected` |
| `POST /api/wispr/account/connect` | starts sign-in; returns the user code and link, never the device code |
| `POST /api/wispr/account/poll` | advances sign-in; respects the server interval |
| `POST /api/wispr/account/disconnect` | forgets tokens on this machine (Wispr keeps its own record of the grant) |
| `GET /api/wispr/account/notes` | titles and dates only |
| `POST /api/wispr/account/note` | `{note_id}` and nothing else; returns that note's text, capped at 4000 characters |

Connector failures are `502`/`409`/`403`/`429`/`422`, never `401`, which in this API only
ever means a bad FlowMesh session token.

### Wispr's text is untrusted

A note is just text someone (possibly a pasted web page) put in a notes app. It is stripped
of control characters, length-capped, written into the command box with `textContent`, and
labelled as coming from Wispr. It is **never planned or executed on its own**: it goes through
the same deterministic planner and the same one-approval, one-use gate as typed text, so a
note cannot do more than a registered routine, and only after you read the plan.

### What was verified, and what was not (22 Oct 2026)

| Claim | Evidence |
| --- | --- |
| Discovery, registration and device authorization work against Wispr's **real** servers | Ran `WisprAccount().begin()` from this repository against `api.wisprflow.ai` and `mcp-auth.wisprflow.com` with an isolated config: it returned a real user code and `https://mcp-auth.wisprflow.com/device` link. Nothing was approved; the code expired unused. |
| The full protocol (pending → connected, rotation, revocation, SSE, hostile metadata, tool allow-list, no token in any response) | 21 Python tests (`tests/test_wispr_account.py`, plus two new route/allow-list parity checks) and 15 Node tests (`electron/test/wispr_account.test.js`) against a protocol-faithful loopback mock |
| The UI journey connect → code → connected → notes → plan | Driven in a browser against the real bridge pointed at the mock |
| **Token exchange after a human approves, and the real tool responses** | **Not verified.** It needs the owner's Wispr login. Tool argument and response shapes follow another public project's usage of the same server and are filtered through each tool's own `inputSchema`; if Wispr's shape differs, expect a clear `bad_response`/`unsupported` message, not a silent empty list. |

The first person to click **Connect Wispr account** with a real login closes that last gap —
record the result in `docs/VERIFICATION.md`.
