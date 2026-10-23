# Coding agents

FlowMesh can hand a coding task to the agent CLI you already use: **Claude Code, Codex (ChatGPT),
Antigravity, OpenCode, Gemini CLI or Aider**. You say or type the task, FlowMesh shows the exact
command, folder and risk, you approve once, and the agent runs on your computer with your own
sign-in. This page says precisely what that does and does not mean.

Desktop runtimes only (Electron and Python). The hosted page cannot start a program, so its Code
page only explains this.

## Signing in with your own account

FlowMesh **does not log you in to anything and never sees an account token.** Each agent keeps its
own credentials, exactly as when you run it in a terminal:

| Agent | Account it uses | How FlowMesh helps you sign in |
| --- | --- | --- |
| Claude Code (`claude`) | Anthropic account (Claude subscription or API) | **Sign in with your account** opens `claude auth login` in a real terminal |
| Codex (`codex`) | ChatGPT account or API key | opens `codex login` in a real terminal |
| Antigravity (`agy`) | Google account | opens `agy` once so you can follow its sign-in |
| OpenCode (`opencode`) | any provider you configure in it | opens `opencode auth login` |
| Gemini CLI (`gemini`) | Google account or API key | opens `gemini` once so you can follow its sign-in |
| Aider (`aider`) | API keys in your environment | nothing to open; it reads `OPENAI_API_KEY` and friends |

The **Agents** card then shows what the CLI itself reports (`installed`, version, and for Claude
Code and Codex whether it says it is signed in and with which plan). For the others FlowMesh says
that sign-in cannot be checked from here instead of guessing.

Why not "log in with ChatGPT / Google inside FlowMesh"? Those sign-ins belong to each vendor's CLI.
Proxying a subscription login through a third-party app would mean holding your account token, and
FlowMesh deliberately does not. If you prefer API-key billing, set the keys in your environment as
the vendor documents; the agents inherit your environment.

## How a task runs

1. **Add a project folder** (Code page, or the API). An agent can only ever work inside a folder
   you registered. Drive roots, your home folder itself and system folders are refused, and the
   path is resolved to its real location (symlinks followed) both when you plan and again when it
   runs. Adding one needs an explicit acknowledgement.
2. **Write the task** on the Code page, or say *"ask Codex to fix the failing test"* (also
   *tell / have / get / let* + `claude`, `claude code`, `codex`, `chatgpt codex`, `antigravity`,
   `agy`, `opencode`, `gemini`, `aider`). A spoken sentence can name only the agent and the task.
   The folder and mode come from your saved defaults and are shown in the plan.
