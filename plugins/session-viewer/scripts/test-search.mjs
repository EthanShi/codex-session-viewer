import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSearchService } from "./lib/search-service.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const timestamp = "2026-10-12T01:00:00Z";
const id = (n) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
const codex = (type, payload) => ({ timestamp, type, payload });
const message = (text, role = "user") => codex("response_item", { type: "message", role, content: [{ type: "input_text", text }] });
const claude = (sessionId, value) => ({ timestamp, sessionId, cwd: "D:\\ClaudeFixture", ...value });
const jsonl = (records) => records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function config(root) {
  return {
    sources: { codex: { root: path.join(root, "codex") }, claude: { root: path.join(root, "claude") } },
    cacheRoot: path.join(root, "cache"),
  };
}

// A subprocess is deliberately stopped during a replacement build so recovery
// exercises actual SQLite/WAL interruption, not a mocked staging implementation.
if (process.argv[2] === "--interrupt-builder") {
  const { DatabaseSync } = await import("node:sqlite");
  const cacheRoot = path.join(process.argv[3], "cache");
  const databases = (await readdir(cacheRoot)).filter((file) => file.endsWith(".sqlite")).map((file) => {
    const db = new DatabaseSync(path.join(cacheRoot, file), { readOnly: true });
    return { db, stagingRows: db.prepare("SELECT count(*) AS count FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.generation!=f.active_generation") };
  });
  const service = createSearchService(config(process.argv[3]));
  const building = (async () => {
    await service.list("codex", { refresh: true });
    return service.search("codex", "interrupted-rebuild-marker");
  })();
  building.catch(() => {});
  const polling = setInterval(() => {
    const status = service.status("codex");
    if ((status.phase === "indexing" || status.phase === "building") && databases.some(({ stagingRows }) => stagingRows.get().count > 0)) {
      clearInterval(polling);
      process.stdout.write("BUILD_STARTED\n");
    }
  }, 1);
  await building;
  for (const { db } of databases) db.close();
  process.stdout.write("BUILD_FINISHED\n");
  await service.close();
  process.exit(0);
}

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "session-viewer-fulltext-test-"));
let service;
let assertions = 0;

async function writeCodex(n, records, archived = false) {
  const file = path.join(fixtureRoot, "codex", archived ? "archived_sessions" : "sessions", `rollout-${id(n)}.jsonl`);
  await writeFile(file, jsonl([codex("session_meta", { id: id(n), cwd: "D:\\CodexFixture", model: "fixture-model", timestamp }), ...records]));
  return file;
}

async function hits(source, query, expected) {
  const result = await service.search(source, query);
  assert.equal(result.query, query);
  assert.equal(typeof result.generation, "number");
  assert.equal(new Set(result.matches.map((match) => match.id)).size, result.matches.length, "session IDs are deduplicated");
  assert.deepEqual(result.matches.map((match) => match.id).sort(), [...expected].sort(), `${source}: ${JSON.stringify(query)}`);
  for (const match of result.matches) {
    assert.equal(typeof match.snippet, "string");
    assert.ok(Array.from(match.snippet).length <= 240, `snippet too long for ${query}`);
    assert.ok(typeof match.kind === "string" && match.kind.length > 0, "match carries its content category");
  }
  assertions += 1;
  return result;
}

async function refresh(source = "codex") {
  const listing = await service.list(source, { refresh: true });
  assert.ok(Array.isArray(listing.sessions));
  return listing;
}

