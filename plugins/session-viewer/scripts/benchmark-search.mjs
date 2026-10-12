#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { Agent, get as httpGet } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { recentDateRange } from "../assets/date-range.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
function positiveInteger(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
if (args.includes("--help")) {
  console.log("Usage: node benchmark-search.mjs [--sessions 1000] [--mib 1024] [--queries 20] [--retain]\nMeasures independent cold caches for 7 and 30 local calendar days against a corpus spread over 90 days.\nFor a 5 GiB corpus use --mib 5120; for a smoke run use --sessions 100 --mib 64.\n--queries is the number of distinct IP and Chinese queries. --retain keeps the synthetic logs and cache.");
  process.exit(0);
}
const sessions = positiveInteger("--sessions", 1000);
const mib = positiveInteger("--mib", 1024);
const queryCount = positiveInteger("--queries", 20);
const retain = args.includes("--retain");
const root = await mkdtemp(path.join(os.tmpdir(), "session-viewer-search-benchmark-"));
const codexRoot = path.join(root, "codex");
const claudeRoot = path.join(root, "claude");
let cacheRoot;
const runtimeRoot = path.join(root, "runtime");
const httpAgent = new Agent({ keepAlive: true, maxSockets: 16 });
let healthTimes = [];
let maxRssBytes = 0;
let server;
let activeRange;
let auditEnvironment;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionId = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, "0")}`;
const ip = (n) => `10.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`;
const chinese = (n) => `中文精准全文检索编号${n}结束`;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)].toFixed(2));
}
function timingSummary(values) {
  return { samples: values.length, p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), maxMs: percentile(values, 100) };
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

async function instrumentSnapshot() {
  const libraryRoot = path.join(runtimeRoot, "scripts", "lib");
  // This wrapper exists only in the temporary benchmark snapshot. Selected
  // paths incur one Set.has lookup; actual outside reads are audited on open
  // and close using the stream's raw filesystem byte counter.
  await writeFile(path.join(libraryRoot, "benchmark-read-audit.mjs"), `
import { appendFileSync, createReadStream as nativeCreateReadStream, readFileSync } from "node:fs";
const outsidePaths = new Set(JSON.parse(readFileSync(process.env.SESSION_VIEWER_BENCHMARK_OUTSIDE_PATHS, "utf8")));
const auditPath = process.env.SESSION_VIEWER_BENCHMARK_READ_AUDIT;
function record(value) { appendFileSync(auditPath, JSON.stringify(value) + "\\n"); }
export function createReadStream(filePath, options) {
  const input = nativeCreateReadStream(filePath, options);
  if (outsidePaths.has(filePath)) {
    input.once("open", () => record({ filePath, opened: true }));
    input.once("close", () => record({ filePath, bytesRead: input.bytesRead || 0 }));
  }
  return input;
}
`);
  for (const filename of ["session-parser.mjs", "claude-session-parser.mjs"]) {
    const target = path.join(libraryRoot, filename);
    const content = await readFile(target, "utf8");
    const original = 'import { createReadStream } from "node:fs";';
    assert.equal(content.split(original).length, 2, `Audit must wrap exactly one createReadStream import in ${filename}`);
    await writeFile(target, content.replace(original, 'import { createReadStream } from "./benchmark-read-audit.mjs";'));
  }
}

async function prepareReadAudit(name, outsideFiles) {
  const outsidePath = path.join(root, `${name}-outside-paths.json`);
  const auditPath = path.join(root, `${name}-read-audit.jsonl`);
  await Promise.all([writeFile(outsidePath, JSON.stringify(outsideFiles)), writeFile(auditPath, "")]);
  return {
    SESSION_VIEWER_BENCHMARK_OUTSIDE_PATHS: outsidePath,
    SESSION_VIEWER_BENCHMARK_READ_AUDIT: auditPath,
  };
}

async function readAudit(environment) {
  const records = (await readFile(environment.SESSION_VIEWER_BENCHMARK_READ_AUDIT, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return {
    outsideRangeBodyOpenedFiles: new Set(records.filter((record) => record.opened).map((record) => record.filePath)).size,
    outsideRangeBodyReadBytes: records.reduce((total, record) => total + (record.bytesRead || 0), 0),
  };
}

async function verifyReadAudit() {
  const codexFixture = path.join(root, "audit-codex.jsonl");
  const claudeFixture = path.join(root, "audit-claude.jsonl");
  const id = sessionId(0);
  const codexText = JSON.stringify({ type: "session_meta", payload: { id, timestamp: "2020-01-01T00:00:00Z", cwd: "D:\\audit" } }) + "\n"
    + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "中文 audit counterexample" } }) + "\n";
  const claudeText = JSON.stringify({ type: "user", sessionId: id, timestamp: "2020-01-01T00:00:00Z", message: { role: "user", content: "中文 audit counterexample" } }) + "\n";
  await Promise.all([writeFile(codexFixture, codexText), writeFile(claudeFixture, claudeText)]);
  const environment = await prepareReadAudit("self-test", [codexFixture, claudeFixture]);
  const childScript = path.join(runtimeRoot, "scripts", "verify-read-audit.mjs");
  await writeFile(childScript, `
