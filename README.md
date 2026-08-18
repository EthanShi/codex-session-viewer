# Codex Session Viewer

A private, read-only Codex plugin that scans the current device's local Codex sessions and presents system prompts, queries, reasoning summaries, tool calls, and tool results in a searchable dashboard.

Each installation reads only that teammate's local Codex data. The plugin does not upload or share session contents.

## Install from the team marketplace

Team members need access to this GitHub repository and a recent Codex installation.

```powershell
codex plugin marketplace add EthanShi/codex-session-viewer --ref main
codex plugin add session-viewer@session-viewer-team
```

Restart the ChatGPT desktop app and start a new task, then ask Codex to open Session Viewer.

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
- Session rollout files are treated as read-only.
- Encrypted reasoning is not decoded.
- The server does not expose session data to the LAN or the internet.
