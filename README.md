# FlowMesh

**Say the work. Approve the plan. Keep the receipt.**

FlowMesh turns one spoken or typed sentence into a plan you read and approve once. Then it does exactly
what the plan said (open things, start timers, call any [MCP](https://modelcontextprotocol.io) tool, hand
a coding task to your own coding agent) and shows an honest receipt for every step. It is built around
[Wispr Flow](https://wisprflow.ai): hold your Wispr key, talk, and FlowMesh picks the sentence up and plans it.

Built for **No Hands: The Wispr Challenge** (WeMakeDevs × Wispr Flow), Builders track, by Hamza Shaikh.

- **Try it in the browser, no install:** https://flowmesh-nohands.netlify.app/
- **Desktop app:** https://github.com/HamzaShaikh-source/flowmesh/releases (Windows portable `.exe`,
  Apple-silicon `.dmg`, Linux `.AppImage`, plus a smaller Windows-only Python build). Coding agents, MCP
  servers and the Wispr connector need the desktop app; the hosted page cannot start a program.
- **Source:** this repository. Stdlib-only Python runtime, no build step for the UI.

## What you can do with it

| You say or type | What happens | Where |
| --- | --- | --- |
| "Start a 25 minute research sprint, open the board, notify my phone" | a fixed routine plans every step; you approve; each step returns a receipt | Flow |
| "Ask Codex to fix the failing test" | your installed coding agent works in a project folder you registered, in a mode you chose | Code |
| "Post the standup summary in #team" | an MCP tool call (Discord, Slack, Notion, files, git, GitHub, a browser, your own server) shown with its exact arguments | Tools |
| "Hey FlowMesh" (opt-in, Windows) | an offline wake word that can press your Wispr shortcut so dictation starts hands-free | Wispr |
| Hold your Wispr key anywhere in the app | the new dictation is picked up and planned automatically | every page |
| "Go to tools", "read it back", "cancel" | short whole-sentence voice commands act on the app itself | every page |

Nothing runs until you approve. A plan that can change or destroy things needs a second, deliberate
confirmation. Each approved plan runs once and expires in five minutes.

## The pages

Nine pages in Wispr Flow's own visual language (cream paper, ink type, EB Garamond over Figtree, lilac
and forest accents), with a voice dock on every page and a command palette on `Ctrl K`.

| Page | What it is |
| --- | --- |
| **Home** | stats, recent runs, how to start |
| **Flow** | say it → review the plan → receipts; live output while a coding agent works |
| **Tools** | connect MCP servers (templates for files, git, GitHub, browser, Discord, Slack, Notion, Agent Switch), browse their tools, build and chain calls |
| **Guide** | how to talk to FlowMesh: three steps, every phrase it understands (click one to try it), the page pilot, desktop features and a what-if list |
| **Code** | your coding agents, their sign-in state, your project folders, and a task composer |
| **Wispr** | history reader, optional Wispr account connection, Scratchpad notes, dictionary |
| **History** | every run record, with its SHA-256 |
| **Settings** | Home Assistant, a Jev key, the language model used for planning |
| **Proof** | "Measured, never estimated": test counts, CI, the eval, release checksums, all generated from real runs by `scripts/build_proof.py`, a list of what is **not** yet measured, and what runs where |

## Coding agents: Claude Code, Codex, Antigravity, OpenCode, Gemini CLI, Aider

FlowMesh drives the agent CLI you already have. Details, limits and what is not verified:
[docs/AGENTS.md](docs/AGENTS.md).

1. **Sign in with your own account, in the vendor's own CLI.** The Code page shows each agent as
   installed or not, its version and (for Claude Code and Codex) what the CLI says about being signed
   in. **Sign in with your account** opens that CLI's own login (`claude auth login`, `codex login`,
   …) in a real terminal. FlowMesh never sees or stores a Claude, ChatGPT or Google token, and does not
   proxy anyone's subscription. This is deliberate: it keeps your account yours.
2. **Register a project folder.** An agent can only work inside a folder you added (not a drive root,
   your home folder or a system folder).
3. **Choose how much it may do:**

   | Mode | Risk | Meaning |
   | --- | --- | --- |
   | Plan / read-only | `read` | studies the project, changes nothing |
   | Edit | `write` | edits files inside the project folder |
   | Full access | `danger` | the agent's own checks are bypassed; needs the second confirmation |

