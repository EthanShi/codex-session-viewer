# Session Viewer

A private, read-only Codex plugin that scans the current device's local Codex and Claude Code sessions and presents persisted context, queries, reasoning, tool calls, and tool results in a searchable dashboard.

Each installation reads only that teammate's local Codex and Claude Code data. The plugin does not upload or share session contents.

## Features

- Keeps Codex and Claude Code in separate tabs; switching sources clears the current selection, comparison, and detail cache, so only one source is visible at a time.
- Reads Codex from `CODEX_HOME` (or `~/.codex`) and Claude Code from `CLAUDE_CONFIG_DIR` (or `~/.claude`).
- Shows Unicode character counts and offline token estimates for persisted Codex prompts and Claude Code meta context.
- Selects any two sessions from the current source as A/B and compares their persisted prompt/context stacks side by side.
- Highlights added and removed lines, plus the exact changed text inside modified lines.
- Keeps turns and tool results collapsed by default for easier scanning.

Claude Code JSONL files do not contain the complete base system prompt. The viewer labels only readable, explicitly persisted meta messages as **Persisted context** and does not imply that they are the full Claude Code instruction stack.

## Install from the team marketplace

Team members need access to this GitHub repository and a recent Codex installation.

```powershell
codex plugin marketplace add EthanShi/codex-session-viewer --ref main
codex plugin add session-viewer@session-viewer-team
```

Restart the ChatGPT desktop app and start a new task, then ask Codex to open Session Viewer.
Codex starts the local service and replies with a clickable **Open Session Viewer** link; it does not open the dashboard in the Codex sidebar automatically.

## Update

```powershell
codex plugin marketplace upgrade session-viewer-team
codex plugin add session-viewer@session-viewer-team
```

Restart the desktop app and use a new task after upgrading.

## Repository layout

```text
.
├── .agents/plugins/marketplace.json
└── plugins/session-viewer/
    ├── .codex-plugin/plugin.json
    ├── assets/
    ├── scripts/
    └── skills/
```

## Security boundaries

- The viewer binds only to `127.0.0.1`.
- Codex rollout files and Claude Code project JSONL files are treated as read-only.
- Encrypted reasoning is not decoded.
- Token counts are content-only estimates and do not include hidden message framing or API-side accounting.
- The server does not expose session data to the LAN or the internet.