3. **Pick a mode.** Risk comes from the mode, chosen by FlowMesh, never by a model:

   | Mode | Risk | What the agent is told |
   | --- | --- | --- |
   | Plan / read-only | `read` | analyse the project, change nothing |
   | Edit | `write` | edit inside the project folder (the agent's own sandbox or permission mode) |
   | Full access | `danger` | the agent's own checks are bypassed; needs the second confirmation |

   OpenCode cannot be restricted in headless mode, so every OpenCode task is `danger`.
4. **Review the plan.** It lists the agent, mode, folder, the exact command line and the full task
   text. It is never auto-run, even when read-only. A `danger` plan needs a second, deliberate
   confirmation.
5. **Approve.** The agent starts. The Flow page shows its output live with a **Stop the agent**
   button that stops the whole process tree.
6. **Receipt.** See below. A run record (Markdown, SHA-256) is saved like any other plan.

## What the receipt does and does not say

| Status | Meaning |
| --- | --- |
| `returned` | the agent exited with code 0. **FlowMesh did not check the work.** It also reports what git saw change |
| `failed` | non-zero exit, or you stopped it; files may be partly changed, and it says what git saw |
| `unknown` | it hit the time limit (default 20 min, max 60) and was stopped; it may have changed files |
| `denied` / `unavailable` | the folder changed since planning, the CLI is gone, or too many runs are going (3 at once) |

A coding task is **never `verified`.** When the folder is a git repository FlowMesh snapshots
`git status` and `HEAD` before and after and reports exactly that difference (changed files and
new commits). It observes; it does not judge. Files written by *other* tools during the run (for
example hooks in your own agent setup) show up too, and the receipt does not claim the agent made
them. Outside git it says it could not observe anything.

## Rules the code enforces

- **The task never reaches a shell or an option parser.** It goes to the agent's standard input,
  or a private temp file, wherever the CLI supports that. Where a CLI only takes it as an argument
  (Antigravity), a task that starts with a dash is refused, and `.cmd`/`.bat` shims on Windows
  refuse any argument containing `& | < > ^ % !` or a quote, because `cmd.exe` would re-read them.
  There is no `shell=True` and no `exec`/`eval` anywhere.
- **No FlowMesh secrets reach the agent.** The child inherits your environment (that is how agents
  authenticate) minus anything starting with `FLOWMESH_` or `TYPESAFE_`, plus `NO_COLOR=1`.
- **Output is untrusted text.** Terminal escapes and control characters are stripped, it is capped
  (200 000 characters buffered, 20 000 in the record), and the page renders it with `textContent`.
  A tool or model asking you to run something because of that output is just text.
- **One run, one approval.** The plan is server-owned and single-use (300 s). The client can only
  send a plan id; it can never amend the command, folder, mode or task at execute time.
- **Bounded.** At most 3 concurrent runs, a timeout on each, and cancel kills the whole tree.
- **Switch it off.** `FLOWMESH_AGENTS=off` disables the feature: every agent `POST` answers `403` and the Code page says it is off.

## What a same-user process could do

FlowMesh protects the approval gate from the web page and from other origins. It does not defend
against malware already running as you: such a process can read the per-launch token the same way
it could read your files, plan a task and approve it. That is true of every local tool that holds a
loopback token; the answer is the normal one (do not run untrusted code as yourself). The danger
modes exist so that the worst case needs a second gesture.

## HTTP routes (loopback, token required)

| Route | Purpose |
| --- | --- |
| `GET /api/agents` | catalog (labels, modes, risk), your folders and defaults, cached detection |
| `POST /api/agents/refresh` | re-detect installed CLIs and sign-in state (runs in the background) |
| `POST /api/agents/workspaces` / `.../remove` | add (needs `acknowledged: true`) or remove a project folder |
| `POST /api/agents/defaults` | default agent, folder and mode used by spoken tasks |
| `POST /api/agents/plan` | `{agent, workspace, mode, prompt}` and nothing else, returns an ordinary plan |
| `POST /api/agents/signin` | open that agent's own login in a terminal (a fixed command per agent) |
| `GET /api/agents/runs/<id>` | live status and output tail of a run |
| `POST /api/agents/runs/<id>/cancel` | stop it |

## Verification, honestly

- Automated: 34 Python tests for the module (command building, folders, environment, sanitising,
  split multibyte output, timeout, cancel with a child process tree, concurrency, git observation,
  detection and login), 15 tests through the real Python HTTP bridge, 15 more through the Electron
  runtime, and a parity suite that fails if the Python
  and Electron catalogs, phrase grammar, command building, routes or environment policy drift.
  They run against a mock agent CLI, not a real model.
- Live, on the author's Windows machine (23 October 2026): all six CLIs were detected; Claude Code
  and Codex reported themselves signed in (via claude.ai and ChatGPT). A read-only **Codex** task
  went through the real HTTP path: the task arrived on stdin, the run used `-s read-only`, git
  saw 0 changes, the receipt was `returned`. In that run Codex could not start PowerShell inside
  its Windows sandbox ("setup refresh had errors"), so it never answered the question; that is
  exactly why `returned` is not `verified`. A read-only **Claude Code** task started and ended
  `failed` with Claude's own message, "OAuth session expired and could not be refreshed" (the
  headless process could not refresh the login; `claude auth login` fixes it).
- **Not verified:** a task that actually edits files with a real model, and any real run of
  Antigravity, OpenCode, Gemini CLI or Aider. Their command lines follow each CLI's documented
  headless flags and are covered by unit tests, but have not been run against the real programs.
  If a vendor changes a flag, the catalog in `agents.py` is the one place to fix (then run
  `python scripts/export_agents_catalog.py` to refresh the Electron copy).

## Teaming up: several agents in one plan

On the Code page, **Team up** (or `POST /api/agents/relay`) puts two to four agents in one plan:

| Pattern | Steps |
| --- | --- |
| `review` | agent 1 works (edit or full access), agent 2 reviews read-only |
| `chain` | agent 1 plans read-only, agent 2 builds, agent 3 reviews read-only |
| `compare` | every agent answers the same task read-only, one after the other; nothing is handed over |

Each step is an ordinary coding task, validated like a single one, and the plan shows all of them with
their exact commands. The rules that matter:

- **Risk is the highest step's.** Full access in any step needs the second confirmation. A plan is
  never auto-run.
- **Review and planning steps are read-only by construction.** An agent with no read-only mode in
  headless mode (OpenCode) cannot take those steps; FlowMesh refuses the plan and says why.
- **A later step sees the earlier output as quoted, untrusted data.** It is wrapped in a header telling
  the agent to treat it as data, bounded to 4 000 characters, and sits inside the normal 8 000 character
  task limit. This is mitigation, not a guarantee: an agent that obeys text inside quoted output could
  still be misled, which is why the working step is never fed by a model-written tool call and the
  whole relay is approved up front.
- **A step starts only if the one before it `returned`.** After a failure, cancel or timeout the rest
  are `denied` with "Skipped" and never run.
- Each step has its own receipt, run id and live output; **Stop** stops the running one and the rest are skipped.

Not verified with real models: the relays are tested end to end against the mock agent, in both runtimes.