async function interruptBuild() {
  const child = spawn(process.execPath, [scriptPath, "--interrupt-builder", fixtureRoot], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let started = false;
  child.stderr.on("data", (data) => { stderr += data; });
  const stopped = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Interrupted-build subprocess timed out: ${stderr}`)); }, 20000);
    child.stdout.on("data", (data) => {
      if (String(data).includes("BUILD_STARTED")) {
        started = true;
        child.kill();
      }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!started) reject(new Error(`Replacement failed before indexing started (${code}): ${stderr}`));
      else if (code === 0) reject(new Error("Replacement finished before interruption; recovery fixture needs to be larger"));
      else if (code === null || signal || code === 1) resolve();
      else reject(new Error(`Interrupted builder failed unexpectedly (${code}): ${stderr}`));
    });
  });
  await stopped;
}

try {
  await Promise.all([
    mkdir(path.join(fixtureRoot, "codex", "sessions"), { recursive: true }),
    mkdir(path.join(fixtureRoot, "codex", "archived_sessions"), { recursive: true }),
    mkdir(path.join(fixtureRoot, "claude", "projects", "fixture"), { recursive: true }),
  ]);
  const boundaryQuery = "边界跨块检索😀10.104.5.20";
  const longQuery = "界".repeat(256);
  const fixtureText = `${"x".repeat(400)} later-preview-marker 中文全文检索\nMiXeDCaSe 10.104.5.20 D:\\path\\file.txt 100%_literal \"quoted\" 😀😃😄 完\n`;
  const mainFile = await writeCodex(1, [
    codex("session_meta", { id: id(1), cwd: "D:\\CodexFixture", model: "metadata-model-marker", base_instructions: { text: "system-base-marker" } }),
    message(fixtureText),
    codex("event_msg", { type: "task_started", turn_id: "second" }),
    codex("event_msg", { type: "user_message", message: "later-turn-marker" }),
    codex("event_msg", { type: "agent_message", message: "event-answer-marker" }),
    codex("event_msg", { type: "agent_reasoning", text: "event-thinking-marker" }),
    message("assistant-answer-marker", "assistant"),
    message("developer-context-marker", "developer"),
    codex("turn_context", { model: "turn-context-model-marker", cwd: "D:\\context-cwd-marker" }),
    codex("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "readable-thinking-marker" }], content: [{ type: "reasoning_text", text: "reasoning-content-marker" }], encrypted_content: "encrypted-secret-marker" }),
    codex("response_item", { type: "function_call", name: "function-tool-name-marker", arguments: '{"arg":"function-input-marker"}', call_id: "a" }),
    codex("response_item", { type: "function_call_output", call_id: "a", output: "function-output-marker" }),
    codex("response_item", { type: "custom_tool_call", name: "custom-tool-name-marker", input: "custom-input-marker", call_id: "b" }),
    codex("response_item", { type: "custom_tool_call_output", call_id: "b", output: "custom-output-marker" }),
    codex("response_item", { type: "function_call", name: "business_signature", arguments: { signature: "business-signature-marker" }, call_id: "c" }),
    codex("response_item", { type: "function_call_output", call_id: "c", output: { type: "image", prompt: "readable-image-caption-marker", data: "tool-image-binary-secret-marker" } }),
    codex("event_msg", { type: "context_compacted", message: "compacted-context-marker" }),
    codex("event_msg", { type: "task_complete", last_agent_message: "last-answer-marker" }),
    message(`${"a".repeat(32760)}${boundaryQuery}${"b".repeat(400)}`, "assistant"),
    message(`${"c".repeat(32767)}${longQuery}`, "assistant"),
    message("safe\0literal-marker", "assistant"),
    codex("response_item", { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,media-secret-marker" }] }),
  ]);
  await writeCodex(2, [message("abc separates bcd with cde but is no contiguous full match")]);
  const duplicateActive = await writeCodex(3, [message("active-duplicate-marker")]);
  await writeCodex(3, [message("archived-duplicate-marker")], true);
  const updateFile = await writeCodex(4, [message("mutable-before-marker")]);
  await writeFile(path.join(fixtureRoot, "codex", "session_index.jsonl"), jsonl([{ id: id(1), thread_name: "metadata-title-marker", updated_at: timestamp }]));
  const claudeFile = path.join(fixtureRoot, "claude", "projects", "fixture", `${id(5)}.jsonl`);
  await writeFile(claudeFile, jsonl([
    claude(id(5), { type: "user", isMeta: true, message: { role: "user", content: "claude-context-marker" } }),
    claude(id(5), { type: "user", message: { role: "user", content: `${"p".repeat(400)}claude-late-marker 中文全文检索 10.104.5.20` } }),
    claude(id(5), { type: "assistant", message: { role: "assistant", model: "claude-model-marker", content: [
      { type: "text", text: "claude-answer-marker" },
      { type: "thinking", thinking: "claude-thinking-marker", signature: "claude-signature-secret-marker" },
      { type: "redacted_thinking", data: "claude-encrypted-secret-marker" },
      { type: "tool_use", id: "read-a", name: "claude-tool-name-marker", input: { value: "claude-input-marker" } },
    ] } }),
    claude(id(5), { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "read-a", content: [{ type: "text", text: "claude-output-marker" }, { type: "image", source: { type: "base64", data: "claude-media-secret-marker" } }] },
      { type: "image", source: { type: "base64", data: "claude-media-secret-marker" } },
    ] } }),
    claude(id(5), { type: "ai-title", aiTitle: "claude-title-marker" }),
    claude(id(5), { type: "system", message: { content: { text: "claude-structured-system-marker" } } }),
    claude(id(5), { type: "summary", summary: { text: "claude-structured-summary-marker" } }),
  ]));

  service = createSearchService(config(fixtureRoot));
  const codexListing = await refresh();
  assert.deepEqual(codexListing.errors, []);
  assert.equal(codexListing.sessions.length, 4);
  assert.equal(codexListing.sessions.find((session) => session.id === id(3)).archived, false);
  assert.deepEqual((await refresh("claude")).errors, []);
  for (const query of ["later-preview-marker", "later-turn-marker", "中文全文检索", "mixedcase", "10.104.5.20", "D:\\path\\file.txt", "100%_literal", '"quoted"', "😀😃😄", "完", "%_", "system-base-marker", "developer-context-marker", "assistant-answer-marker", "readable-thinking-marker", "function-tool-name-marker", "function-input-marker", "function-output-marker", "custom-tool-name-marker", "custom-input-marker", "custom-output-marker", "metadata-title-marker", "context-cwd-marker", "turn-context-model-marker", id(1), boundaryQuery, longQuery]) {
    await hits("codex", query, [id(1)]);
  }
  for (const query of ["claude-context-marker", "claude-late-marker", "claude-answer-marker", "claude-thinking-marker", "claude-tool-name-marker", "claude-input-marker", "claude-output-marker", "claude-title-marker", "claude-model-marker", "中文全文检索", "10.104.5.20", "ClaudeFixture"]) await hits("claude", query, [id(5)]);
  for (const query of ["event-answer-marker", "event-thinking-marker", "reasoning-content-marker", "compacted-context-marker", "last-answer-marker"]) await hits("codex", query, [id(1)]);
  for (const query of ["business-signature-marker", "readable-image-caption-marker"]) await hits("codex", query, [id(1)]);
  for (const query of ["claude-structured-system-marker", "claude-structured-summary-marker"]) await hits("claude", query, [id(5)]);
  await hits("codex", "tool-image-binary-secret-marker", []);
  await hits("codex", "safe\0literal", [id(1)]); // Unsafe FTS text must fall back without dropping the hit.
  for (const query of ["encrypted-secret-marker", "media-secret-marker", "abcde", "archived-duplicate-marker"]) await hits("codex", query, []);
  for (const query of ["claude-signature-secret-marker", "claude-encrypted-secret-marker", "claude-media-secret-marker"]) await hits("claude", query, []);
  await hits("codex", "active-duplicate-marker", [id(3)]);
  await assert.rejects(() => service.search("codex", "界".repeat(257)), /256|too long|长度/i);
  await assert.rejects(() => service.search("codex", "İ".repeat(129)), /256|too long|长度/i);
  await hits("codex", "İ".repeat(128), []); // Lowercasing expands this to exactly 256 code points.
  await hits("codex", "😀".repeat(256), []); // Code points, not UTF-16 units.

  // Refresh bypasses the directory cache and invalidates cached search results.
  const beforeUpdate = (await service.search("codex", "mutable-before-marker")).generation;
  await appendFile(updateFile, jsonl([message("append-only-marker", "assistant")]));
  await refresh();
  assert.ok((await hits("codex", "append-only-marker", [id(4)])).generation > beforeUpdate);
  const priorStats = await stat(updateFile);
  await sleep(15);
  await writeFile(updateFile, (await readFile(updateFile, "utf8")).replace("mutable-before-marker", "mutable-after--marker"));
  await utimes(updateFile, priorStats.atime, priorStats.mtime);
  assert.equal((await stat(updateFile)).size, priorStats.size, "replacement fixture has the same size");
  await refresh();
  await hits("codex", "mutable-before-marker", []);
  await hits("codex", "mutable-after--marker", [id(4)]);
  const mainFingerprint = await stat(mainFile);
  await writeFile(path.join(fixtureRoot, "codex", "session_index.jsonl"), jsonl([{ id: id(1), thread_name: "renamed-title-marker", updated_at: timestamp }]));
  await refresh();
  assert.equal((await stat(mainFile)).mtimeMs, mainFingerprint.mtimeMs, "title changes leave the rollout untouched");
  await hits("codex", "renamed-title-marker", [id(1)]);
  await hits("codex", "metadata-title-marker", []);
  await rm(updateFile);
  await refresh();
  await hits("codex", "append-only-marker", []);
  const movedPath = path.join(fixtureRoot, "codex", "archived_sessions", `moved-${id(3)}.jsonl`);
  await rename(duplicateActive, movedPath);
  const movedListing = await refresh();
  assert.equal(movedListing.sessions.find((session) => session.id === id(3)).archived, true);
  assert.equal(movedListing.sessions.filter((session) => session.id === id(3)).length, 1);

  const stableResult = await hits("codex", "10.104.5.20", [id(1)]);
  await service.close();
  service = createSearchService(config(fixtureRoot));
  await refresh();
  const restartedResult = await hits("codex", "10.104.5.20", [id(1)]);
  assert.equal(restartedResult.generation, stableResult.generation, "unchanged files reuse the persisted generation");
  assert.equal(service.status("codex").rebuiltFiles, 0, "a restart does not reparse unchanged logs");
  assert.ok(service.status("codex").reusedFiles >= 3);
  await assert.rejects(() => service.search("unknown-source", "test"), /source/i);
  const competingWriter = createSearchService(config(fixtureRoot));
  try {
    await assert.rejects(() => competingWriter.list("codex"), (error) => error.statusCode === 409 && /already in use/i.test(error.message));
  } finally {
    await competingWriter.close();
  }
  await hits("codex", "10.104.5.20", [id(1)]); // A rejected contender must not release the live writer's lease.

  await service.close();
  const otherRoot = path.join(fixtureRoot, "other-codex");
  await mkdir(path.join(otherRoot, "sessions"), { recursive: true });
  await writeFile(path.join(otherRoot, "sessions", `${id(1)}.jsonl`), jsonl([codex("session_meta", { id: id(1) }), message("other-root-isolation-marker")]));
  const otherConfig = config(fixtureRoot);
  otherConfig.sources.codex.root = otherRoot;
  service = createSearchService(otherConfig);
  await refresh();
  await hits("codex", "other-root-isolation-marker", [id(1)]);
  await hits("codex", "10.104.5.20", []);
  await service.close();
  service = createSearchService(config(fixtureRoot));
  await refresh();
  await hits("codex", "other-root-isolation-marker", []);
  await hits("codex", "10.104.5.20", [id(1)]);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() => service.search("codex", "a", { signal: cancelled.signal }), /abort|cancel/i);
  const cancellation = new AbortController();
  const pending = service.search("codex", "x", { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(() => pending, /abort|cancel/i);
  assert.equal((await hits("codex", "10.104.5.20", [id(1)])).errors.length, 0, "cancellation is not a persistent read error");

  await service.close();
  service = null;
  const recoveryFile = await writeCodex(6, [message("stable-recovery-marker")]);
  service = createSearchService(config(fixtureRoot));
  await refresh();
  await service.close();
  service = null;
  const interruptionRecord = jsonl([message(`${"z".repeat(1200)}interrupted-rebuild-marker`, "assistant")]);
  await appendFile(recoveryFile, interruptionRecord.repeat(20000) + jsonl([message("large-file-tail-marker", "assistant")]));
  await interruptBuild();
  assert.ok((await readdir(path.join(fixtureRoot, "cache"))).some((file) => file.endsWith(".sqlite.lock")), "abrupt termination leaves a dead-process lease to recover");
  service = createSearchService(config(fixtureRoot));
  await refresh();
  await hits("codex", "stable-recovery-marker", [id(6)]);
  await hits("codex", "interrupted-rebuild-marker", [id(6)]);
  await hits("codex", "large-file-tail-marker", [id(6)]);
  const scanCancellation = new AbortController();
  const scan = service.search("codex", "Ω", { signal: scanCancellation.signal });
  await sleep(5); // Let the read worker enter its 20,000-record fallback scan.
  scanCancellation.abort();
  await assert.rejects(() => scan, /abort|cancel/i);
  assert.equal((await hits("codex", "stable-recovery-marker", [id(6)])).errors.length, 0);
  await writeFile(recoveryFile, jsonl([codex("session_meta", { id: id(6), cwd: "D:\\recovery" }), message("truncated-replacement-marker")]));
  await refresh();
  await hits("codex", "interrupted-rebuild-marker", []);
  await hits("codex", "large-file-tail-marker", []);
  await hits("codex", "truncated-replacement-marker", [id(6)]);

  const corruptFile = await writeCodex(7, ["{broken JSON record", message("surviving-corrupt-record-marker")]);
  const warningListing = await refresh();
  assert.ok(warningListing.errors.length > 0, "corrupt records are reported");
  const warningResult = await hits("codex", "surviving-corrupt-record-marker", [id(7)]);
  assert.equal(warningResult.complete, false);
  assert.ok(warningResult.errors.length > 0, "search discloses incomplete results");
  const reusedWarningListing = await refresh();
  assert.ok(reusedWarningListing.errors.length > 0, "reused-file warnings remain visible");
  assert.equal(service.status("codex").rebuiltFiles, 0);
  await service.close();
  service = createSearchService(config(fixtureRoot));
  await refresh();
  assert.equal((await hits("codex", "surviving-corrupt-record-marker", [id(7)])).complete, false, "warnings survive process restart");
  await writeFile(corruptFile, (await readFile(corruptFile, "utf8")).replace("{broken JSON record\n", ""));
  await refresh();
  const repairedResult = await hits("codex", "surviving-corrupt-record-marker", [id(7)]);
  assert.equal(repairedResult.complete, true);
  assert.equal(repairedResult.errors.length, 0, "repairing a corrupt record clears warnings");
  console.log(`Full-text search tests passed (${assertions} query assertions; synthetic logs only).`);
} finally {
  if (service) await service.close();
  // Only delete the absolute directory returned by mkdtemp above.
  if (path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(fixtureRoot).startsWith("session-viewer-fulltext-test-")) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
