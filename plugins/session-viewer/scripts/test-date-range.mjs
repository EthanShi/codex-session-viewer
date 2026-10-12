import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { normalizeDateRange, rangeKey, recentDateRange } from "../assets/date-range.mjs";
import { createSearchService } from "./lib/search-service.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (n) => `bbbbbbbb-2222-4333-8444-${String(n).padStart(12, "0")}`;
const records = (values) => values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n") + "\n";
const message = (text) => ({ timestamp: "2020-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const days7 = recentDateRange(7);
const days30 = recentDateRange(30);

if (process.argv[2] === "--calendar") {
  const range = recentDateRange(7, { now: new Date(process.argv[3]) });
  console.log(JSON.stringify({ from: range.from, to: range.to, timeZone: range.timeZone, start: new Date(range.startMs).toISOString(), end: new Date(range.endExclusiveMs).toISOString(), hours: (range.endExclusiveMs - range.startMs) / 3600000 }));
  process.exit(0);
}

async function calendarCase(tz, now, expected) {
  const child = spawn(process.execPath, [scriptPath, "--calendar", now], { env: { ...process.env, TZ: tz }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { ...expected, timeZone: tz });
}

await calendarCase("Asia/Singapore", "2026-10-12T01:30:00Z", { from: "2026-10-06", to: "2026-10-12", start: "2026-10-05T16:00:00.000Z", end: "2026-10-12T16:00:00.000Z", hours: 168 });
await calendarCase("America/New_York", "2026-10-12T01:30:00Z", { from: "2026-10-05", to: "2026-10-11", start: "2026-10-05T04:00:00.000Z", end: "2026-10-12T04:00:00.000Z", hours: 168 });
await calendarCase("America/New_York", "2026-03-09T04:30:00Z", { from: "2026-03-03", to: "2026-03-09", start: "2026-03-03T05:00:00.000Z", end: "2026-03-10T04:00:00.000Z", hours: 167 });
await calendarCase("America/New_York", "2026-11-02T05:30:00Z", { from: "2026-10-27", to: "2026-11-02", start: "2026-10-27T04:00:00.000Z", end: "2026-11-03T05:00:00.000Z", hours: 169 });
await calendarCase("UTC", "2024-03-01T12:00:00Z", { from: "2024-02-24", to: "2024-03-01", start: "2024-02-24T00:00:00.000Z", end: "2024-03-02T00:00:00.000Z", hours: 168 });
assert.equal(normalizeDateRange({ from: "2024-02-01", to: "2024-03-01" }, { timeZone: "UTC" }).endExclusiveMs, Date.UTC(2024, 2, 2));
for (const range of [{ from: "2024-02-01", to: "2024-03-02" }, { from: "2025-02-29", to: "2025-03-01" }, { from: "2026-02-02", to: "2026-02-01" }, { from: "2026-02-01" }, { to: "2026-02-01" }, { from: "2026-2-01", to: "2026-02-01" }]) assert.throws(() => normalizeDateRange(range), (error) => error.statusCode === 400);
assert.throws(() => recentDateRange(31), (error) => error.statusCode === 400);
assert.notEqual(rangeKey(normalizeDateRange({ from: "2026-10-12", to: "2026-10-12" }, { timeZone: "UTC" })), rangeKey(normalizeDateRange({ from: "2026-10-12", to: "2026-10-12" }, { timeZone: "Asia/Singapore" })));

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "session-viewer-date-range-test-"));
let service;
let assertions = 0;
function config(root = fixtureRoot) {
  return { sources: { codex: { root: path.join(root, "codex") }, claude: { root: path.join(root, "claude") } }, cacheRoot: path.join(root, "cache") };
}
function localDay(daysAgo = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
}
function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
async function prepare(root = fixtureRoot) {
  await Promise.all([mkdir(path.join(root, "codex", "sessions"), { recursive: true }), mkdir(path.join(root, "claude", "projects", "fixture"), { recursive: true })]);
}
async function writeSession(n, modifiedAt, additional = [], root = fixtureRoot) {
  const file = path.join(root, "codex", "sessions", `${id(n)}.jsonl`);
  await writeFile(file, records([{ timestamp: "2099-01-01T00:00:00Z", type: "session_meta", payload: { id: id(n), cwd: "D:\\range-fixture" } }, message(`range-shared-marker unique-${n}-marker`), ...additional]));
  await utimes(file, modifiedAt, modifiedAt);
  return file;
}
function inspect(sql, ...args) {
  const db = new DatabaseSync(service.databasePath, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
const fileState = (file) => inspect("SELECT * FROM files WHERE path=?", file)[0];
const bodyCount = () => inspect("SELECT count(*) AS count FROM chunks")[0].count;
async function listing(range = days7) {
  return await service.list("codex", { range, refresh: true });
}
async function hits(range, query, expected) {
  const result = await service.search("codex", query, { range });
  assert.deepEqual(result.matches.map((match) => match.id).sort(), expected.map(id).sort(), `${query}: ${range.from}..${range.to}`);
  assert.deepEqual(result.range, { from: range.from, to: range.to, timeZone });
  assertions += 1;
  return result;
}
async function waitForStage() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (inspect("SELECT count(*) AS count FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.generation!=f.active_generation")[0].count > 0) return;
    await pause(2);
  }
  throw new Error("Body indexing never committed a staging batch");
}

async function seedV1Cache(root, file) {
  const options = config(root);
  await mkdir(options.cacheRoot, { recursive: true });
  const identity = Object.entries(options.sources).sort(([left], [right]) => left.localeCompare(right)).map(([source, value]) => [source, process.platform === "win32" ? value.root.toLowerCase() : value.root]);
  const cacheKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
  const databasePath = path.join(options.cacheRoot, `index-v1-${cacheKey}.sqlite`);
  const stats = await stat(file);
  const fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  const sourceKey = `codex:${process.platform === "win32" ? options.sources.codex.root.toLowerCase() : options.sources.codex.root}`;
  const summary = { id: id(64), title: "Migration fixture", preview: "Migration fixture", timestamp: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z", cwd: "D:\\range-fixture", model: "fixture", archived: false, size: stats.size, filePath: file, turnCount: 1, systemPromptCount: 0, systemPromptCharacters: 0, estimatedSystemPromptTokens: 0 };
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE sources(source_key TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,scanned_at TEXT,index_fingerprint TEXT,errors_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE files(id INTEGER PRIMARY KEY,source_key TEXT NOT NULL,path TEXT NOT NULL,session_id TEXT,archived INTEGER NOT NULL DEFAULT 0,fingerprint TEXT,active_generation INTEGER NOT NULL DEFAULT 0,visible INTEGER NOT NULL DEFAULT 0,summary_json TEXT,fallback_title TEXT,fallback_updated_at TEXT,errors_json TEXT NOT NULL DEFAULT '[]',UNIQUE(source_key,path));
      CREATE TABLE chunks(id INTEGER PRIMARY KEY,file_id INTEGER NOT NULL,generation INTEGER NOT NULL,block_no INTEGER NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,search_text TEXT NOT NULL);
      CREATE VIRTUAL TABLE chunk_fts USING fts5(search_text,content='chunks',content_rowid='id',tokenize='trigram case_sensitive 1',detail=none,columnsize=0);
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunk_fts(rowid,search_text) VALUES(new.id,new.search_text); END;
      PRAGMA user_version=1;
    `);
    db.prepare("INSERT INTO sources(source_key,generation) VALUES(?,7)").run(sourceKey);
    db.prepare("INSERT INTO files(id,source_key,path,session_id,fingerprint,active_generation,visible,summary_json,fallback_title,fallback_updated_at) VALUES(1,?,?,?,?,11,1,?,?,?)").run(sourceKey, file, id(64), fingerprint, JSON.stringify(summary), summary.title, summary.updatedAt);
    db.prepare("INSERT INTO chunks VALUES(1007,1,11,0,0,'user','migration-body-marker','migration-body-marker')").run();
  } finally { db.close(); }
  return databasePath;
}

try {
  await prepare();
  const files = new Map();
  files.set(1, await writeSession(1, localDay()));
  files.set(2, await writeSession(2, new Date(days7.startMs)));
  files.set(3, await writeSession(3, new Date(days7.endExclusiveMs - 1)));
  files.set(4, await writeSession(4, new Date(days7.startMs - 1)));
  files.set(5, await writeSession(5, new Date(days30.startMs)));
  files.set(6, await writeSession(6, new Date(days30.startMs - 1)));
  const outside = await writeSession(7, localDay(40), ["{malformed ancient record " + "X".repeat(12 * 1024 * 1024), message("ancient-readable-marker")]);
  const future = await writeSession(9, localDay(-1));
  const claudeFile = path.join(fixtureRoot, "claude", "projects", "fixture", `${id(8)}.jsonl`);
  await writeFile(claudeFile, records([{ type: "user", timestamp: "2099-01-01T00:00:00Z", sessionId: id(8), message: { role: "user", content: "claude-mtime-marker" } }]));
  await writeFile(path.join(fixtureRoot, "codex", "session_index.jsonl"), records([
    { id: id(1), thread_name: "Middle mtime", updated_at: "2030-01-01T00:00:00Z" },
    { id: id(2), thread_name: "Oldest mtime", updated_at: "2099-01-01T00:00:00Z" },
    { id: id(3), thread_name: "Newest mtime", updated_at: "2000-01-01T00:00:00Z" },
  ]));

  service = createSearchService(config());
  const first = await listing();
  assert.deepEqual(first.sessions.map((session) => session.id).sort(), [id(1), id(2), id(3)]);
  assert.deepEqual(first.sessions.map((session) => session.id), [id(3), id(1), id(2)], "mtime ordering overrides reversed title-index timestamps");
  assert.deepEqual(first.errors, []);
  assert.equal(bodyCount(), 0, "first list is summary-only and inserts no chunks");
  assert.ok(first.sessions.every((session) => session.logModifiedAt && Number.isFinite(Date.parse(session.logModifiedAt))));
  assert.equal(fileState(outside).summary_json, null, "outside-range malformed file is not parsed");
  assert.equal(fileState(outside).body_fingerprint, null);
  assert.equal(fileState(future).summary_json, null, "future mtime is outside the selected calendar range");
  assert.ok(fileState(files.get(1)).summary_fingerprint);
  assert.equal(fileState(files.get(1)).body_fingerprint, null);
  const firstSearch = await hits(days7, "range-shared-marker", [1, 2, 3]);
  assert.deepEqual(firstSearch.matches.map((match) => match.id), [id(3), id(1), id(2)], "search uses the same mtime ordering as the list");
  const bodyState7 = fileState(files.get(2));
  assert.ok(bodyState7.body_fingerprint);
  assert.equal(inspect("SELECT count(*) AS count FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.path=?", outside)[0].count, 0);
  const claudeList = await service.list("claude", { range: days7 });
  assert.equal(claudeList.sessions.length, 1);
  assert.equal((await service.search("claude", "claude-mtime-marker", { range: days7 })).matches[0].id, id(8));
  const duplicateDirectory = path.join(fixtureRoot, "claude", "projects", "duplicates");
  await mkdir(duplicateDirectory);
  const duplicateClaude = path.join(duplicateDirectory, `${id(8)}.jsonl`);
  await writeFile(duplicateClaude, records([{ type: "user", timestamp: "2010-01-01T00:00:00Z", sessionId: id(8), message: { role: "user", content: "claude-newest-file-marker" } }]));
  await utimes(duplicateClaude, new Date(days7.endExclusiveMs - 1), new Date(days7.endExclusiveMs - 1));
  const duplicateListing = await service.list("claude", { range: days7, refresh: true });
  assert.equal(duplicateListing.sessions.length, 1);
  assert.equal(duplicateListing.sessions[0].filePath, duplicateClaude, "Claude duplicate IDs select the newest mtime instead of message timestamp");
  assert.equal((await service.search("claude", "claude-mtime-marker", { range: days7 })).matches.length, 0);
  assert.equal((await service.search("claude", "claude-newest-file-marker", { range: days7 })).matches[0].id, id(8), "listing and search use the same duplicate winner");

  const thirtyList = await listing(days30);
  assert.deepEqual(thirtyList.sessions.map((session) => session.id).sort(), [1, 2, 3, 4, 5].map(id));
  assert.deepEqual(thirtyList.errors, []);
  assert.equal(fileState(files.get(4)).body_fingerprint, null, "expanded-range listing still defers new bodies");
  await hits(days30, "range-shared-marker", [1, 2, 3, 4, 5]);
  assert.equal(fileState(files.get(2)).active_generation, bodyState7.active_generation, "overlapping ranges reuse unchanged bodies");
  await hits(days7, "range-shared-marker", [1, 2, 3]);
  assert.equal(fileState(files.get(4)).body_fingerprint, fileState(files.get(4)).observed_fingerprint, "narrowing the range retains reusable older bodies");
  const invalid31 = { from: localDate(localDay(30)), to: localDate(localDay()) };
  await assert.rejects(() => service.list("codex", { range: invalid31 }), (error) => error.statusCode === 400);
  await assert.rejects(() => service.search("codex", "marker", { range: invalid31 }), (error) => error.statusCode === 400);

  const oldBodyState = fileState(files.get(2));
  await appendFile(files.get(2), records([message("newly-appended-range-marker")]));
  await listing();
  const summaryOnlyState = fileState(files.get(2));
  assert.notEqual(summaryOnlyState.summary_fingerprint, oldBodyState.summary_fingerprint);
  assert.equal(summaryOnlyState.body_fingerprint, oldBodyState.body_fingerprint, "summary refresh does not publish stale body as current");
  assert.equal(summaryOnlyState.active_generation, oldBodyState.active_generation);
  await hits(days7, "newly-appended-range-marker", [2]);
  assert.equal(fileState(files.get(2)).body_fingerprint, fileState(files.get(2)).observed_fingerprint);

  const beforeMove = fileState(files.get(1));
  await utimes(files.get(1), localDay(10), localDay(10));
  await listing();
  await hits(days7, "unique-1-marker", []);
  assert.equal(fileState(files.get(1)).body_fingerprint, beforeMove.body_fingerprint, "moving out of range does not rebuild the body");
  await hits(days30, "unique-1-marker", [1]);
  await utimes(files.get(1), localDay(), localDay());
  await listing();
  await hits(days7, "unique-1-marker", [1]); // Previously cached empty result must be invalidated.

  const ancientRange = { from: localDate(localDay(41)), to: localDate(localDay(40)) };
  const oldListing = await listing(ancientRange);
  assert.equal(oldListing.sessions[0].id, id(7));
  assert.ok(oldListing.errors.length > 0, "malformed warning appears when the file is actually selected");
  const oldHits = await hits(ancientRange, "ancient-readable-marker", [7]);
  assert.equal(oldHits.complete, false);
  const recentHits = await hits(days7, "range-shared-marker", [1, 2, 3]);
  assert.deepEqual(recentHits.errors, [], "cached errors from outside range are not exposed in recent results");
  assert.equal(recentHits.complete, true);

  const bigRecord = records([message("z".repeat(1200) + "shared-build-marker")]);
  const sharedFile = await writeSession(10, localDay(), [bigRecord.repeat(15000)]);
  await listing();
  const one = new AbortController();
  const two = new AbortController();
  const firstWaiter = service.search("codex", "shared-build-marker", { range: days7, signal: one.signal });
  const secondWaiter = service.search("codex", "shared-build-marker", { range: days7, signal: two.signal });
  await waitForStage();
  one.abort();
  await assert.rejects(() => firstWaiter, /abort|cancel/i);
  assert.deepEqual((await secondWaiter).matches.map((match) => match.id), [id(10)], "cancelling one waiter does not stop a shared build");
  assert.equal(fileState(sharedFile).body_fingerprint, fileState(sharedFile).observed_fingerprint);

  const cancelledFile = await writeSession(11, localDay(), [bigRecord.repeat(15000)]);
  await listing();
  const cancelledOne = new AbortController();
  const cancelledTwo = new AbortController();
  const abandonedFirst = service.search("codex", "all-waiters-abandoned", { range: days7, signal: cancelledOne.signal });
  const abandonedSecond = service.search("codex", "all-waiters-abandoned", { range: days7, signal: cancelledTwo.signal });
  await waitForStage();
  cancelledOne.abort();
  cancelledTwo.abort();
  await Promise.all([assert.rejects(() => abandonedFirst, /abort|cancel/i), assert.rejects(() => abandonedSecond, /abort|cancel/i)]);
  await listing();
  assert.equal(fileState(cancelledFile).body_fingerprint, null, "abandoned build never publishes a partial body");
  assert.equal(inspect("SELECT count(*) AS count FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.generation!=f.active_generation")[0].count, 0);
  assert.deepEqual((await hits(days7, "shared-build-marker", [10, 11])).errors, [], "cancelled indexing can be retried without a persistent error");

  await service.close();
  service = null;
  const migrationRoot = path.join(fixtureRoot, "migration");
  await prepare(migrationRoot);
  const migrationFile = await writeSession(64, localDay(25), [message("migration-body-marker")], migrationRoot);
  const legacyPath = await seedV1Cache(migrationRoot, migrationFile);
  service = createSearchService(config(migrationRoot));
  await service.list("codex", { range: days7 });
  assert.equal(service.databasePath, legacyPath, "migration reuses the v1 cache filename");
  assert.equal(inspect("PRAGMA user_version")[0].user_version, 2);
  assert.equal(bodyCount(), 1, "schema migration retains existing body chunks outside the current range");
  assert.equal(fileState(migrationFile).active_generation, 11);
  assert.equal(fileState(migrationFile).body_fingerprint, fileState(migrationFile).fingerprint);
  await hits(days30, "migration-body-marker", [64]);
  assert.equal(bodyCount(), 1, "search reuses the migrated valid body instead of rebuilding it");
  assert.equal(inspect("SELECT id FROM chunks")[0].id, 1007);
  console.log(`Date-range tests passed (${assertions} query assertions; 5 isolated timezone/calendar cases; summary/body laziness, migration and shared cancellation).`);
} finally {
  if (service) await service.close();
  if (path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(fixtureRoot).startsWith("session-viewer-date-range-test-")) await rm(fixtureRoot, { recursive: true, force: true });
}
