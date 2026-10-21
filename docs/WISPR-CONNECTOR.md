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

FlowMesh reads the second, because the product needs *the sentence you just spoke, which app
it went into, and how old it is*. A Scratchpad note is a different artifact — it is what you
deliberately saved, not what you said a minute ago. Two other entries in this challenge read
Scratchpad through the supported MCP; this connector does not, and that is a fair thing to
hold against the design rather than a detail to hide.

If the MCP surface would serve your case better, the honest description of this project is:
broader data, less sanctioned path.

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