import { summarizeFile as summarizeCodex } from "./lib/session-parser.mjs";
import { summarizeFile as summarizeClaude } from "./lib/claude-session-parser.mjs";
await summarizeCodex(process.argv[2], false, new Map());
await summarizeClaude(process.argv[3]);
`);
  const child = spawn(process.execPath, [childScript, codexFixture, claudeFixture], { env: { ...process.env, ...environment }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  assert.equal(code, 0, `Audit counterexample failed to run: ${stderr}`);
  const result = await readAudit(environment);
  assert.equal(result.outsideRangeBodyOpenedFiles, 2, "Both parser wrappers must detect intentional outside opens");
  assert.equal(result.outsideRangeBodyReadBytes, Buffer.byteLength(codexText) + Buffer.byteLength(claudeText), "Audit must record actual filesystem bytes including multibyte content");
  console.log(`Read-audit counterexample detected ${result.outsideRangeBodyOpenedFiles} files / ${result.outsideRangeBodyReadBytes} bytes`);
  return true;
}

async function generate() {
  await Promise.all([mkdir(path.join(codexRoot, "sessions"), { recursive: true }), mkdir(claudeRoot, { recursive: true })]);
  const targetBytes = mib * 1024 * 1024;
  const targetPerSession = Math.floor(targetBytes / sessions);
  const headerMinimum = 600;
  if (targetPerSession < headerMinimum) throw new Error("Corpus is too small for the requested session count");
  const titles = [];
  const files = [];
  let writtenBytes = 0;
  let seed = 0x71922;
  function word() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed.toString(36).padStart(7, "0");
  }
  // Reuse a bounded pool of varied 16 KiB records. Keeping the entire corpus
  // in RAM would make the benchmark measure its generator rather than the server.
  const textPool = Array.from({ length: 64 }, () => Array.from({ length: 1850 }, word).join(" "));
  for (let n = 0; n < sessions; n += 1) {
    const id = sessionId(n);
    const timestamp = "2020-01-01T00:00:00Z"; // Range eligibility must use filesystem mtime.
    const records = [
      { timestamp, type: "session_meta", payload: { id, timestamp, cwd: `D:\\benchmark\\project-${n % 25}`, model: "benchmark-model", base_instructions: { text: "Synthetic instructions for the performance fixture" } } },
      { timestamp, type: "event_msg", payload: { type: "user_message", message: `Inspect synthetic session ${n}.` } },
      { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Unique address ${ip(n)}; ${chinese(n)}; baseline address ${n % 100 === 0 ? "10.104.5.20" : "unavailable"}. ${n === 0 ? "Rare short-query sentinel ΩΨ" : ""}` }] } },
    ];
    const filePath = path.join(codexRoot, "sessions", `rollout-${id}.jsonl`);
    const destination = await open(filePath, "w");
    let bytes = 0;
    try {
      const prefix = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
      await destination.write(prefix);
      bytes += Buffer.byteLength(prefix);
      let line = 0;
      while (bytes < targetPerSession) {
        const record = JSON.stringify({ timestamp, type: "response_item", payload: { type: "function_call_output", call_id: `synthetic-${line}`, output: textPool[(n + line) % textPool.length] } }) + "\n";
        await destination.write(record);
        bytes += Buffer.byteLength(record);
        line += 1;
      }
    } finally {
      await destination.close();
    }
    writtenBytes += bytes;
    const ageDays = n % 90;
    const modifiedAt = new Date();
    modifiedAt.setHours(12, 0, 0, 0);
    modifiedAt.setDate(modifiedAt.getDate() - ageDays);
    await utimes(filePath, modifiedAt, modifiedAt);
    files.push({ n, filePath, bytes, ageDays });
    titles.push(JSON.stringify({ id, thread_name: `Benchmark session ${n}`, updated_at: timestamp }));
    if ((n + 1) % Math.max(1, Math.floor(sessions / 10)) === 0) console.log(`Generated ${n + 1}/${sessions} sessions`);
  }
  await writeFile(path.join(codexRoot, "session_index.jsonl"), titles.join("\n") + "\n");
  return { corpusBytes: writtenBytes, files };
}

