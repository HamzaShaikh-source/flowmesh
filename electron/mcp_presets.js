'use strict';
/**
 * One-click starting points for well-known MCP servers. Templates only: not endorsed,
 * bundled or verified by FlowMesh. Mirrors mcp_presets.py exactly (tests/test_mcp_parity.py
 * fails if they drift). See that file for the rules.
 */

const PRESETS = [
  {
    "id": "filesystem",
    "label": "Files",
    "group": "Code & files",
    "description": "Read, write and search files inside one folder you choose.",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "{path}"
    ],
    "inputs": [
      {
        "key": "path",
        "label": "Folder to allow",
        "placeholder": "C:\\Users\\you\\projects\\demo"
      }
    ],
    "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem"
  },
  {
    "id": "git",
    "label": "Git",
    "group": "Code & files",
    "description": "Inspect and operate on one git repository: status, diff, log, commit.",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "mcp-server-git",
      "--repository",
      "{path}"
    ],
    "inputs": [
      {
        "key": "path",
        "label": "Repository path",
        "placeholder": "C:\\Users\\you\\projects\\demo"
      }
    ],
    "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/git"
  },
  {
    "id": "github",
    "label": "GitHub",
    "group": "Code & files",
    "description": "Issues, pull requests, code search and repositories through GitHub's hosted MCP server.",
    "transport": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": {
      "Authorization": "Bearer {token}"
    },
    "inputs": [
      {
        "key": "token",
        "label": "GitHub personal access token",
        "placeholder": "github_pat_…",
        "secret": true
      }
    ],
    "docs": "https://github.com/github/github-mcp-server"
  },
  {
    "id": "playwright",
    "label": "Browser",
    "group": "Web",
    "description": "Drive a real browser: open pages, click, fill forms, read the page.",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "@playwright/mcp@latest"
    ],
    "inputs": [],
    "docs": "https://github.com/microsoft/playwright-mcp"
  },
  {
    "id": "fetch",
    "label": "Web fetch",
    "group": "Web",
    "description": "Fetch a web page and return it as readable text.",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "mcp-server-fetch"
    ],
    "inputs": [],
    "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch"
  },
  {
    "id": "context7",
    "label": "Library docs",
    "group": "Web",
    "description": "Up-to-date documentation for programming libraries (hosted, read-only).",
    "transport": "http",
    "url": "https://mcp.context7.com/mcp",
    "headers": {},
    "inputs": [],
    "docs": "https://github.com/upstash/context7"
  },
  {
    "id": "memory",
    "label": "Memory",
    "group": "Knowledge",
    "description": "A small local knowledge graph the assistant can read and add to.",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@modelcontextprotocol/server-memory"
    ],
    "inputs": [],
    "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory"
  },
  {
    "id": "switch-docs",
    "label": "Agent Switch docs",
    "group": "Knowledge",
    "description": "Search the Agent Switch documentation (hosted, read-only). Switch brings AI teammates into Slack, Teams, Discord and Telegram.",
    "transport": "http",
    "url": "https://docs.switchagents.ai/mcp",
    "headers": {},
    "inputs": [],
    "docs": "https://github.com/sandbox-quantum/switch"
  }
];

module.exports = { PRESETS };
