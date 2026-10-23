"""One-click starting points for well-known MCP servers.

These are *templates*, not endorsements or bundled code: FlowMesh runs whatever the
person registers, and a stdio template simply fills in the command line that the
server's own documentation gives. Nothing here is installed, trusted or verified by
FlowMesh; adding one still goes through the explicit "this runs a program" gate and
every call still needs a plan the person approves.

`inputs` are values the person supplies; `{key}` placeholders in `args`, `url`, `headers`
and `env` values are replaced by the UI before the server is registered.
"""

PRESETS = [
    {
        "id": "filesystem", "label": "Files", "group": "Code & files",
        "description": "Read, write and search files inside one folder you choose.",
        "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "{path}"],
        "inputs": [{"key": "path", "label": "Folder to allow", "placeholder": "C:\\Users\\you\\projects\\demo"}],
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    },
    {
        "id": "git", "label": "Git", "group": "Code & files",
        "description": "Inspect and operate on one git repository: status, diff, log, commit.",
        "transport": "stdio", "command": "uvx", "args": ["mcp-server-git", "--repository", "{path}"],
        "inputs": [{"key": "path", "label": "Repository path", "placeholder": "C:\\Users\\you\\projects\\demo"}],
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    },
    {
        "id": "github", "label": "GitHub", "group": "Code & files",
        "description": "Issues, pull requests, code search and repositories through GitHub's hosted MCP server.",
        "transport": "http", "url": "https://api.githubcopilot.com/mcp/",
        "headers": {"Authorization": "Bearer {token}"},
        "inputs": [{"key": "token", "label": "GitHub personal access token", "placeholder": "github_pat_…", "secret": True}],
        "docs": "https://github.com/github/github-mcp-server",
    },
    {
        "id": "playwright", "label": "Browser", "group": "Web",
        "description": "Drive a real browser: open pages, click, fill forms, read the page.",
        "transport": "stdio", "command": "npx", "args": ["@playwright/mcp@latest"], "inputs": [],
        "docs": "https://github.com/microsoft/playwright-mcp",
    },
    {
        "id": "fetch", "label": "Web fetch", "group": "Web",
        "description": "Fetch a web page and return it as readable text.",
        "transport": "stdio", "command": "uvx", "args": ["mcp-server-fetch"], "inputs": [],
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    },
    {
        "id": "context7", "label": "Library docs", "group": "Web",
        "description": "Up-to-date documentation for programming libraries (hosted, read-only).",
        "transport": "http", "url": "https://mcp.context7.com/mcp", "headers": {}, "inputs": [],
        "docs": "https://github.com/upstash/context7",
    },
    {
        "id": "memory", "label": "Memory", "group": "Knowledge",
        "description": "A small local knowledge graph the assistant can read and add to.",
        "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"], "inputs": [],
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    },
    {
        "id": "switch-docs", "label": "Agent Switch docs", "group": "Knowledge",
        "description": "Search the Agent Switch documentation (hosted, read-only). Switch brings AI teammates into Slack, Teams, Discord and Telegram.",
        "transport": "http", "url": "https://docs.switchagents.ai/mcp", "headers": {}, "inputs": [],
        "docs": "https://github.com/sandbox-quantum/switch",
    },
    {
        "id": "discord", "label": "Discord", "group": "Messaging",
        "description": "Read and send messages in the Discord servers your own bot has joined. Template: the bot and its token are yours; FlowMesh has not verified this server end to end.",
        "transport": "stdio", "command": "npx", "args": ["-y", "mcp-discord"],
        "env": {"DISCORD_TOKEN": "{token}"},
        "inputs": [{"key": "token", "label": "Discord bot token", "placeholder": "paste the bot token", "secret": True}],
        "docs": "https://github.com/barryyip0625/mcp-discord",
    },
    {
        "id": "slack", "label": "Slack", "group": "Messaging",
        "description": "Read channels and post messages as your Slack app. Template: the app and its token are yours; FlowMesh has not verified this server end to end.",
        "transport": "stdio", "command": "npx", "args": ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
        "env": {"SLACK_MCP_XOXB_TOKEN": "{token}"},
        "inputs": [{"key": "token", "label": "Slack bot token (xoxb-…)", "placeholder": "xoxb-…", "secret": True}],
        "docs": "https://github.com/korotovsky/slack-mcp-server",
    },
    {
        "id": "notion", "label": "Notion", "group": "Knowledge",
        "description": "Search and edit the Notion pages your integration can see. Template: the integration and its token are yours; FlowMesh has not verified this server end to end.",
        "transport": "stdio", "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"],
        "env": {"NOTION_TOKEN": "{token}"},
        "inputs": [{"key": "token", "label": "Notion integration token", "placeholder": "ntn_…", "secret": True}],
        "docs": "https://github.com/makenotion/notion-mcp-server",
    },
    {
        "id": "switch", "label": "Agent Switch (yours)", "group": "Messaging",
        "description": "Connect an Agent Switch you host yourself, so its AI teammates in Slack, Teams, Discord and Telegram can be reached from FlowMesh. Template: enter your own server's MCP URL and token.",
        "transport": "http", "url": "{url}", "headers": {"Authorization": "Bearer {token}"},
        "inputs": [
            {"key": "url", "label": "Your Switch MCP URL (https)", "placeholder": "https://switch.example.com/mcp"},
            {"key": "token", "label": "Bearer token", "placeholder": "paste the token", "secret": True},
        ],
        "docs": "https://github.com/sandbox-quantum/switch",
    },
]
