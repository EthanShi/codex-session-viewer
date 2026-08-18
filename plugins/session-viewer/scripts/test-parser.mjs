import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listSessions, readSession } from "./lib/session-parser.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "session-viewer-test-"));
const sessionId = "11111111-2222-4333-8444-555555555555";
const sessionDirectory = path.join(fixtureRoot, "sessions", "2026", "08", "18");
const sessionPath = path.join(sessionDirectory, `rollout-2026-08-18T10-00-00-${sessionId}.jsonl`);

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

try {
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(path.join(fixtureRoot, "archived_sessions"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Synthetic parser test", updated_at: "2026-08-18T10:01:00Z" })}\n`,
  );
  await writeFile(
    sessionPath,
    [
      line("2026-08-18T10:00:00Z", "session_meta", {
        id: sessionId,
        timestamp: "2026-08-18T10:00:00Z",
        cwd: "D:\\fixture",
        originator: "codex_desktop",
        model_provider: "openai",
        base_instructions: "Base system prompt",
      }),
      line("2026-08-18T10:00:01Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-1",
        started_at: "2026-08-18T10:00:01Z",
      }),
      line("2026-08-18T10:00:01Z", "response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Developer instruction" }],
      }),
      line("2026-08-18T10:00:01Z", "turn_context", {
        turn_id: "turn-1",
        cwd: "D:\\fixture",
        model: "gpt-test",
      }),
      line("2026-08-18T10:00:02Z", "response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fallback query" }],
      }),
      line("2026-08-18T10:00:02Z", "event_msg", { type: "user_message", message: "Actual query" }),
      line("2026-08-18T10:00:03Z", "response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Reasoning summary" }],
        encrypted_content: "encrypted",
      }),
      line("2026-08-18T10:00:04Z", "response_item", {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "fixture_tool",
        input: '{"value":1}',
      }),
      line("2026-08-18T10:00:05Z", "response_item", {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: '{"ok":true}',
      }),
      line("2026-08-18T10:00:06Z", "response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Second reasoning summary" }],
        encrypted_content: "encrypted-again",
      }),
      line("2026-08-18T10:00:07Z", "response_item", {
        type: "custom_tool_call",
        call_id: "call-2",
        name: "second_tool",
        input: '{"value":2}',
      }),
      line("2026-08-18T10:00:08Z", "response_item", {
        type: "custom_tool_call_output",
        call_id: "call-2",
        output: '{"ok":true,"step":2}',
      }),
      line("2026-08-18T10:00:09Z", "response_item", {
        type: "message",
        role: "assistant",
        phase: "final",
        content: [{ type: "output_text", text: "Done" }],
      }),
      line("2026-08-18T10:00:10Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-1",
        completed_at: "2026-08-18T10:00:10Z",
        duration_ms: 9000,
      }),
    ].join("\n") + "\n",
  );

  const listing = await listSessions(fixtureRoot);
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].title, "Synthetic parser test");
  assert.equal(listing.sessions[0].turnCount, 1);

  const detail = await readSession(sessionPath);
  assert.equal(detail.systemPrompts.length, 2);
  assert.equal(detail.turns.length, 1);
  assert.equal(detail.turns[0].query, "Actual query");
  assert.equal(detail.turns[0].thinking[0].text, "Reasoning summary");
  assert.equal(detail.turns[0].hiddenReasoningCount, 0);
  assert.equal(detail.turns[0].toolCalls[0].name, "fixture_tool");
  assert.match(detail.turns[0].toolCalls[0].output, /"ok": true/);
  assert.equal(detail.turns[0].assistantMessages[0].text, "Done");
  assert.equal(detail.turns[0].steps.length, 3);
  assert.equal(detail.turns[0].steps[0].thinking[0].text, "Reasoning summary");
  assert.equal(detail.turns[0].steps[0].toolCalls[0].name, "fixture_tool");
  assert.equal(detail.turns[0].steps[1].thinking[0].text, "Second reasoning summary");
  assert.equal(detail.turns[0].steps[1].toolCalls[0].name, "second_tool");
  assert.equal(detail.turns[0].steps[2].assistantMessages[0].text, "Done");
  assert.equal(detail.turns[0].status, "complete");
  console.log("Session parser tests passed.");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
