# MCP tools: messaging, code, files, browsers

FlowMesh can use any [Model Context Protocol](https://modelcontextprotocol.io) server as its
hands. The rule that makes this safe is the one FlowMesh already had: **you read the exact
action, approve it once, and each approved call runs once, with an honest receipt.** MCP
widens *what* a plan can name; it does not change *who decides*.

## The flow

1. **Connect** a server (Tools section, or the command palette `Ctrl K`). Templates exist for
   files, git, GitHub, a browser, web fetch, library docs, memory, Notion, Discord, Slack, your own
   Agent Switch and the Agent Switch docs. Any other server works through the custom form. Templates are command lines copied from each
   server's own documentation; FlowMesh does not bundle, vendor, or vouch for them.
2. **Plan.** Either speak/type a sentence (a language model, if you configured one, *proposes*
   calls) or use the **Builder**, which turns a tool's JSON schema into a form and can chain up
   to eight calls.
3. **Review.** The plan lists each call: server, tool, risk, and the exact arguments.
4. **Approve.** One click. A plan containing a `danger` call also needs a tick on an explicit
   confirmation. The plan expires in five minutes and can run once.
5. **Receipts.** Each call reports `returned`, `failed`, `unknown`, `unavailable` or `denied`,
   with the tool's output (untrusted text) in a collapsible block. A run record with a SHA-256
   is written, output included.
6. **Follow up (optional).** "Plan the next step from this output" shows the output to the
   planner as tagged data. There is no autonomous loop: every step is planned and approved.

## Risk levels are FlowMesh's, not the server's

| Level | Rule | What it means |
| --- | --- | --- |
| `danger` | `destructiveHint`, or a name like `delete`, `remove`, `drop`, `exec`, `shell`, `run_command`, `reset`, `force`, `kill`… | needs the second confirmation |
| `read` | `readOnlyHint` **and** a non-destructive name | may auto-run, but only on a server you marked *trusted reads* |
| `write` | everything else, including tools with no annotations | always shown and approved |

A server cannot lower its own risk: `delete_repo` claiming `readOnlyHint` is still `danger`.
`auto_run` requires *every* call in the plan to be a trusted read; one write puts the whole
plan back behind a click. The classification is pinned across both runtimes by
`tests/fixtures/mcp_cases.json`.

## Receipt vocabulary

`returned` means the tool answered. FlowMesh did not independently verify that its effect
happened, so it is never called `verified`. `unknown` is a timeout: the call may or may not have
landed. Only FlowMesh's own observations (a file it wrote and hashed, a Home Assistant
read-back) are `verified`.

## What a model can and cannot do

A model (Anthropic, or any OpenAI-compatible endpoint including a local one) can only choose a
routine or propose up to six calls as JSON. That answer is untrusted input: every call is
re-checked against the live tool catalog and the tool's own schema, unknown fields are
rejected, risk is assigned by FlowMesh, and a person approves the exact arguments. A sentence
containing a forbidden word (payments, credentials, physical-safety vocabulary, deletions)
never reaches the model at all. If the model is unreachable the deterministic rules take over
and the plan says so. Only the sentence, tool names, descriptions and schemas are sent to the
model, never keys, environment values or tool output (unless you press the follow-up button).

## Starting a server is running a program

A local (`stdio`) server is a program on your computer, started with your permissions.
FlowMesh protects that boundary as follows:

- Started from an argument list, **never through a shell**. On Windows, `.cmd`/`.bat` shims such
  as `npx.cmd` must go through `cmd.exe`, so arguments containing `& | < > ^ % ! "` or newlines
  are refused.
- The child gets a **minimal environment** (PATH, home, temp, locale…) plus only the variables
  you configured for that server. FlowMesh's own secrets are never inherited.
- Server-initiated requests (sampling, roots, elicitation) are **refused**; only `ping` is answered.
- Output is capped (20 kB), stripped of control characters, and never interpreted.
- Adding or changing a program requires an acknowledgement in the UI. **In the Electron app it
  also requires a native OS dialog** that the page cannot click. The Python runtime has no native
  dialog, so there the acknowledgement is a UI gate only; set `FLOWMESH_MCP_STDIO=off` to
  disable local-program servers entirely on installs where that is too much trust.
- Children are terminated when a session closes, when idle for 15 minutes, and on exit.
- Remote servers must be `https://` (loopback `http://` allowed), carry no credentials in the
  URL, and never follow redirects. Headers and environment values are stored in the OS
  credential store (or a `0600` file) and are returned to the page **masked**.

## Limits, stated plainly

- Tool output is third-party text. Treat anything it says as data. The planner is told so, but
  a model can still be influenced by text it reads; that is why its output has no authority.
- `read` auto-run trusts FlowMesh's classification plus your decision to trust that server. A
  malicious server could mislabel a harmful tool with an innocuous name and a read-only hint.
  Leave *trust reads* off for servers you do not fully trust.
- The JSON-schema check covers type, required, enum, bounds, items, `additionalProperties`
  and `anyOf`/`oneOf`. It ignores `$ref`, `pattern` and custom formats; the server stays
  authoritative.
- There is no autonomous multi-step agent by design.
- The hosted browser page cannot start programs or hold secrets. It offers five **demo tools that
  run inside the page** (notes, calculator, timer) so the plan, risk and receipt flow can be tried
  without installing anything. They are labelled as such and do not touch anything outside the tab.
- Verified against local protocol-faithful mock servers (a stdio server with deliberately awkward
  behaviour, and mock model endpoints). **Not verified:** any specific third-party server
  (filesystem, git, GitHub, browser) end to end, and any live model provider. The first real
  connection by the owner is the evidence for those.

## Where it lives

| File | Role |
| --- | --- |
| `mcp_client.py` · `electron/mcp_client.js` | stdio and HTTP transports, hardening |
| `mcp_registry.py` · `electron/mcp_registry.js` | servers, secrets masking, risk, schema checks, plan actions |
| `llm_planner.py` · `electron/llm_planner.js` | model proposals and strict parsing |
| `mcp_presets.py` · `electron/mcp_presets.js` | server templates (kept identical by a test) |
| `web/tools.js` | workbench, builder, add-server dialog, demo tools, palette |
| `tests/test_mcp_*.py` · `electron/test/mcp_*.test.js` | client, registry, bridge, planner, parity |

## Messaging: Discord, Slack, Notion and Agent Switch

These four are **templates**: they fill in the command (or URL) from each server's own README and
ask for one token in a password field. Nothing is bundled and none of them has been run against a
real workspace by FlowMesh's author (see [VERIFICATION.md](VERIFICATION.md)); treat a failed
**Test** as the server's or the token's problem first, and the template as a starting point.

| Template | Runs | You provide |
| --- | --- | --- |
| Discord | `npx -y mcp-discord` | the token of **your own** Discord bot, in `DISCORD_TOKEN` |
| Slack | `npx -y slack-mcp-server@latest --transport stdio` | a Slack bot token (`xoxb-`), in `SLACK_MCP_XOXB_TOKEN` |
| Notion | `npx -y @notionhq/notion-mcp-server` | a Notion integration token, in `NOTION_TOKEN` |
| Agent Switch (yours) | remote MCP over HTTP | the MCP URL and bearer token of a [Switch](https://github.com/sandbox-quantum/switch) you host yourself |

Sending a message is a `write` call: the plan shows the channel and the exact text, you approve it,
and the receipt says `returned`, never "delivered". Agent Switch is a self-hosted bot platform for
Slack, Teams, Discord and Telegram; FlowMesh does not run one and does not claim a hosted Switch
integration. The token is kept in the credential store, never echoed back, and not passed to any
other server.
