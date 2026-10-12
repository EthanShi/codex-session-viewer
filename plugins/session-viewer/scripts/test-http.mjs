import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, appendFile, utimes, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedRuntime } from "./lib/runtime.mjs";
import { recentDateRange } from "../assets/date-range.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "session-viewer-http-test-"));
const sessionId = "12345678-1234-4234-8234-123456789012";
let child;
try {
  await assert.rejects(assertSupportedRuntime("18.20.0"), /22\.13/);
  await assert.rejects(assertSupportedRuntime("22.12.0"), /22\.13/);
  await assertSupportedRuntime();
  const codexRoot = path.join(root, "codex");
  const claudeRoot = path.join(root, "claude");
  await Promise.all([mkdir(path.join(codexRoot, "sessions"), { recursive: true }), mkdir(claudeRoot)]);
  const records = [
    { type: "session_meta", payload: { id: sessionId, cwd: "D:\\http-fixture", base_instructions: "Readable HTTP instructions" } },
    { type: "event_msg", payload: { type: "user_message", message: "HTTP fixture query" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "Server reachable at 10.104.5.20" } },
  ];
  await writeFile(path.join(codexRoot, "sessions", `rollout-${sessionId}.jsonl`), records.map(JSON.stringify).join("\n") + "\n");
  const olderId = "87654321-4321-4321-8321-210987654321";
  const olderPath = path.join(codexRoot, "sessions", `rollout-${olderId}.jsonl`);
  const olderRecords = [
    { type: "session_meta", timestamp: "2020-01-01T00:00:00Z", payload: { id: olderId, cwd: "D:\\http-fixture" } },
    { type: "event_msg", payload: { type: "user_message", message: "Older month-only searchable marker" } },
  ];
  await writeFile(olderPath, olderRecords.map(JSON.stringify).join("\n") + "\n");
  const olderTime = new Date();
  olderTime.setDate(olderTime.getDate() - 14);
  await utimes(olderPath, olderTime, olderTime);
  const excludedPath = path.join(codexRoot, "sessions", "rollout-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl");
  await writeFile(excludedPath, "deliberately malformed old log\n".repeat(10000));
  const excludedTime = new Date();
  excludedTime.setDate(excludedTime.getDate() - 90);
  await utimes(excludedPath, excludedTime, excludedTime);
  child = spawn(process.execPath, [path.join(directory, "server.mjs"), "--port", "0", "--codex-root", codexRoot, "--claude-root", claudeRoot, "--cache-root", path.join(root, "cache")], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 15000);
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/Session Viewer: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${stderr}`)); });
  });
  const get = async (route, options) => {
    const response = await fetch(`${origin}${route}`, options);
    if (response.status !== 202) return response;
    const operation = await response.json();
    while (true) {
      const polled = await fetch(`${origin}${operation.statusUrl}`);
      const value = await polled.json();
      if (!polled.ok) return new Response(JSON.stringify(value), { status: polled.status, headers: polled.headers });
      if (!value.pending) return new Response(JSON.stringify(value.result), { status: 200, headers: polled.headers });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const health = await (await get("/api/health")).json();
  assert.equal(health.searchVersion, 2);
  assert.equal(health.rangeSearch, true);
  assert.equal(health.maxRangeDays, 30);
  assert.ok(health.memoryRssBytes > 0);
  assert.equal(health.sources.codex.root, codexRoot);
  assert.equal((await get("/api/sources/unknown/search?q=test")).status, 404);
  assert.equal((await get("/api/sources/codex/search?q=" )).status, 400);
  assert.equal((await get(`/api/sources/codex/search?q=${"a".repeat(257)}`)).status, 400);
  assert.equal((await get("/api/sources/codex/search?q=test", { method: "POST" })).status, 405);
  for (const suffix of ["from=2026-10-01", "to=2026-10-12", "from=2026-02-30&to=2026-03-01", "from=2026-10-12&to=2026-10-01", "from=2026-01-01&to=2026-01-31"]) {
    for (const route of ["sessions", `sessions/${sessionId}`, "search?q=test&", "search/status"]) {
      const separator = route.includes("?") ? "" : "?";
      assert.equal((await get(`/api/sources/codex/${route}${separator}${suffix}`)).status, 400, `${route}: ${suffix}`);
    }
  }
  const listingResponse = await get("/api/sources/codex/sessions?refresh=1");
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.deepEqual(listing.sessions.map((session) => session.id), [sessionId]);
  assert.equal(listing.complete, true, "excluded malformed body must not be read");
  assert.deepEqual({ from: listing.range.from, to: listing.range.to }, (({ from, to }) => ({ from, to }))(recentDateRange(7)));
  assert.ok(listing.range.timeZone);
  assert.ok(listing.sessions[0].logModifiedAt);
  const sqliteName = (await readdir(path.join(root, "cache"))).find((name) => name.endsWith(".sqlite"));
  const cache = new DatabaseSync(path.join(root, "cache", sqliteName), { readOnly: true });
  try { assert.equal(cache.prepare("SELECT count(*) n FROM chunks").get().n, 0, "list must not build full-text chunks"); }
  finally { cache.close(); }
  const oldDetail = await (await get(`/api/sources/codex/sessions/${olderId}`)).json();
  assert.equal(oldDetail.summary.id, olderId, "direct detail works without loading another range");
  await appendFile(path.join(codexRoot, "sessions", `rollout-${sessionId}.jsonl`), JSON.stringify({
    type: "response_item", payload: { type: "function_call_output", call_id: "call-2", output: "Fresh detail update" },
  }) + "\n");
  const freshDetail = await (await get(`/api/sources/codex/sessions/${sessionId}`)).json();
  assert.ok(freshDetail.summary.size > listing.sessions[0].size, "detail refreshes the selected file despite the directory TTL");
  assert.match(JSON.stringify(freshDetail.turns), /Fresh detail update/);
  const detailCache = new DatabaseSync(path.join(root, "cache", sqliteName), { readOnly: true });
  try { assert.equal(detailCache.prepare("SELECT count(*) n FROM chunks").get().n, 0, "details must not build full-text chunks"); }
  finally { detailCache.close(); }
  const searchResponse = await get("/api/sources/codex/search?q=10.104.5.20");
  assert.equal(searchResponse.status, 200);
  const result = await searchResponse.json();
  assert.equal(result.complete, true);
  assert.deepEqual(result.matches.map((match) => match.id), [sessionId]);
  assert.match(result.matches[0].snippet, /10\.104\.5\.20/);
  assert.deepEqual(result.range, listing.range);
  const status = await (await get("/api/sources/codex/search/status")).json();
  assert.equal(status.phase, "ready");
  assert.equal(status.generation, result.generation);
  assert.deepEqual(status.range, listing.range);
  const month = recentDateRange(30);
  const monthSuffix = `from=${month.from}&to=${month.to}`;
  const monthListing = await (await get(`/api/sources/codex/sessions?${monthSuffix}`)).json();
  assert.deepEqual(new Set(monthListing.sessions.map((session) => session.id)), new Set([sessionId, olderId]));
  const monthSearch = await (await get(`/api/sources/codex/search?q=month-only&${monthSuffix}`)).json();
  assert.deepEqual(monthSearch.matches.map((match) => match.id), [olderId]);
  assert.equal(monthSearch.range.from, month.from);
  const weekSearch = await (await get("/api/sources/codex/search?q=month-only")).json();
  assert.equal(weekSearch.matches.length, 0, "cached body from another range must not leak");
  const detailResponse = await get(`/api/sources/codex/sessions/${sessionId}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.summary.id, sessionId);
  assert.equal(detail.turns[0].query, "HTTP fixture query");
  assert.equal((await get("/api/sources/codex/sessions/invalid!id")).status, 400);
  assert.equal((await get("/api/sources/codex/sessions/nonexistent")).status, 404);
  // A past range must open its selected duplicate, even when a newer or active
  // copy of the same ID exists outside that range. ID-only reads stay compatible.
  const duplicateCodexId = "22222222-2222-4222-8222-222222222222";
  const duplicateClaudeId = "33333333-3333-4333-8333-333333333333";
  const archivedDirectory = path.join(codexRoot, "archived_sessions");
  const olderClaudeDirectory = path.join(claudeRoot, "projects", "older");
  const newerClaudeDirectory = path.join(claudeRoot, "projects", "newer");
  await Promise.all([mkdir(archivedDirectory), mkdir(olderClaudeDirectory, { recursive: true }), mkdir(newerClaudeDirectory, { recursive: true })]);
  const pastTime = new Date();
  pastTime.setDate(pastTime.getDate() - 45);
  pastTime.setHours(12, 0, 0, 0);
  const pastDay = recentDateRange(1, { now: pastTime }).from;
  const pastSuffix = new URLSearchParams({ from: pastDay, to: pastDay });
  const oldCodexPath = path.join(archivedDirectory, `rollout-${duplicateCodexId}.jsonl`);
  const newCodexPath = path.join(codexRoot, "sessions", `rollout-${duplicateCodexId}.jsonl`);
  const oldClaudePath = path.join(olderClaudeDirectory, `${duplicateClaudeId}.jsonl`);
  const newClaudePath = path.join(newerClaudeDirectory, `${duplicateClaudeId}.jsonl`);
  for (const [filePath, marker] of [[oldCodexPath, "old archived duplicate"], [newCodexPath, "new active duplicate"]]) {
    await writeFile(filePath, [
      { type: "session_meta", payload: { id: duplicateCodexId, cwd: "D:\\http-duplicate-fixture" } },
      { type: "event_msg", payload: { type: "user_message", message: marker } },
    ].map(JSON.stringify).join("\n") + "\n");
  }
  for (const [filePath, marker] of [[oldClaudePath, "old Claude duplicate"], [newClaudePath, "new Claude duplicate"]]) {
    await writeFile(filePath, JSON.stringify({ type: "user", sessionId: duplicateClaudeId, uuid: "user-1", timestamp: "2020-01-01T00:00:00Z", message: { role: "user", content: marker } }) + "\n");
  }
  await Promise.all([utimes(oldCodexPath, pastTime, pastTime), utimes(oldClaudePath, pastTime, pastTime)]);
  for (const [source, id, oldPath, newPath, oldMarker, newMarker] of [
    ["codex", duplicateCodexId, oldCodexPath, newCodexPath, "old archived duplicate", "new active duplicate"],
    ["claude", duplicateClaudeId, oldClaudePath, newClaudePath, "old Claude duplicate", "new Claude duplicate"],
  ]) {
    const selected = await (await get(`/api/sources/${source}/sessions?refresh=1&${pastSuffix}`)).json();
    assert.deepEqual(selected.sessions.map((session) => session.id), [id]);
    assert.equal(selected.sessions[0].filePath, oldPath);
    const scopedDetail = await (await get(`/api/sources/${source}/sessions/${id}?${pastSuffix}`)).json();
    assert.equal(scopedDetail.summary.filePath, oldPath, `${source} detail must open the range's winner`);
    assert.equal(scopedDetail.turns[0].query, oldMarker);
    const unscopedDetail = await (await get(`/api/sources/${source}/sessions/${id}`)).json();
    assert.equal(unscopedDetail.summary.filePath, newPath, `${source} ID-only details remain compatible`);
    assert.equal(unscopedDetail.turns[0].query, newMarker);
    assert.equal((await get(`/api/sources/${source}/sessions/${id}?from=2000-01-01&to=2000-01-01`)).status, 404);
  }
  const duplicateCache = new DatabaseSync(path.join(root, "cache", sqliteName), { readOnly: true });
  try { assert.equal(duplicateCache.prepare("SELECT count(*) n FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.session_id IN (?,?)").get(duplicateCodexId, duplicateClaudeId).n, 0, "scoped duplicate details must not build body chunks"); }
  finally { duplicateCache.close(); }
  for (const route of ["/", "/app.js", "/app.css", "/search-controller.mjs", "/fetch-api.mjs", "/date-range.mjs"]) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  }
  assert.equal((await get("/lib/search-store.mjs")).status, 404);
  console.log("HTTP, detail worker, capability, and runtime tests passed.");
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  const target = path.resolve(root);
  assert.ok(target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}session-viewer-http-test-`));
  await rm(target, { recursive: true, force: true });
}