async function startServer() {
  const child = spawn(process.execPath, [path.join(runtimeRoot, "scripts", "server.mjs"), "--port", "0", "--codex-root", codexRoot, "--claude-root", claudeRoot, "--cache-root", cacheRoot], { env: { ...process.env, ...auditEnvironment }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-8192); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Server startup timed out: ${stderr}`)); }, 30000);
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += data;
      const url = stdout.match(/Session Viewer:\s*(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) { clearTimeout(timeout); resolve(url); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited during startup (${code}): ${stderr}`)); });
  });
  return { child, baseUrl };
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  await new Promise((resolve) => {
    instance.child.once("exit", resolve);
    instance.child.kill();
    const timeout = setTimeout(() => { instance.child.kill("SIGKILL"); resolve(); }, 5000);
    timeout.unref();
  });
}

async function readApi(route) {
  // Native HTTP avoids fetch/Undici's independent five-minute headers timeout
  // during multi-GiB cold builds. Health requests still run concurrently.
  return await new Promise((resolve, reject) => {
    const request = httpGet(`${server.baseUrl}${route}`, { agent: httpAgent }, (response) => {
      const chunks = [];
      response.on("data", (data) => chunks.push(data));
      response.once("error", reject);
      response.once("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (![200, 202].includes(response.statusCode)) throw new Error(`${route}: HTTP ${response.statusCode}: ${JSON.stringify(body)}`);
          resolve(body);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(30 * 60 * 1000, () => request.destroy(new Error(`${route}: request timed out after 30 minutes`)));
    request.once("error", reject);
  });
}

async function get(route) {
  const body = await readApi(route);
  if (!body.pending || !body.statusUrl) return body;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await pause(1000);
    const job = await readApi(body.statusUrl);
    if (!job.pending) return job.result;
  }
  throw new Error(`${route}: asynchronous indexing/search timed out after 30 minutes`);
}

async function timeSearch(query) {
  const started = performance.now();
  const rangeParameters = new URLSearchParams({ from: activeRange.from, to: activeRange.to });
  const result = await get(`/api/sources/codex/search?q=${encodeURIComponent(query)}&${rangeParameters}`);
  const elapsed = performance.now() - started;
  assert.ok(result.complete, `Benchmark search is incomplete: ${JSON.stringify(result.errors)}`);
  assert.ok(result.matches.length > 0, `Expected synthetic hit for ${query}`);
  return elapsed;
}

async function measureQueries(queries) {
  const measurements = [];
  for (const query of queries) measurements.push(await timeSearch(query));
  return timingSummary(measurements);
}

async function inspectCache(eligibleFiles) {
  const databaseFiles = (await readdir(cacheRoot)).filter((file) => file.endsWith(".sqlite"));
  assert.equal(databaseFiles.length, 1);
  const db = new DatabaseSync(path.join(cacheRoot, databaseFiles[0]), { readOnly: true });
  try {
    const chunkCount = db.prepare("SELECT count(*) AS count FROM chunks").get().count;
    const indexedPaths = db.prepare("SELECT DISTINCT f.path FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.kind!='metadata'").all().map((row) => row.path);
    const bodies = db.prepare("SELECT path,active_generation,body_fingerprint FROM files WHERE body_fingerprint IS NOT NULL ORDER BY path").all();
    const selected = new Set(eligibleFiles.map((file) => file.filePath));
    return {
      chunkCount,
      indexedBodyFileCount: indexedPaths.length,
      outsideRangeBodyFileCount: indexedPaths.filter((file) => !selected.has(file)).length,
      bodyGenerationHash: createHash("sha256").update(JSON.stringify(bodies)).digest("hex"),
    };
  } finally { db.close(); }
}

async function measureRange(days, files) {
  cacheRoot = path.join(root, `cache-${days}-days`);
  activeRange = recentDateRange(days);
  healthTimes = [];
  maxRssBytes = 0;
  const eligible = files.filter((file) => file.ageDays < days);
  auditEnvironment = await prepareReadAudit(`${days}-days`, files.filter((file) => file.ageDays >= days).map((file) => file.filePath));
  const eligibleBytes = eligible.reduce((sum, file) => sum + file.bytes, 0);
  const parameters = new URLSearchParams({ from: activeRange.from, to: activeRange.to });
  const listingRoute = `/api/sources/codex/sessions?refresh=1&${parameters}`;
  const statusRoute = `/api/sources/codex/search/status?${parameters}`;
  console.log(`Measuring ${days} days: ${eligible.length}/${files.length} sessions, ${(eligibleBytes / 1024 / 1024).toFixed(2)} MiB eligible`);
  server = await startServer();
  const health = await get("/api/health");
  assert.equal(health.searchVersion, 2);
  assert.equal(health.rangeSearch, true);
  assert.equal(health.maxRangeDays, 30);
  maxRssBytes = Math.max(maxRssBytes, health.memoryRssBytes || 0);
  let sampling = true;
  const sampler = (async () => {
    let samples = 0;
    let lastProgress = "";
    while (sampling) {
      const started = performance.now();
      const sample = await get("/api/health");
      healthTimes.push(performance.now() - started);
      maxRssBytes = Math.max(maxRssBytes, sample.memoryRssBytes || 0);
      samples += 1;
      if (samples % 20 === 0) {
        const status = await get(statusRoute);
        const bucket = status.totalFiles ? Math.floor(10 * status.indexedFiles / status.totalFiles) : 0;
        const progress = `${status.phase}:${bucket}`;
        if (progress !== lastProgress) {
          lastProgress = progress;
          console.log(`${days} days ${status.phase}: ${status.indexedFiles}/${status.totalFiles} files (${bucket * 10}%)`);
        }
      }
      await pause(50);
    }
  })();
  sampler.catch(() => {});
  let summaryListMs;
  let coldIndexMs;
  let listCache;
  try {
    const summaryStarted = performance.now();
    const listing = await get(listingRoute);
    summaryListMs = performance.now() - summaryStarted;
    assert.equal(listing.sessions.length, eligible.length);
    assert.deepEqual(listing.errors, []);
    listCache = await inspectCache(eligible);
    assert.equal(listCache.chunkCount, 0, "summary-only list must not index body or metadata chunks");
    coldIndexMs = await timeSearch("10.104.5.20");
  } finally {
    sampling = false;
    await sampler;
  }
  const coldStatus = await get(statusRoute);
  const builtCache = await inspectCache(eligible);
  assert.equal(builtCache.indexedBodyFileCount, eligible.length);
  assert.equal(builtCache.outsideRangeBodyFileCount, 0);
  const count = Math.min(queryCount, eligible.length);
  const indices = Array.from({ length: count }, (_, n) => eligible[Math.floor(n * eligible.length / count)].n);
  const ipQueries = indices.map(ip);
  const chineseQueries = indices.map(chinese);
  const warmIp = await measureQueries(ipQueries);
  const warmChinese = await measureQueries(chineseQueries);
  const cachedIp = await measureQueries(ipQueries);
  const cachedChinese = await measureQueries(chineseQueries);
  const short = {
    frequent: await measureQueries(["全", "中文"]),
    rareFullScan: await measureQueries(["Ω", "ΩΨ"]),
  };
  maxRssBytes = Math.max(maxRssBytes, (await get("/api/health")).memoryRssBytes || 0);
  await stopServer(server);
  server = await startServer();
  const restartStarted = performance.now();
  const restarted = await get(listingRoute);
  const restartListMs = performance.now() - restartStarted;
  assert.equal(restarted.sessions.length, eligible.length);
  const restartSearchMs = await timeSearch(chineseQueries[0]);
  const restartStatus = await get(statusRoute);
  assert.equal(restartStatus.generation, coldStatus.generation, "restarting must reuse persisted summaries and body chunks");
  const finalCache = await inspectCache(eligible);
  assert.equal(finalCache.outsideRangeBodyFileCount, 0);
  assert.equal(finalCache.bodyGenerationHash, builtCache.bodyGenerationHash, "restart search must reuse the same body generations and fingerprints");
  const indexBytes = await directoryBytes(cacheRoot);
  const healthDuringIndex = timingSummary(healthTimes);
  await stopServer(server);
  server = null;
  const outsideReadAudit = await readAudit(auditEnvironment);
  assert.equal(outsideReadAudit.outsideRangeBodyOpenedFiles, 0, "No outside-range log may be opened, even for a summary");
  assert.equal(outsideReadAudit.outsideRangeBodyReadBytes, 0, "No outside-range log body byte may be read");
  return {
    days,
    range: { from: activeRange.from, to: activeRange.to, timeZone: activeRange.timeZone },
    eligibleSessions: eligible.length,
    eligibleBytes,
    eligibleMiB: Number((eligibleBytes / 1024 / 1024).toFixed(2)),
    summaryListMs: Number(summaryListMs.toFixed(2)),
    listChunkCount: listCache.chunkCount,
    coldIndexMs: Number(coldIndexMs.toFixed(2)),
    restartListMs: Number(restartListMs.toFixed(2)),
    restartSearchMs: Number(restartSearchMs.toFixed(2)),
    warmIndexUncached: { ip: warmIp, chinese: warmChinese },
    cachedRepeat: { ip: cachedIp, chinese: cachedChinese },
    shortQuery: short,
    healthDuringIndex,
    peakServerRssBytes: maxRssBytes || null,
    indexBytes,
    indexToEligibleCorpusRatio: Number((indexBytes / eligibleBytes).toFixed(3)),
    indexedBodyFileCount: finalCache.indexedBodyFileCount,
    outsideRangeBodyFileCount: finalCache.outsideRangeBodyFileCount,
    ...outsideReadAudit,
    targets: {
      warmIpP95Under500Ms: warmIp.p95Ms <= 500,
      warmChineseP95Under500Ms: warmChinese.p95Ms <= 500,
      indexingHealthP95Under100Ms: healthDuringIndex.p95Ms <= 100,
    },
  };
}

try {
  console.log(`Synthetic date-range search benchmark: ${sessions} sessions over 90 days, target ${mib} MiB, ${queryCount} queries per class`);
  console.log(`Fixture directory: ${root}`);
  await mkdir(path.join(runtimeRoot, "scripts"), { recursive: true });
  await Promise.all([
    cp(path.join(scriptDirectory, "lib"), path.join(runtimeRoot, "scripts", "lib"), { recursive: true }),
    cp(path.join(scriptDirectory, "..", "assets"), path.join(runtimeRoot, "assets"), { recursive: true }),
    copyFile(path.join(scriptDirectory, "server.mjs"), path.join(runtimeRoot, "scripts", "server.mjs")),
  ]);
  await instrumentSnapshot();
  const readAuditSelfTestPassed = await verifyReadAudit();
  const { corpusBytes, files } = await generate();
  const reports = [];
  for (const days of [7, 30]) {
    const report = await measureRange(days, files);
    reports.push(report);
    console.log(JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({
    node: process.version, platform: `${process.platform}/${process.arch}`, sessions,
    corpusBytes, corpusMiB: Number((corpusBytes / 1024 / 1024).toFixed(2)),
    ageSpreadDays: 90, independentColdCaches: true, ranges: reports,
    readAuditSelfTestPassed,
    retainedFixture: retain ? root : null,
  }, null, 2));
  if (reports.some((report) => Object.values(report.targets).some((passed) => !passed))) process.exitCode = 1;
} finally {
  await stopServer(server);
  httpAgent.destroy();
  if (!retain && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith("session-viewer-search-benchmark-")) {
    await rm(root, { recursive: true, force: true });
  }
}
