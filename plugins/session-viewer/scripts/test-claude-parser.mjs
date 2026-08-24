import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listClaudeSessions, readClaudeSession } from "./lib/claude-session-parser.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "claude-session-viewer-test-"));
const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const projectDirectory = path.join(fixtureRoot, "projects", "D--fixture-project");
const sessionPath = path.join(projectDirectory, `${sessionId}.jsonl`);

function record(value) {
  return JSON.stringify({
    sessionId,
    cwd: "D:\\fixture-project",
    version: "9.9.9",
    gitBranch: "fixture",
    entrypoint: "cli",
    ...value,
  });
}

try {
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    sessionPath,
    [
      record({
        type: "user",
        uuid: "meta-1",
        isMeta: true,
        timestamp: "2026-08-24T01:00:00Z",
        message: { role: "user", content: "Persisted Claude Code context" },
      }),
      record({
        type: "user",
        uuid: "user-1",
        timestamp: "2026-08-24T01:00:01Z",
        message: { role: "user", content: "Inspect this project" },
      }),
      record({
        type: "assistant",
        uuid: "assistant-1",
        timestamp: "2026-08-24T01:00:02Z",
        message: {
          role: "assistant",
          model: "claude-fixture",
          stop_reason: "tool_use",
          content: [
            { type: "thinking", thinking: "I should inspect the files", signature: "ignored" },
            { type: "text", text: "I’ll inspect the project." },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      }),
      record({
        type: "user",
        uuid: "result-1",
        timestamp: "2026-08-24T01:00:03Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: '{"ok":true}' }],
        },
      }),
      record({
        type: "assistant",
        uuid: "assistant-2",
        timestamp: "2026-08-24T01:00:04Z",
        message: {
          role: "assistant",
          model: "claude-fixture",
          stop_reason: "end_turn",
          content: [
            { type: "thinking", thinking: "", signature: "redacted" },
            { type: "text", text: "Inspection complete." },
          ],
        },
      }),
      record({
        type: "system",
        subtype: "turn_duration",
        durationMs: 3000,
        timestamp: "2026-08-24T01:00:04Z",
      }),
      record({ type: "ai-title", aiTitle: "Claude parser fixture" }),
    ].join("\n") + "\n",
  );

  const listing = await listClaudeSessions(fixtureRoot);
  assert.equal(listing.source, "claude");
  assert.equal(listing.capabilities.archives, false);
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].id, sessionId);
  assert.equal(listing.sessions[0].title, "Claude parser fixture");
  assert.equal(listing.sessions[0].turnCount, 1);
  assert.equal(listing.sessions[0].systemPromptCount, 1);
  assert.equal(listing.sessions[0].model, "claude-fixture");

  const detail = await readClaudeSession(sessionPath);
  assert.equal(detail.metadata.id, sessionId);
  assert.equal(detail.metadata.model, "claude-fixture");
  assert.equal(detail.systemPrompts.length, 1);
  assert.equal(detail.systemPrompts[0].kind, "context");
  assert.equal(detail.systemPrompts[0].content, "Persisted Claude Code context");
  assert.equal(detail.turns.length, 1);
  assert.equal(detail.turns[0].query, "Inspect this project");
  assert.equal(detail.turns[0].thinking[0].text, "I should inspect the files");
  assert.equal(detail.turns[0].hiddenReasoningCount, 1);
  assert.equal(detail.turns[0].assistantMessages.at(-1).text, "Inspection complete.");
  assert.equal(detail.turns[0].toolCalls[0].name, "Read");
  assert.match(detail.turns[0].toolCalls[0].output, /"ok": true/);
  assert.equal(detail.turns[0].steps.length, 2);
  assert.equal(detail.turns[0].durationMs, 3000);
  assert.equal(detail.turns[0].status, "complete");
  console.log("Claude session parser tests passed.");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
