import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSession, summarizeFile } from "./lib/session-parser.mjs";
import { extractReadableText } from "./lib/search-text.mjs";
import { isoTime, eventTime } from "./lib/codex-events.mjs";

const timestamp = "2026-11-06T06:54:09.000Z";
const seconds = Date.parse(timestamp) / 1000;
const record = (type, payload) => ({ timestamp, type, payload });
const event = (type, payload = {}) => record("event_msg", { type, ...payload });
const response = (type, payload = {}) => record("response_item", { type, ...payload });
const completed = (type, id, fields = {}, turn_id = "t1") => event("item_completed", { turn_id, started_at_ms: seconds * 1000, completed_at_ms: seconds * 1000 + 100, item: { type, id, ...fields } });
const user = (id, text, turn = "t1") => completed("UserMessage", id, { content: [{ type: "text", text }] }, turn);
const start = (turn_id = "t1", fields = {}) => event("task_started", { turn_id, started_at: seconds, ...fields });
async function fixture(rows, check) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-compat-"));
  const file = path.join(root, "rollout-test.jsonl");
  try {
    await writeFile(file, [record("session_meta", { id: "test", history_mode: "paginated", timestamp }), ...rows].map(JSON.stringify).join("\n"));
    await check(await readSession(file), await summarizeFile(file, false, new Map()), file);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("compaction boundaries preserve plaintext summaries without inventing turns", async () => {
  await fixture([
    record("compacted", { message: "Before any turn" }),
    start(), record("compacted", { message: "Previous work summary", window_id: "w1" }), user("u", "Continue"),
    completed("AgentMessage", "a", { content: [{ text: "Before compression" }] }),
    record("compacted", { message: "Mid-turn summary" }),
    completed("AgentMessage", "b", { content: [{ text: "After compression" }] }),
    event("task_complete", { turn_id: "t1" }),
    record("compacted", { message: "Trailing summary" }),
  ], detail => {
    assert.equal(detail.turns.length, 1);
    assert.deepEqual(detail.compactions.map(c => [c.placement, c.summary]), [
      ["before", "Before any turn"], ["before", "Previous work summary"], ["after", "Trailing summary"],
    ]);
    const steps = detail.turns[0].steps;
    assert.equal(steps[0].assistantMessages[0].text, "Before compression");
    assert.equal(steps[1].compaction.summary, "Mid-turn summary");
    assert.equal(steps[2].assistantMessages[0].text, "After compression");
    assert.equal(detail.turns[0].thinking.length, 0);
  });
});

test("encrypted, missing and legacy compaction summaries stay explicit and exclude retained messages", async () => {
  await fixture([
    start(), record("compacted", { message: "", replacement_history: [
      { type: "message", role: "user", content: [{ text: "Not a summary" }] },
      { type: "compaction", encrypted_content: "SECRET-COMPACTION" },
    ] }), user("u", "Continue"),
    event("context_compacted", { turn_id: "t1", message: "Legacy summary" }),
    event("task_complete", { turn_id: "t1" }),
    record("compacted", {}),
  ], detail => {
    assert.equal(detail.compactions[0].summary, "");
    assert.equal(detail.compactions[0].encrypted, true);
    assert.equal(detail.compactions.at(-1).summary, "");
    assert.equal(detail.compactions.at(-1).encrypted, false);
    assert.doesNotMatch(JSON.stringify(detail), /SECRET-COMPACTION|Not a summary/);
    assert.equal(detail.turns[0].steps[0].compaction.summary, "Legacy summary");
  });
});

test("dedicated empty compaction turns anchor between visible turns and at EOF", async () => {
  await fixture([
    start(), user("u", "First"), event("task_complete", { turn_id: "t1" }),
    start("compression"), record("compacted", { message: "Between turns" }),
    start("t2"), user("u2", "Second", "t2"), event("task_complete", { turn_id: "t2" }),
    start("compression-at-eof"), record("compacted", { message: "After last turn" }),
  ], detail => {
    assert.deepEqual(detail.turns.map(t => t.id), ["t1", "t2"]);
    assert.deepEqual(detail.compactions.map(c => [c.turnId, c.placement]), [["t2", "before"], ["t2", "after"]]);
  });
});

test("paginated user items override injected context and provide the preview", async () => {
  await fixture([
    start(), response("message", { role: "user", content: [{ text: "Actual question" }] }),
    response("message", { role: "user", content: [{ text: "<skill>injected</skill>" }] }),
    event("user_message", { message: "legacy mirror" }), user("u1", "Actual question"), user("u2", "追加问题"), user("u2", "追加问题"),
    completed("UserMessage", "u3", { content: [{ type: "image", image_url: "data:image/png;base64,PRIVATEIMAGE" }] }),
    event("task_complete", { turn_id: "t1", started_at: seconds, completed_at: seconds + 10, duration_ms: 10000 }),
  ], (detail, summary) => {
    assert.equal(detail.turns[0].query, "Actual question\n\n追加问题");
    assert.equal(summary.preview, "Actual question");
    assert.equal(detail.turns[0].queryAttachments.length, 1);
    assert.equal(detail.turns[0].startedAt, timestamp);
    assert.equal(detail.turns[0].completedAt, "2026-11-06T06:54:19.000Z");
    assert.equal(summary.updatedAt, detail.turns[0].completedAt);
    assert.equal(summary.historyMode, "paginated");
    assert.equal(detail.metadata.historyMode, "paginated");
  });
});

test("completion merges by identity, preserves distinct text duplicates and independent nested commands", async () => {
  await fixture([
    start(), user("u", "Run"),
    response("message", { id: "a", role: "assistant", content: [{ text: "partial" }] }),
    completed("AgentMessage", "a", { content: [{ type: "Text", text: "same" }], phase: "final_answer" }),
    completed("AgentMessage", "b", { content: [{ type: "Text", text: "same" }] }),
    completed("CommandExecution", "c", { command: ["echo", "hello"], aggregated_output: "complete-only-output", exit_code: 0, status: "completed" }),
    response("function_call", { id: "raw-c", call_id: "c", name: "exec", arguments: "old-input" }),
    response("function_call_output", { call_id: "c", output: "truncated" }),
    completed("CommandExecution", "nested", { command: ["echo", "hello"], aggregated_output: "nested-output" }),
    completed("CommandExecution", "c", { command: ["echo", "hello"], aggregated_output: "complete-only-output", exit_code: 0, status: "completed" }),
    response("reasoning", { id: "r", summary: [], encrypted_content: "SECRET" }),
    completed("Reasoning", "r", { summary_text: ["readable summary"], raw_content: [] }),
    event("task_complete", { turn_id: "t1" }),
    start("t2"), user("u2", "Next", "t2"),
    event("item_completed", { turn_id: "t1", item: { type: "FileChange", id: "f", changes: { "file.txt": { type: "update", unified_diff: "+new-line" } }, status: "completed" } }),
  ], (detail) => {
    const first = detail.turns[0];
    assert.equal(detail.turns.length, 2);
    assert.deepEqual(first.assistantMessages.map(m => m.text), ["same", "same"]);
    assert.equal(first.toolCalls.length, 3);
    assert.equal(first.toolCalls[0].output, "complete-only-output");
    assert.equal(first.toolCalls[0].exitCode, 0);
    assert.match(first.toolCalls[2].input, /new-line/);
    assert.deepEqual(first.thinking.map(t => t.text), ["readable summary"]);
    assert.equal(first.hiddenReasoningCount, 0);
    assert.equal(detail.turns[1].toolCalls.length, 0);
  });
});

test("search includes completed item fields while excluding media and encrypted fields", () => {
  const records = [
    completed("CommandExecution", "c", { command: ["unique-command"], aggregated_output: "unique-full-output", exit_code: 3 }),
    completed("FileChange", "f", { changes: { "file.txt": { unified_diff: "+unique-diff" } } }),
    completed("Reasoning", "r", { summary_text: ["unique-summary"], raw_content: ["unique-reasoning"], encrypted_content: "SECRET" }),
    completed("AgentMessage", "a", { content: [{ type: "Text", text: "unique-answer" }, { type: "image", data: "PRIVATEIMAGE" }] }),
    completed("Plan", "p", { text: "unique-plan" }),
    completed("SubAgentActivity", "s", { agent_path: "/root/unique-agent", kind: "spawn" }),
    completed("CollabAgentToolCall", "cc", { tool: "wait", receiver_thread_ids: ["unique-receiver"] }),
    completed("Extension", "e", { kind: "unique-extension", durationMs: 20 }),
  ];
  const text = records.flatMap(r => [...extractReadableText("codex", r)].map(v => v.text)).join("\n");
  for (const marker of ["unique-command", "unique-full-output", "unique-diff", "unique-summary", "unique-reasoning", "unique-answer", "unique-plan", "unique-agent", "unique-receiver", "unique-extension"]) assert.ok(text.includes(marker), marker);
  assert.ok(!text.includes("SECRET"));
  assert.ok(!text.includes("PRIVATEIMAGE"));
});

test("legacy, millisecond, invalid and aborted timestamps retain usable dates", async () => {
  await fixture([
    start("t1", { started_at: "invalid", started_at_ms: seconds * 1000 }), event("user_message", { message: "old question" }),
    event("turn_aborted", { turn_id: "t1", completed_at: "invalid" }),
    start("t2", { started_at: timestamp }), response("agent_message", { content: [{ text: "agent task" }] }),
    response("function_call_output", { call_id: "orphan", output: "result" }),
    event("unknown_future_event"),
  ], (detail, summary) => {
    assert.equal(detail.turns[0].startedAt, timestamp);
    assert.equal(detail.turns[0].completedAt, timestamp);
    assert.match(detail.turns[0].status, /aborted/);
    assert.equal(detail.turns[1].query, "agent task");
    assert.equal(detail.turns[1].toolCalls[0].output, "result");
    assert.equal(summary.preview, "old question");
  });
});

test("timestamps handle explicit units, zero, missing and invalid values", () => {
  assert.equal(isoTime(seconds), timestamp);
  assert.equal(isoTime(timestamp), timestamp);
  assert.equal(isoTime(seconds * 1000, null, true), timestamp);
  assert.equal(isoTime(0), "1970-01-01T00:00:00.000Z");
  for (const invalid of [null, undefined, "", "not a date", NaN, Infinity, {}, 1e30]) assert.equal(isoTime(invalid, timestamp), timestamp);
  assert.equal(eventTime({ started_at_ms: "invalid", started_at: seconds }, "started_at", null), timestamp);
});

test("output-before-call, late cross-turn output and empty completed reasoning retain raw data", async () => {
  await fixture([
    start(), user("u", "Question"),
    response("function_call_output", { call_id: "before", output: "early result" }),
    response("function_call", { call_id: "before", name: "early", arguments: "input" }),
    response("function_call", { call_id: "late", name: "late", arguments: "input" }),
    completed("Reasoning", "encrypted", { summary_text: [], raw_content: [] }),
    response("reasoning", { id: "encrypted", summary: [], encrypted_content: "cipher" }),
    start("t2"), user("u2", "Second", "t2"),
    response("function_call_output", { call_id: "late", output: "late result" }),
  ], detail => {
    assert.equal(detail.turns[0].toolCalls[0].output, "early result");
    assert.equal(detail.turns[0].toolCalls[1].output, "late result");
    assert.equal(detail.turns[1].toolCalls.length, 0);
    assert.equal(detail.turns[0].hiddenReasoningCount, 1);
  });
});

test("all completed variants render, and response-only input remains a fallback", async () => {
  await fixture([
    start(), response("message", { id: "u", role: "user", content: [{ type: "input_text", text: "fallback" }] }),
    completed("Plan", "p", { text: "the plan" }),
    completed("SubAgentActivity", "s", { kind: "spawn", agent_path: "/root/worker" }),
    completed("CollabAgentToolCall", "c", { tool: "wait", status: "completed", agents_states: { worker: "done" } }),
    completed("Extension", "e", { kind: "helper", durationMs: 22 }),
    completed("FutureItem", "future", { text: "not recognized" }),
  ], (detail, summary) => {
    assert.equal(detail.turns[0].query, "fallback");
    assert.equal(summary.preview, "fallback");
    assert.equal(detail.turns[0].assistantMessages[0].phase, "plan");
    assert.deepEqual(detail.turns[0].toolCalls.map(t => t.name), ["Sub-agent · spawn", "Collaboration · wait", "Extension · helper"]);
    assert.equal(detail.turns[0].toolCalls[2].durationMs, 22);
  });
});
