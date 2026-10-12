import { parentPort, workerData } from "node:worker_threads";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { summarizeFile as summarizeCodex, readSessionIndex } from "./session-parser.mjs";
import { summarizeFile as summarizeClaude } from "./claude-session-parser.mjs";
import { openWriterStore, sourceKey, transaction, deleteChunks } from "./search-store.mjs";
import { chunkText, extractReadableText } from "./search-text.mjs";
import { acquireWriterLease, releaseWriterLease } from "./search-lease.mjs";
import { publicDateRange } from "../../assets/date-range.mjs";

function serializeError(error) {
  return { message: error?.message || String(error), name: error?.name, statusCode: error?.statusCode || 500 };
}

let store;
try {
  acquireWriterLease(workerData.databasePath, workerData.leaseToken);
  store = await openWriterStore(workerData.databasePath);
} catch (error) {
  releaseWriterLease(workerData.databasePath, workerData.leaseToken);
  parentPort.postMessage({ type: "startup-error", error: serializeError(error) });
  throw error;
}
const { db, recoveryError } = store;
let recoveryPending = recoveryError;
const catalogs = new Map();
const indexNamesBySource = new Map();
const getSource = db.prepare("SELECT * FROM sources WHERE source_key=?");
const getFiles = db.prepare("SELECT * FROM files WHERE source_key=? ORDER BY id");
const getFile = db.prepare("SELECT * FROM files WHERE id=?");
const incrementGeneration = db.prepare("UPDATE sources SET generation=generation+1 WHERE source_key=?");
const insertChunk = db.prepare("INSERT INTO chunks(file_id,generation,block_no,ordinal,kind,text,search_text) VALUES(?,?,?,?,?,?,?)");
const pause = () => new Promise((resolve) => setImmediate(resolve));
const fingerprint = (stats) => `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
const errorItem = (filePath, error) => ({ filePath, message: error?.message || String(error) });

function context(message) {
  const flag = new Int32Array(message.cancelBuffer);
  const checkCanceled = () => {
    if (Atomics.load(flag, 0)) throw Object.assign(new Error("Search canceled"), { name: "AbortError", statusCode: 499 });
  };
  const state = { phase: "scanning", operation: message.method, indexedFiles: 0, totalFiles: 0,
    rebuiltFiles: 0, reusedFiles: 0, generation: 0, range: message.range ? publicDateRange(message.range) : null };
  return { message, checkCanceled, state, publish(fields) {
    Object.assign(state, fields);
    parentPort.postMessage({ type: "status", id: message.id, source: message.source, status: { ...state } });
  } };
}

function addMalformed(warnings, warning) {
  if (!warnings.length) warnings.push({ ...warning, malformedCount: 1 });
  else {
    const first = warnings[0];
    first.malformedCount += 1;
    first.message = `Malformed JSONL records: ${first.malformedCount} (first on line ${first.lineNumber})`;
  }
}

async function discover(source, root, ctx) {
  const files = [], errors = [];
  async function entries(directory) {
    ctx.checkCanceled();
    try { return await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") errors.push(errorItem(directory, error)); return []; }
  }
  async function walk(directory, archived) {
    for (const entry of await entries(directory)) {
      ctx.checkCanceled();
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filePath, archived);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push({ filePath, archived });
    }
  }
  if (source === "codex") {
    await walk(path.join(root, "sessions"), false);
    await walk(path.join(root, "archived_sessions"), true);
  } else {
    for (const project of await entries(path.join(root, "projects"))) {
      if (!project.isDirectory()) continue;
      const directory = path.join(root, "projects", project.name);
      for (const entry of await entries(directory)) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push({ filePath: path.join(directory, entry.name), archived: false });
      }
    }
  }
  return { files, errors };
}

async function loadIndex(source, root, ctx, errors) {
  if (source !== "codex") return { names: new Map(), fingerprint: null };
  const indexPath = path.join(root, "session_index.jsonl");
  let current = null;
  try { current = fingerprint(await stat(indexPath)); }
  catch (error) { if (error.code !== "ENOENT") errors.push(errorItem(indexPath, error)); }
  const previous = indexNamesBySource.get(source);
  if (previous?.fingerprint === current) { errors.push(...previous.errors); return previous; }
  try {
    ctx.checkCanceled();
    const warnings = [];
    const names = await readSessionIndex(root, { strict: true, onMalformed: (warning) => addMalformed(warnings, warning) });
    const value = { names, fingerprint: current, errors: warnings };
    indexNamesBySource.set(source, value);
    errors.push(...warnings);
    return value;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    errors.push(errorItem(indexPath, error));
    return previous || { names: new Map(), fingerprint: null, errors: [] };
  }
}

function fileIdFromPath(source, filePath) {
  const name = path.basename(filePath, ".jsonl");
  return source === "codex" ? name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null : name;
}

async function inventory(source, refresh, ctx) {
  const root = workerData.sources[source]?.root;
  if (!root) throw Object.assign(new Error("Unknown session source"), { statusCode: 404 });
  const sourceId = sourceKey(source, root);
  db.prepare("INSERT OR IGNORE INTO sources(source_key) VALUES(?)").run(sourceId);
  const previous = catalogs.get(source);
  if (!refresh && previous && Date.now() - previous.checkedAt < 5000) return { ...previous, files: getFiles.all(sourceId) };
  ctx.publish({ phase: "scanning", generation: getSource.get(sourceId).generation });
  const found = await discover(source, root, ctx);
  const discoveryFailed = found.errors.length > 0;
  const errors = found.errors;
  if (recoveryPending) { errors.push(recoveryPending); recoveryPending = null; }
  const index = await loadIndex(source, root, ctx, errors);
  const old = getFiles.all(sourceId);
  const byPath = new Map(old.map((file) => [file.path, file]));
  const present = new Set(found.files.map((file) => file.filePath));
  let changed = false;
  for (let offset = 0; offset < found.files.length; offset += 16) {
    ctx.checkCanceled();
    const batch = found.files.slice(offset, offset + 16);
    const snapshots = await Promise.all(batch.map(async (item) => {
      try { return { item, stats: await stat(item.filePath) }; }
      catch (error) { errors.push(errorItem(item.filePath, error)); return null; }
    }));
    transaction(db, () => {
      for (const value of snapshots) {
        if (!value) continue;
        const { item, stats } = value;
        const row = byPath.get(item.filePath);
        const observed = fingerprint(stats);
        if (!row) {
          db.prepare(`INSERT INTO files(source_key,path,session_id,archived,file_mtime_ms,observed_fingerprint)
            VALUES(?,?,?,?,?,?)`).run(sourceId, item.filePath, fileIdFromPath(source, item.filePath), Number(item.archived), stats.mtimeMs, observed);
          changed = true;
        } else if (row.observed_fingerprint !== observed || row.file_mtime_ms !== stats.mtimeMs || row.archived !== Number(item.archived)) {
          db.prepare("UPDATE files SET observed_fingerprint=?,file_mtime_ms=?,archived=? WHERE id=?")
            .run(observed, stats.mtimeMs, Number(item.archived), row.id);
          changed = true;
        }
      }
    });
    ctx.publish({ catalogFiles: Math.min(offset + batch.length, found.files.length), catalogTotalFiles: found.files.length });
    await pause();
  }
  if (!discoveryFailed) {
    for (const row of old) {
      ctx.checkCanceled();
      if (present.has(row.path)) continue;
      await deleteChunks(db, "file_id=?", [row.id]);
      db.prepare("DELETE FROM files WHERE id=?").run(row.id);
      changed = true;
    }
  }
  transaction(db, () => {
    if (changed) incrementGeneration.run(sourceId);
    db.prepare("UPDATE sources SET scanned_at=?,index_fingerprint=?,errors_json=? WHERE source_key=?")
      .run(new Date().toISOString(), index.fingerprint, JSON.stringify(errors), sourceId);
  });
  const result = { sourceId, root, index, errors, checkedAt: Date.now(), files: getFiles.all(sourceId) };
  catalogs.set(source, result);
  return result;
}

function applyTitle(summary, fallbackTitle, fallbackUpdatedAt, names, file) {
  const indexed = names.get(summary.id);
  return { ...summary, archived: Boolean(file.archived), title: indexed?.title || fallbackTitle,
    updatedAt: indexed?.updatedAt || fallbackUpdatedAt, logModifiedAt: new Date(file.file_mtime_ms).toISOString() };
}

async function summarize(source, file, catalog, ctx, onRecord) {
  ctx.checkCanceled();
  const before = await stat(file.path);
  const warnings = [];
  const options = { checkCanceled: ctx.checkCanceled, onRecord, onMalformed: (warning) => addMalformed(warnings, warning) };
  const fallback = source === "codex" ? await summarizeCodex(file.path, Boolean(file.archived), new Map(), options)
    : await summarizeClaude(file.path, options);
  ctx.checkCanceled();
  const after = await stat(file.path);
  if (fingerprint(before) !== fingerprint(after) || fingerprint(after) !== file.observed_fingerprint) {
    throw new Error("Session changed while reading; refresh to include its latest contents");
  }
  return { fallback, warnings, summary: applyTitle(fallback, fallback.title, fallback.updatedAt, catalog.index.names, file) };
}

function saveSummary(file, catalog, built, bodyGeneration) {
  const { summary, fallback, warnings } = built;
  db.prepare(`UPDATE files SET session_id=?,summary_json=?,summary_fingerprint=?,fallback_title=?,
    fallback_updated_at=?,errors_json=? WHERE id=?`).run(summary.id, JSON.stringify(summary), file.observed_fingerprint,
    fallback.title, fallback.updatedAt, JSON.stringify(warnings), file.id);
  if (bodyGeneration != null) db.prepare("UPDATE files SET fingerprint=?,body_fingerprint=?,active_generation=? WHERE id=?")
    .run(file.observed_fingerprint, file.observed_fingerprint, bodyGeneration, file.id);
  incrementGeneration.run(catalog.sourceId);
}

async function ensureSummary(source, file, catalog, ctx) {
  if (file.summary_json && file.summary_fingerprint === file.observed_fingerprint) {
    const summary = applyTitle(JSON.parse(file.summary_json), file.fallback_title, file.fallback_updated_at, catalog.index.names, file);
    const json = JSON.stringify(summary);
    if (json !== file.summary_json) transaction(db, () => {
      db.prepare("UPDATE files SET summary_json=? WHERE id=?").run(json, file.id);
      incrementGeneration.run(catalog.sourceId);
    });
    return false;
  }
  const built = await summarize(source, file, catalog, ctx);
  transaction(db, () => saveSummary(file, catalog, built));
  return true;
}

async function ensureBody(source, file, catalog, ctx) {
  if (file.active_generation > 0 && file.body_fingerprint === file.observed_fingerprint) return false;
  const generation = file.active_generation + 1;
  await deleteChunks(db, "file_id=? AND generation=?", [file.id, generation]);
  let block = 0, batch = [], published = false;
  const flush = () => {
    if (!batch.length) return;
    transaction(db, () => { for (const row of batch) insertChunk.run(file.id, generation, ...row); });
    batch = [];
  };
  const onRecord = async (record) => {
    ctx.checkCanceled();
    for (const value of extractReadableText(source, record)) {
      let ordinal = 0;
      for (const text of chunkText(value.text)) {
        ctx.checkCanceled();
        batch.push([block, ordinal++, value.kind, text, text.toLowerCase()]);
        if (batch.length >= 16) { flush(); await pause(); }
      }
      block += 1;
    }
  };
  try {
    const built = await summarize(source, file, catalog, ctx, onRecord);
    flush();
    ctx.checkCanceled();
    transaction(db, () => saveSummary(file, catalog, built, generation));
    published = true;
    await deleteChunks(db, "file_id=? AND generation!=?", [file.id, generation]);
    return true;
  } finally {
    if (!published) await deleteChunks(db, "file_id=? AND generation=?", [file.id, generation]);
  }
}

function inRange(file, range) { return file.file_mtime_ms >= range.startMs && file.file_mtime_ms < range.endExclusiveMs; }

function winners(source, files) {
  const selected = new Map();
  for (const file of files) {
    if (!file.summary_json || file.summary_fingerprint !== file.observed_fingerprint) continue;
    const previous = selected.get(file.session_id);
    const newer = source === "claude" && previous && file.file_mtime_ms > previous.file_mtime_ms;
    if (!previous || (source === "codex" && previous.archived && !file.archived) || newer) selected.set(file.session_id, file);
  }
  return [...selected.values()];
}

function listing(source, catalog, range) {
  const eligible = getFiles.all(catalog.sourceId).filter((file) => inRange(file, range));
  const selected = winners(source, eligible);
  const errors = [...catalog.errors];
  for (const file of eligible) errors.push(...JSON.parse(file.errors_json || "[]"));
  const sourceRow = getSource.get(catalog.sourceId);
  const sessions = selected.map((file) => JSON.parse(file.summary_json)).sort((a, b) =>
    new Date(b.logModifiedAt || b.updatedAt || b.timestamp) - new Date(a.logModifiedAt || a.updatedAt || a.timestamp));
  return { source, sessions, errors, scannedAt: sourceRow.scanned_at, generation: sourceRow.generation,
    complete: !errors.some((error) => !error.cacheRecovery), range: publicDateRange(range), fileIds: selected.map((file) => file.id),
    ...(source === "codex" ? { codexRoot: catalog.root } : { claudeRoot: catalog.root, capabilities: { archives: false, promptKind: "persisted-context" } }) };
}

async function scan(message, ctx) {
  const catalog = await inventory(message.source, message.refresh, ctx);
  let eligible = catalog.files.filter((file) => inRange(file, message.range));
  ctx.publish({ phase: "summarizing", indexedFiles: 0, totalFiles: eligible.length, generation: getSource.get(catalog.sourceId).generation });
  for (const file of eligible) {
    ctx.checkCanceled();
    try {
      const rebuilt = await ensureSummary(message.source, file, catalog, ctx);
      if (rebuilt) ctx.state.rebuiltFiles += 1; else ctx.state.reusedFiles += 1;
    }
    catch (error) {
      if (error.name === "AbortError") throw error;
      db.prepare("UPDATE files SET errors_json=? WHERE id=?").run(JSON.stringify([errorItem(file.path, error)]), file.id);
    }
    ctx.publish({ indexedFiles: ++ctx.state.indexedFiles, generation: getSource.get(catalog.sourceId).generation });
    await pause();
  }
  if (message.method === "body") {
    eligible = winners(message.source, getFiles.all(catalog.sourceId).filter((file) => inRange(file, message.range)));
    ctx.publish({ phase: "indexing", indexedFiles: 0, totalFiles: eligible.length, rebuiltFiles: 0, reusedFiles: 0 });
    for (const file of eligible) {
      ctx.checkCanceled();
      try {
        const rebuilt = await ensureBody(message.source, file, catalog, ctx);
        if (rebuilt) ctx.state.rebuiltFiles += 1; else ctx.state.reusedFiles += 1;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        db.prepare("UPDATE files SET errors_json=? WHERE id=?").run(JSON.stringify([errorItem(file.path, error)]), file.id);
      }
      ctx.publish({ indexedFiles: ++ctx.state.indexedFiles, generation: getSource.get(catalog.sourceId).generation });
      await pause();
    }
  }
  const value = listing(message.source, catalog, message.range);
  ctx.publish({ phase: value.complete ? "ready" : "error", generation: value.generation, errors: value.errors, scannedAt: value.scannedAt });
  return value;
}

async function resolveSession(message, ctx) {
  let catalog = await inventory(message.source, false, ctx);
  const selectCandidates = () => catalog.files.filter((file) => file.session_id === message.sessionId || fileIdFromPath(message.source, file.path) === message.sessionId);
  let candidates = selectCandidates();
  if (!candidates.length) { catalog = await inventory(message.source, true, ctx); candidates = selectCandidates(); }
  const currentFiles = [], errors = [];
  for (let file of candidates) {
    ctx.checkCanceled();
    try {
      const stats = await stat(file.path);
      const observed = fingerprint(stats);
      if (file.observed_fingerprint !== observed || file.file_mtime_ms !== stats.mtimeMs) {
        transaction(db, () => {
          db.prepare("UPDATE files SET observed_fingerprint=?,file_mtime_ms=? WHERE id=?").run(observed, stats.mtimeMs, file.id);
          incrementGeneration.run(catalog.sourceId);
        });
        file = getFile.get(file.id);
      }
      if (message.range && !inRange(file, message.range)) continue;
      await ensureSummary(message.source, file, catalog, ctx);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (error.code !== "ENOENT") errors.push(error);
      continue;
    }
    const current = getFile.get(file.id);
    if (current.session_id === message.sessionId) currentFiles.push(current);
  }
  const chosen = winners(message.source, currentFiles)[0];
  if (chosen) return { ...JSON.parse(chosen.summary_json), filePath: chosen.path };
  if (errors.length) throw errors[0];
  throw Object.assign(new Error("Session not found"), { statusCode: 404 });
}

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(async () => {
    const ctx = context(message);
    try {
      ctx.checkCanceled();
      const value = message.method === "resolve" ? await resolveSession(message, ctx)
        : ["summary", "body"].includes(message.method) ? await scan(message, ctx) : (() => { throw new Error("Unknown index worker operation"); })();
      parentPort.postMessage({ id: message.id, value });
    } catch (error) {
      ctx.publish({ phase: error.name === "AbortError" ? "canceled" : "error", errors: [{ message: error.message }] });
      parentPort.postMessage({ id: message.id, error: serializeError(error) });
    }
  });
});
parentPort.postMessage({ type: "ready", recoveryError });
