---
name: session-viewer
description: Launch the local, read-only Session Viewer when the user asks to open, browse, inspect, or debug Codex or Claude Code sessions, rollouts, turns, reasoning, or tool traces on this device.
---

# Session Viewer

Start the bundled dashboard rather than manually printing local session JSONL into the conversation. The dashboard keeps Codex and Claude Code as separate selectable sources and displays only one source at a time.

## Launch

Resolve the plugin root from this `SKILL.md` location, then run its `scripts/open-viewer.ps1` with PowerShell. The launcher starts a hidden Node.js process on `127.0.0.1` and reuses an existing viewer when available.

After the launcher returns, give the user its local URL as a clickable Markdown link, for example `[Open Session Viewer](http://127.0.0.1:3847)`. Do not wait on the server process.

Do not open the URL automatically, do not navigate the Codex app to it, and do not use an in-app browser or sidebar. Let the user decide when to open the returned link.

## Boundaries

- Treat both session stores as read-only. Never edit, delete, rename, archive, or rewrite Codex rollout files, `session_index.jsonl`, or Claude Code project JSONL files as part of viewing.
- Keep the service bound to `127.0.0.1`; do not expose it on a LAN address or tunnel it externally.
- The viewer reads the current user's `CODEX_HOME` when set, otherwise `~/.codex`, including both `sessions` and `archived_sessions`.
- The viewer reads the current user's `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`, and scans top-level session JSONL files under `projects/<project>/` without presenting nested subagent logs as independent sessions.
- Codex reasoning may be encrypted, and Claude Code thinking blocks may omit readable text. Show only text explicitly available in the logs; do not claim hidden reasoning was decoded.
- Claude Code logs do not persist the complete base system prompt. Label only explicit meta messages as persisted context; do not present them as the full Claude Code instruction stack.
- Do not paste session contents into chat unless the user separately asks for analysis of a specific session.
