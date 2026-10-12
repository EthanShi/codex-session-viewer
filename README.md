# Session Viewer

A private, read-only Codex plugin that scans the current device's local Codex and Claude Code sessions and presents persisted context, queries, reasoning, tool calls, and tool results in a searchable dashboard.

Each installation reads only that teammate's local Codex and Claude Code data. The plugin does not upload or share session contents.

## Features

- Searches all readable messages, replies, persisted prompts/context, reasoning, tool names, inputs, and outputs, plus session titles, IDs, directories, and models. Search uses literal, case-insensitive substrings, including Chinese text, IP addresses, and paths.
- Defaults to the latest seven local calendar days. Choose **最近一周**, **最近一月（30天）**, or custom dates covering at most 30 days, including both endpoints. Dates filter the log file's last modification time, and apply to both the list and search. Matching files are searched in full, including older messages; copying a file can change its modification time.
- Runs searches only when you click **全文搜索**. Editing a query preserves the previous results and labels their submitted query; clearing it restores the ordinary list. Each matching session has one short original-text excerpt, and results display in batches of 100.
- Editing dates preserves the applied list/results until submission. With no keyword, **应用时间段** loads that range's ordinary list; with a keyword, **全文搜索** applies the range and searches. Clearing restores the applied range's list, refresh uses that same range, and switching sources preserves the applied dates while clearing pending date edits and searches.
- Reads only summaries when opening or refreshing a list. Only manual full-text search builds a persistent, incremental SQLite trigram index in background workers, for the selected range. Unchanged logs and previously indexed overlapping ranges are reused across refreshes and restarts; the browser receives only summaries and excerpts. Short one- or two-character searches scan cached text and can take longer.
- Keeps Codex and Claude Code in separate tabs; switching sources clears the current selection, comparison, and detail cache, so only one source is visible at a time.
- Reads Codex from `CODEX_HOME` (or `~/.codex`) and Claude Code from `CLAUDE_CONFIG_DIR` (or `~/.claude`).
- Shows Unicode character counts and offline token estimates for persisted Codex prompts and Claude Code meta context.
- Selects any two sessions from the current source as A/B and compares their persisted prompt/context stacks side by side.
- Highlights added and removed lines, plus the exact changed text inside modified lines.
- Keeps turns and tool results collapsed by default for easier scanning.

Claude Code JSONL files do not contain the complete base system prompt. The viewer labels only readable, explicitly persisted meta messages as **Persisted context** and does not imply that they are the full Claude Code instruction stack.

## Install from the team marketplace

Team members need access to this GitHub repository, a recent Codex installation, and **Node.js 22.13+ with built-in SQLite FTS5 support** (Node.js 23 requires 23.4+). No npm dependencies are required.

```powershell
codex plugin marketplace add EthanShi/codex-session-viewer --ref main
codex plugin add session-viewer@ethanshi
```

Restart the ChatGPT desktop app and start a new task, then ask Codex to open Session Viewer.
Codex starts the local service and replies with a clickable **Open Session Viewer** link; it does not open the dashboard in the Codex sidebar automatically.

## Update

```powershell
codex plugin marketplace upgrade ethanshi
codex plugin add session-viewer@ethanshi
```

Restart the desktop app and use a new task after upgrading.

The launcher checks the date-scoped full-text-search capability before reusing a server, so an older running viewer is not reused after upgrading. Stop an older viewer before upgrading its shared cache, then open the new URL returned by the launcher.

## Search index and verification

The derived search cache is separate from session storage: `%LOCALAPPDATA%/SessionViewer/search` on Windows, or `~/.cache/session-viewer/search` otherwise. Each source and absolute log root has an isolated, versioned index. You can delete the derived cache while the viewer is stopped; the next scan rebuilds it. Session logs remain read-only. Media/base64 attachments and encrypted reasoning are excluded.

Files are checked by path, size, modification time, and change time. Manual refresh bypasses the five-second directory-check cache. Directory checks enumerate paths and stat files, then exclude out-of-range logs before reading their bodies. Summaries and full-text bodies have independent fingerprints: loading a summary never marks the body as indexed. Only selected changed files are indexed; queries wait for indexing to finish and display their operation's progress. New index generations mark existing results as stale without automatically searching again. Queries are limited to 256 Unicode characters after lowercasing. A recently updated large session still requires indexing its complete body.

