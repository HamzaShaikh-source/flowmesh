'use strict';
/**
 * The coding agents FlowMesh can drive. GENERATED from agents.py by
 * scripts/export_agents_catalog.py; do not edit by hand (tests/test_agents_parity.py
 * fails when this file is stale).
 */

const CATALOG = [
  {
    "id": "claude",
    "label": "Claude Code",
    "command": "claude",
    "base_args": [],
    "docs": "https://docs.claude.com/en/docs/claude-code/overview",
    "version_args": [
      "--version"
    ],
    "prompt_via": "stdin",
    "status_args": [
      "auth",
      "status"
    ],
    "signed_in": "\"loggedIn\"\\s*:\\s*true",
    "signed_out": "\"loggedIn\"\\s*:\\s*false",
    "method": "\"authMethod\"\\s*:\\s*\"([A-Za-z0-9_. -]{1,30})\"",
    "login_args": [
      "auth",
      "login"
    ],
    "login_note": "Opens your Anthropic sign-in. FlowMesh never sees the account.",
    "modes": [
      {
        "id": "plan",
        "label": "Plan only",
        "risk": "read",
        "args": [
          "-p",
          "--permission-mode",
          "plan"
        ],
        "about": "Reads the project and proposes changes. Edits nothing."
      },
      {
        "id": "edit",
        "label": "Edit files",
        "risk": "write",
        "args": [
          "-p",
          "--permission-mode",
          "acceptEdits"
        ],
        "about": "May edit files in the project folder. Shell commands are not allowed in headless mode."
      },
      {
        "id": "full",
        "label": "Full access",
        "risk": "danger",
        "args": [
          "-p",
          "--permission-mode",
          "bypassPermissions"
        ],
        "about": "Skips every permission check: can edit anything and run any command."
      }
    ]
  },
  {
    "id": "codex",
    "label": "Codex (ChatGPT)",
    "command": "codex",
    "base_args": [
      "exec"
    ],
    "docs": "https://developers.openai.com/codex/cli",
    "version_args": [
      "--version"
    ],
    "prompt_via": "stdin",
    "status_args": [
      "login",
      "status"
    ],
    "signed_in": "Logged in",
    "signed_out": "Not logged in|not logged in",
    "method": "Logged in using ([A-Za-z0-9 ]{1,30})",
    "login_args": [
      "login"
    ],
    "login_note": "Opens the ChatGPT sign-in. FlowMesh never sees the account.",
    "modes": [
      {
        "id": "plan",
        "label": "Read-only",
        "risk": "read",
        "args": [
          "-s",
          "read-only",
          "--skip-git-repo-check",
          "-C",
          "{dir}",
          "-"
        ],
        "about": "Sandboxed read-only: analyses the project, changes nothing."
      },
      {
        "id": "edit",
        "label": "Edit in the project",
        "risk": "write",
        "args": [
          "-s",
          "workspace-write",
          "-C",
          "{dir}",
          "-"
        ],
        "about": "Sandbox allows writes inside the project folder only."
      },
      {
        "id": "full",
        "label": "Full access",
        "risk": "danger",
        "args": [
          "--dangerously-bypass-approvals-and-sandbox",
          "-C",
          "{dir}",
          "-"
        ],
        "about": "No sandbox and no approvals."
      }
    ]
  },
  {
    "id": "agy",
    "label": "Antigravity",
    "command": "agy",
    "base_args": [],
    "docs": "https://antigravity.google",
    "version_args": [
      "--version"
    ],
    "prompt_via": "arg",
    "status_args": null,
    "signed_in": null,
    "signed_out": null,
    "method": null,
    "login_args": [],
    "login_note": "Run agy once in a terminal and follow its Google sign-in.",
    "modes": [
      {
        "id": "plan",
        "label": "Plan only",
        "risk": "read",
        "args": [
          "-p",
          "{prompt}",
          "--mode",
          "plan"
        ],
        "about": "Plans without editing."
      },
      {
        "id": "edit",
        "label": "Edit files",
        "risk": "write",
        "args": [
          "-p",
          "{prompt}",
          "--mode",
          "accept-edits"
        ],
        "about": "Auto-accepts file edits."
      },
      {
        "id": "full",
        "label": "Auto (full access)",
        "risk": "danger",
        "args": [
          "-p",
          "{prompt}",
          "--mode",
          "auto"
        ],
        "about": "The agent decides everything, including running commands."
      }
    ]
  },
  {
    "id": "opencode",
    "label": "OpenCode",
    "command": "opencode",
    "base_args": [],
    "docs": "https://opencode.ai/docs",
    "version_args": [
      "--version"
    ],
    "prompt_via": "stdin",
    "status_args": [
      "auth",
      "list"
    ],
    "signed_in": "(?i)\\b(api|oauth|credential)",
    "signed_out": "(?i)0 credentials",
    "method": null,
    "login_args": [
      "auth",
      "login"
    ],
    "login_note": "Opens OpenCode's provider sign-in. FlowMesh never sees the account.",
    "modes": [
      {
        "id": "edit",
        "label": "Run (its own permissions apply)",
        "risk": "danger",
        "args": [
          "run",
          "--dir",
          "{dir}"
        ],
        "about": "FlowMesh cannot restrict OpenCode in headless mode, so this always needs the second confirmation."
      }
    ]
  },
  {
    "id": "gemini",
    "label": "Gemini CLI",
    "command": "gemini",
    "base_args": [],
    "docs": "https://github.com/google-gemini/gemini-cli",
    "version_args": [
      "--version"
    ],
    "prompt_via": "stdin",
    "status_args": null,
    "signed_in": null,
    "signed_out": null,
    "method": null,
    "login_args": [],
    "login_note": "Run gemini once in a terminal and follow its Google sign-in.",
    "modes": [
      {
        "id": "plan",
        "label": "Plan only",
        "risk": "read",
        "args": [
          "-p",
          "Follow the instructions given on stdin.",
          "--approval-mode",
          "plan"
        ],
        "about": "Read-only."
      },
      {
        "id": "edit",
        "label": "Edit files",
        "risk": "write",
        "args": [
          "-p",
          "Follow the instructions given on stdin.",
          "--approval-mode",
          "auto_edit"
        ],
        "about": "Auto-approves edit tools."
      },
      {
        "id": "full",
        "label": "Full access (yolo)",
        "risk": "danger",
        "args": [
          "-p",
          "Follow the instructions given on stdin.",
          "--approval-mode",
          "yolo"
        ],
        "about": "Auto-approves every tool."
      }
    ]
  },
  {
    "id": "aider",
    "label": "Aider",
    "command": "aider",
    "base_args": [],
    "docs": "https://aider.chat/docs",
    "version_args": [
      "--version"
    ],
    "prompt_via": "file",
    "status_args": null,
    "signed_in": null,
    "signed_out": null,
    "method": null,
    "login_args": [],
    "login_note": "Aider uses API keys from your environment (for example OPENAI_API_KEY).",
    "modes": [
      {
        "id": "plan",
        "label": "Dry run",
        "risk": "read",
        "args": [
          "--message-file",
          "{promptfile}",
          "--dry-run",
          "--yes-always",
          "--no-pretty",
          "--no-stream"
        ],
        "about": "Shows what it would change without editing."
      },
      {
        "id": "edit",
        "label": "Edit and commit",
        "risk": "write",
        "args": [
          "--message-file",
          "{promptfile}",
          "--yes-always",
          "--no-pretty",
          "--no-stream"
        ],
        "about": "Edits files and commits to git."
      }
    ]
  }
];

const ALIASES = {
  "claude code": "claude",
  "claude": "claude",
  "codex": "codex",
  "chatgpt codex": "codex",
  "chatgpt": "codex",
  "antigravity": "agy",
  "agy": "agy",
  "opencode": "opencode",
  "open code": "opencode",
  "gemini": "gemini",
  "gemini cli": "gemini",
  "aider": "aider"
};

module.exports = { CATALOG, ALIASES };
