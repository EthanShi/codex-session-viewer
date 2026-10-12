---
name: session-viewer
description: Launch the local, read-only Session Viewer when the user asks to open, browse, inspect, or debug Codex or Claude Code sessions, rollouts, turns, reasoning, or tool traces on this device.
---

# Session Viewer

Start the bundled dashboard rather than manually printing local session JSONL into the conversation. The dashboard keeps Codex and Claude Code as separate selectable sources and displays only one source at a time.

## Launch

Resolve the plugin root from this `SKILL.md` location, then run its `scripts/open-viewer.ps1` with PowerShell. The launcher starts a hidden Node.js process on `127.0.0.1` and reuses an existing viewer when available.

The viewer requires Node.js 22.13+ with built-in SQLite FTS5 support. The launcher validates the runtime and only reuses a server that supports date-scoped full-text search. Its derived SQLite index is separate from the read-only session stores. The default list covers the latest seven local calendar days by log modification time; users may select up to 30 days. Opening the list does not build a full-text index. Searches are submitted by the dashboard's Search button; editing keywords or dates alone does not run a search. Selected logs are searched in full, including older messages.

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
