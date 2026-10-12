import { parentPort, workerData } from "node:worker_threads";
import { openReaderStore, sourceKey } from "./search-store.mjs";
import { trigramQuery, matchSnippet } from "./search-text.mjs";
import { publicDateRange } from "../../assets/date-range.mjs";

const db = openReaderStore(workerData.databasePath);
const sourceConfigs = workerData.sources;
const readChunk = db.prepare("SELECT text,search_text,kind FROM chunks WHERE id=?");
const pause = () => new Promise((resolve) => setImmediate(resolve));

function checkCanceled(flag) {
  if (flag && Atomics.load(flag, 0)) {
    throw Object.assign(new Error("Search canceled"), { name: "AbortError", statusCode: 499 });
  }
}

async function search(message) {
  const flag = message.cancelBuffer ? new Int32Array(message.cancelBuffer) : null;
  checkCanceled(flag);
  const root = sourceConfigs[message.source]?.root;
  if (!root) throw Object.assign(new Error("Unknown session source"), { statusCode: 404 });
  const sourceId = sourceKey(message.source, root);
  const normalized = message.query.toLowerCase();
  const expression = trigramQuery(normalized);
  let iterator;
  db.exec("BEGIN");
  try {
    const catalog = db.prepare("SELECT generation,errors_json FROM sources WHERE source_key=?").get(sourceId);
    if (!catalog) throw new Error("Search index is not ready");
    const timestamps = new Map();
    const eligibleIds = new Set(message.fileIds);
    const matches = new Map();
    for (const row of db.prepare(`SELECT id,session_id,summary_json FROM files WHERE source_key=?
      AND file_mtime_ms>=? AND file_mtime_ms<? AND summary_fingerprint=observed_fingerprint`).iterate(sourceId, message.range.startMs, message.range.endExclusiveMs)) {
      checkCanceled(flag);
      if (!eligibleIds.has(row.id)) continue;
      const summary = JSON.parse(row.summary_json);
      timestamps.set(row.session_id, new Date(summary.logModifiedAt || summary.updatedAt || summary.timestamp).getTime());
      for (const value of [summary.title, summary.id, summary.cwd, summary.model, summary.preview]) {
        const text = String(value || "");
        if (text.toLowerCase().includes(normalized)) {
          matches.set(row.session_id, { id: row.session_id, snippet: matchSnippet(text, text.toLowerCase(), normalized), kind: "metadata" });
          break;
        }
      }
    }
    const filters = `f.source_key=? AND f.file_mtime_ms>=? AND f.file_mtime_ms<?
      AND f.body_fingerprint=f.observed_fingerprint AND c.generation=f.active_generation AND c.kind!='metadata'`;
    const statement = expression
      ? db.prepare(`SELECT c.id,c.file_id,f.session_id FROM chunk_fts
          JOIN chunks c ON c.id=chunk_fts.rowid JOIN files f ON f.id=c.file_id
          WHERE chunk_fts MATCH ? AND ${filters}`)
      : db.prepare(`SELECT c.id,c.file_id,f.session_id FROM chunks c
          JOIN files f ON f.id=c.file_id WHERE ${filters} ORDER BY c.id`);
    const args = [sourceId, message.range.startMs, message.range.endExclusiveMs];
    iterator = expression ? statement.iterate(expression, ...args) : statement.iterate(...args);
    let checked = 0;
    const publish = (phase) => parentPort.postMessage({ type: "status", id: message.id, source: message.source,
      status: { phase, operation: "search", indexedFiles: eligibleIds.size, totalFiles: eligibleIds.size,
        checkedChunks: checked, generation: catalog.generation, range: publicDateRange(message.range) } });
    publish("searching");
    for (const candidate of iterator) {
      checkCanceled(flag);
      if (eligibleIds.has(candidate.file_id) && !matches.has(candidate.session_id)) {
        const chunk = readChunk.get(candidate.id);
        if (chunk.search_text.includes(normalized)) {
          matches.set(candidate.session_id, {
            id: candidate.session_id,
            snippet: matchSnippet(chunk.text, chunk.search_text, normalized),
            kind: chunk.kind,
          });
        }
      }
      checked += 1;
      if (checked % 128 === 0) { await pause(); checkCanceled(flag); publish("searching"); }
    }
    checkCanceled(flag);
    const errors = message.errors;
    publish(message.complete ? "ready" : "error");
    return {
      query: message.query, generation: catalog.generation,
      matches: [...matches.values()].sort((left, right) => (timestamps.get(right.id) || 0) - (timestamps.get(left.id) || 0)),
      errors, complete: message.complete, range: publicDateRange(message.range),
    };
  } finally {
    iterator?.return?.();
    db.exec("ROLLBACK");
  }
}

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(async () => {
    try {
      if (message.method === "close") {
        db.close();
        parentPort.postMessage({ id: message.id, value: null });
        parentPort.close();
        return;
      }
      if (message.method !== "search") throw new Error("Unknown search worker operation");
      const value = await search(message);
      parentPort.postMessage({ id: message.id, value });
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: {
        message: error?.message || String(error), name: error?.name, statusCode: error?.statusCode || 500,
      } });
    }
  });
});
parentPort.postMessage({ type: "ready" });