4. **Approve the plan.** It shows the agent, folder, the exact command and the full task text. The
   agent runs; its output streams on the Flow page with a **Stop** button that kills the whole process tree.
5. **Read the receipt.** A coding task is `returned` at best, never `verified`: FlowMesh did not check
   the work. For a git repository it also reports exactly which files and commits git saw change.

**Councils.** *Debate*: agents propose approaches, critique each other anonymously, answer the critique and vote (never for their own). *Judge panel*: agents score your project folder blind on a fixed rubric, with the median taken and caps from measured facts (no tests, a committed secret, no README) that cannot be argued past. Both are read-only, one approved plan, and report the agents' opinion without checking it ([details](docs/AGENTS.md#councils-debate-and-a-blind-judge-panel)); ported from my earlier K.O.D.E. project.

**Team up.** Put two to four agents in one plan: one works and another reviews it read-only, plan then build then review, or several answer the same task read-only to compare. Risk is the highest step's, a step runs only if the one before it finished cleanly, and the earlier output reaches the next agent as quoted, untrusted data ([details](docs/AGENTS.md#teaming-up-several-agents-in-one-plan)).

You can also say it: *"ask Codex to fix the failing test"* works with `claude`, `claude code`, `codex`,
`chatgpt codex`, `antigravity`, `agy`, `opencode`, `gemini` and `aider`. The sentence supplies the agent and
the task only; the folder and mode come from your saved defaults and appear in the plan.

## Messaging and everything else: MCP, including Discord and Switch

Any MCP server is a set of hands for FlowMesh (details: [docs/MCP.md](docs/MCP.md)). Every call is shown
with its server, tool, exact arguments and a risk level FlowMesh derives itself (a server cannot lower its
own); you approve once and each call runs once.

Templates on the Tools page fill in the command from each server's own docs and take your token in a
password field: **Discord** (your own bot), **Slack**, **Notion**, **Agent Switch** (a
[Switch](https://github.com/sandbox-quantum/switch) you host, so its AI teammates in Slack, Teams, Discord
and Telegram can be reached), plus files, git, GitHub, a real browser, web fetch, library docs and memory.
These are templates, not endorsements: FlowMesh does not bundle those servers, and the four messaging
ones have not been run against a real workspace by the author. An optional language model can turn one
sentence into a validated tool plan; it only proposes, and every call is re-checked.

## Wispr Flow, inside the app

- **Live pickup.** On the desktop app new dictations are read from Wispr's local history (read-only,
  a fixed allow-list of columns, never audio or screenshots) and planned automatically.
- **Wake word.** Opt-in "Hey FlowMesh", detected offline by the speech recogniser built into Windows (no cloud, nothing transcribed), with a visible badge while your microphone is open. Optionally it presses your own Wispr shortcut. Accuracy with a real voice and a real Wispr shortcut is **not verified yet**: [docs/WAKE.md](docs/WAKE.md).
- **A voice harness for the website.** On the hosted page a capture field in the dock keeps focus, so whatever Wispr types there is acted on: go anywhere, create the plan, try an example, open and copy the latest run, use a demo tool and fill its fields ("set expression to 12 times 3"), scroll, open the palette. It is the same safe grammar: whole sentences only, every action presses the same button a person would, nothing can switch approval-by-voice on. Say "what can I say". [docs/VOICE.md](docs/VOICE.md)
- **A page pilot.** Zoom ("zoom to 150 percent"), volume, screenshots, "scroll to the receipts section", back, full screen and any command-palette action by voice, from a small rule-based agent with no model. On the desktop app (Windows) volume moves the real system volume and a screenshot saves a PNG of the window; on the hosted page volume is FlowMesh's own voice and a screenshot uses your browser's tab capture. It cannot approve, delete or disconnect anything. [docs/VOICE.md](docs/VOICE.md)
- **Watch it.** The hosted Home page carries a 65 s recording of the live page being driven by typed, voice-style commands (labelled as typed, not Wispr audio), regenerated by `node scripts/record_demo.js`.
- **Voice commands.** Only a *whole utterance* that matches a short fixed grammar ("go to tools",
  "cancel", "read it back", "approve" if you turn that on) acts on the app; anything else is an ordinary
  sentence that becomes a plan. Approval by voice is off by default and can never approve a `danger` plan.
  Plans can be read back aloud. See [docs/VOICE.md](docs/VOICE.md).