List, search, and index-status requests accept inclusive `from` and `to` dates (`YYYY-MM-DD`) in the device's local time zone. Omitting both defaults to the latest seven days; incomplete, invalid, reversed, or longer-than-30-day ranges return HTTP 400 before body reads. Responses include the applied range and time zone, and summaries include `logModifiedAt`. Detail reads locate one file and do not index other logs. When details include dates, they open the same duplicate-ID winner as that range's list; ID-only detail requests retain their original unrestricted behavior. Version 0.3.0 migrates the existing SQLite cache in place and reuses its published bodies.

Long-running list/search requests return a `202` operation reference; the UI polls that operation for progress and completion without submitting the query again. Clearing, switching sources, or submitting another search cancels the previous operation. Read failures are shown with an incomplete-results warning. Only one viewer process can write a particular cache at a time; the launcher reuses compatible servers, and an interrupted process's cache lease is recovered on restart.

Run the parser, UI, search, and HTTP tests with Node's built-in test runner:

```powershell
node --test plugins/session-viewer/scripts/test-*.mjs
```

Run the synthetic performance benchmark (defaults: 1,000 sessions / 1 GiB; use `--mib 5120` for 5 GiB):

```powershell
node plugins/session-viewer/scripts/benchmark-search.mjs
```

The benchmark distributes modification times across 90 days and reports selected file counts/bytes, summary-list time, cold indexing, restart reuse, query P50/P95, HTTP health latency during indexing, peak sampled RSS, and index disk usage for seven- and 30-day ranges. It audits file opens and bytes read to verify that out-of-range bodies are not read, and keeps real session stores untouched.

Date-scoped results, measured on Windows x64 with Node.js 24.19.0 (2026-10-12): 1,000 synthetic sessions / 1,026.35 MiB spread over 90 days, with independent cold caches for each range. Warm queries used distinct terms to avoid the JavaScript result cache.

| Metric | 7 days | 30 days |
| --- | ---: | ---: |
| Selected files / input size | 84 / 86.21 MiB | 340 / 348.96 MiB |
| First summary list | 1.12 s | 2.11 s |
| Cold full-text indexing | 26.35 s | 104.08 s |
| Restart list / search with reused bodies | 60.08 / 11.49 ms | 97.98 / 18.97 ms |
| Warm IP query P50 / P95 | 8.43 / 33.63 ms | 16.44 / 22.53 ms |
| Warm Chinese query P50 / P95 | 7.86 / 8.57 ms | 15.59 / 19.15 ms |
| Health during indexing P95 | 0.95 ms | 0.82 ms |
| Frequent short query P50 / P95 | 15.21 / 32.89 ms | 90.35 / 93.05 ms |
| Rare short full scan P50 / P95 | 1,106.56 / 1,110.94 ms | 1,108.64 / 1,115.89 ms |
| Peak sampled RSS | 277.0 MiB | 292.4 MiB |
| Index disk usage | 236.6 MiB | 926.9 MiB |
| List body chunks / out-of-range files opened / out-of-range bytes read | 0 / 0 / 0 | 0 / 0 / 0 |

Both ranges passed the 500 ms warm-query and 100 ms indexing-health P95 targets. Rare short-query times include the asynchronous operation's one-second polling interval. Restart checks verified unchanged body generations and fingerprints; the read audit was checked against deliberate reads from both parsers. Previously indexed overlapping ranges are reused in normal use, while these cold measurements use separate caches. Actual times depend on file sizes and storage. A 5 GiB run is configurable but was not measured in this validation.

Previous all-file-index baseline, measured on Windows x64 with Node.js 24.19.0 (2026-10-12), using 1,000 synthetic sessions and 1,026.35 MiB of JSONL. Warm queries used distinct terms to avoid the JavaScript result cache:

| Metric | Result |
| --- | ---: |
| Cold indexing | 300.43 s |
| Restart listing / reused files | 1.12 s / 1,000 |
| Warm IP query P50 / P95 | 2.72 / 3.52 ms |
| Warm Chinese query P50 / P95 | 2.52 / 2.90 ms |
| Health during indexing P95 | 0.76 ms |
| Frequent short query P95 | 70.31 ms |
| Rare one- or two-character scan, including operation polling | 2.13 s |
| Peak sampled RSS | 327.7 MiB |
| Index disk usage | 2.63 GiB |

This baseline met the latency targets but indexed every file; the date-scoped measurements above build only selected logs.

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
