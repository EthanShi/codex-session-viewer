---
name: session-viewer
description: Launch the local, read-only Codex Session Viewer when the user asks to open, browse, inspect, or debug sessions, rollouts, turns, reasoning summaries, or tool traces on this device.
---

# Session Viewer

Open the bundled dashboard rather than manually printing rollout JSONL into the conversation.

## Launch

Resolve the plugin root from this `SKILL.md` location, then run its `scripts/open-viewer.ps1` with PowerShell. The launcher starts a hidden Node.js process on `127.0.0.1`, reuses an existing viewer when available, and opens the default browser.

Return the launcher's local URL as a clickable link even if the browser opened successfully. Do not wait on the server process.

If the user asks to avoid opening a browser, pass `-NoBrowser` and only return the URL.

## Boundaries

- Treat the Codex session store as read-only. Never edit, delete, rename, archive, or rewrite rollout files or `session_index.jsonl` as part of viewing.
- Keep the service bound to `127.0.0.1`; do not expose it on a LAN address or tunnel it externally.
- The viewer reads the current user's `CODEX_HOME` when set, otherwise `~/.codex`, including both `sessions` and `archived_sessions`.
- Persisted reasoning may be encrypted. Show only explicit reasoning summaries and `agent_reasoning` text available in the rollout; do not claim that encrypted reasoning was decoded.
- Do not paste session contents into chat unless the user separately asks for analysis of a specific session.