- **Account connector.** Optionally connect your Wispr account (OAuth with PKCE, loopback callback) and
  load Scratchpad notes into the command box as untrusted text. Discovery, registration and the redirect
  to Wispr's real login page were verified against Wispr's live servers; the step after a human signs in is
  **not** yet verified. See [docs/WISPR-CONNECTOR.md](docs/WISPR-CONNECTOR.md).
- **What FlowMesh is not.** It contains no speech engine. Its input is an ordinary text field, so any
  dictation tool or a keyboard produces the same plan. Evidence that Wispr was used to build it (Insights,
  video) is the author's to supply: [docs/SUBMISSION.md](docs/SUBMISSION.md).

## The 90-second judge path

1. Open https://flowmesh-nohands.netlify.app/ (the badge reads **Browser edition · live**).
2. On **Flow**, type or dictate into the command box:

   > I finished the pricing call with Rohan. Open the project board and start a 25 minute research sprint. Notify my phone and set the desk lamp to 40 percent.

3. **Create plan** shows the exact actions and parameters. **Approve & run** starts the timer, opens the
   approved URL and returns a receipt per row: `verified`, `sent`, or `not_configured` with the reason.
4. Every run writes a Markdown record (generated in the page in the browser, a real file with a SHA-256 on
   the desktop). The hosted page cannot touch your machine, Home Assistant or phone, and says so on each such
   row instead of faking a success. On **Tools** it ships five in-page demo tools so you can try the MCP
   flow without installing anything.

If one sentence holds two jobs, the plan says so: *"Also heard in this sentence: Research sprint. Not part
of this plan; dictate that as its own command."* Nothing is silently dropped or added.

## Receipts mean something

| Status | Meaning |
| --- | --- |
| `verified` | confirmed by a read-back, or by a file FlowMesh wrote and hashed |
| `returned` | a tool or agent answered; FlowMesh did not verify its effect |
| `sent` | handed to the OS or an HTTP client |
| `unknown` | no answer in time: it may or may not have happened |
| `not_configured` / `unavailable` / `denied` / `failed` | nothing was attempted, or it failed, and the reason is stated |

## Three runtimes, one source

`web/` is the only UI. `web/core.js` is a line-for-line port of `planner.py`, pinned by a shared golden file,
and the Electron runtime mirrors the Python bridge route for route; parity tests fail CI if either drifts.

| Capability | Browser (hosted) | Desktop: Electron | Desktop: Python (Windows) |
| --- | --- | --- | --- |
| Plan, review, approve, one-use enforcement | in-page | server-owned | server-owned |
| Routines, timer, run record with SHA-256 | in-page, downloaded | yes | yes |
| MCP servers (stdio and HTTP) | five in-page demo tools | yes | yes |
| Coding agents | explained only | yes | yes |
| Wispr history reader, live pickup, account connector | recording only | yes | yes |
| Native confirmation before a local program is registered | n/a | yes (OS dialog) | acknowledgement in the page |
| Credentials | none | encrypted with the OS keystore | OS credential store or `0600` file |
| Phone notification, lamp | `not_configured` | via Home Assistant, lamp `verified` only after read-back | same |

## Install

**Electron app (Windows, macOS, Linux).** Download the artifact for your OS from
[releases](https://github.com/HamzaShaikh-source/flowmesh/releases) (`FlowMesh-<version>-win-x64.exe` is
portable; run it). No installer, admin rights or Node needed. Builds are unsigned, so SmartScreen
(*More info → Run anyway*) or Gatekeeper (*right-click → Open*) will warn.

**Python app (Windows).** Download `FlowMesh-Windows.zip`, unzip, run `FlowMesh.exe`.

## Run from source

```bash
# Electron desktop app (cross-platform)
npm install
npm start                     # real window
npx electron . --server-only  # headless bridge, prints one URL with its token

# Python desktop app
python desktop.py             # native window if pywebview is installed
python desktop.py --browser   # plain browser tab, zero GUI dependencies
python bridge.py --port 8765  # server only, prints one URL with its token
```

The Python runtime is stdlib only (`pywebview` and `keyring` are optional). Electron needs Node 20+ for
development only. More: [docs/JUDGE-QUICKSTART.md](docs/JUDGE-QUICKSTART.md), [docs/ELECTRON.md](docs/ELECTRON.md).

## No-hands control

