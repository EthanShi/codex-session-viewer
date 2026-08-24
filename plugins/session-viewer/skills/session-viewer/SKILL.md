---
name: session-viewer
description: Launch the local, read-only Codex Session Viewer when the user asks to open, browse, inspect, or debug sessions, rollouts, turns, reasoning summaries, or tool traces on this device.
---

# Session Viewer

Start the bundled dashboard rather than manually printing rollout JSONL into the conversation.

## Launch

Resolve the plugin root from this `SKILL.md` location, then run its `scripts/open-viewer.ps1` with PowerShell. The launcher starts a hidden Node.js process on `127.0.0.1` and reuses an existing viewer when available.

After the launcher returns, give the user its local URL as a clickable Markdown link, for example `[Open Session Viewer](http://127.0.0.1:3847)`. Do not wait on the server process.

Do not open the URL automatically, do not navigate the Codex app to it, and do not use an in-app browser or sidebar. Let the user decide when to open the returned link.

## Boundaries

- Treat the Codex session store as read-only. Never edit, delete, rename, archive, or rewrite rollout files or `session_index.jsonl` as part of viewing.
- Keep the service bound to `127.0.0.1`; do not expose it on a LAN address or tunnel it externally.
- The viewer reads the current user's `CODEX_HOME` when set, otherwise `~/.codex`, including both `sessions` and `archived_sessions`.
- Persisted reasoning may be encrypted. Show only explicit reasoning summaries and `agent_reasoning` text available in the rollout; do not claim that encrypted reasoning was decoded.
- Do not paste session contents into chat unless the user separately asks for analysis of a specific session.