The desktop build registers two global hotkeys and a tray icon. **Pull my last dictation** takes the first
free of `Ctrl+Shift+Space`, `Ctrl+Alt+Space`, `Ctrl+Shift+D`, `Alt+Shift+V`; **Approve the plan on screen**
takes the first free of `Ctrl+Shift+Return`, `Ctrl+Alt+Return`, `Ctrl+Shift+A`. A shortcut can belong to only
one program, so the app takes the first free candidate and shows only what actually registered. Pulling and
approving are two separate gestures, so an accidental double-tap cannot run anything.

## Security model (short version)

The browser UI and every other local process are treated as untrusted. Full detail: [docs/SECURITY.md](docs/SECURITY.md).

- Bound to `127.0.0.1`; `/api/*` needs the per-launch token; cross-origin `POST` is rejected; JSON-only,
  size-capped bodies; the client sends only a plan id, never an action.
- Plans are server-owned, single-use and expiring; replay returns `409`.
- Built-in routines come from a fixed registry. MCP calls and coding tasks are the open-ended actions and
  each has its own controls: risk derived by FlowMesh, a second confirmation for `danger`, no shell,
  minimal child environment, sanitised and capped output, timeouts, cancel that kills the process tree.
- Coding agents: sign-in stays with the vendor, registered folders only (re-resolved at run time), the task
  goes to stdin or a private file rather than a shell, `FLOWMESH_*` secrets are stripped from the child,
  and `FLOWMESH_AGENTS=off` disables the feature. `FLOWMESH_MCP_STDIO=off` does the same for local MCP programs.
- Secrets live in the OS credential store (or a `0600` file) and the API only returns masked values.
- Known limit, stated: a process running as the same user can read the loopback token and approve its own
  plan. That is true of any local tool; the danger modes need a second gesture and both features can be switched off.

## Tests and what has actually been run

```bash
python -m unittest discover -s tests -v   # 337 tests: planner, HTTP contract, adapters, Wispr, MCP, model planner, coding agents, parity
npm test                                  # 190 tests: Electron runtime, planner golden, Wispr, MCP, coding agents, UI contract, voice grammar
```

[docs/VERIFICATION.md](docs/VERIFICATION.md) is the dated log with exact commands, including what is *not*
verified. [docs/EVAL.md](docs/EVAL.md) is the measured version of the claims, generated from the shipped code
with the failures left in. The coding-agent tests run against a mock CLI; a read-only Codex task and a
read-only Claude Code task were also run for real on the author's machine (the Codex one `returned`, the
Claude one failed honestly on an expired login), and nothing has yet verified a real edit by a real model.

## Repository layout

```
planner.py            deterministic routine plans (authoritative)      web/core.js     exact port for the browser
bridge.py             Python runtime: token, plans, execution, records electron/       Electron runtime and twins of every module
agents.py             coding agents: catalog, folders, runs, receipts  web/code.js     Code page
mcp_client.py         MCP stdio/HTTP client (hardened)                 web/tools.js    Tools page, builder, palette
mcp_registry.py       servers, risk levels, schema checks, tool plans  web/pages.js    router, Home, History
mcp_presets.py        server templates (Discord, Slack, Notion, ...)   web/voice.js    live Wispr pickup, voice, read-aloud
llm_planner.py        optional model proposes; never runs               web/ui.js       plan, approve, receipts
wispr_account.py      Wispr OAuth (PKCE) + Scratchpad over MCP         docs/           decision record, security, MCP, agents, voice, ...
flowmesh_config.py    settings + OS credential store                   tests/          Python tests (mock agent and MCP servers)
```

## Status and limits

- Windows, macOS and Linux Electron builds come from CI; the author runs Windows. They are unsigned.
- Home Assistant and Jev (a model router) are implemented but `not_configured` until you add your own
  credentials; the author had no hardware, so those paths are covered by fixtures.
- Coding agents: Antigravity, OpenCode, Gemini CLI and Aider command lines follow each CLI's documented
  headless flags but have not been run for real; if a vendor changes a flag, `agents.py` is the one place
  to fix (then `python scripts/export_agents_catalog.py`).
- The Discord, Slack, Notion and Agent Switch templates are starting points, not verified integrations.
- No telemetry, no accounts. The only network calls are to services you configure or connect.
- Not a medical, financial or accessibility-certified tool.

MIT licensed.
