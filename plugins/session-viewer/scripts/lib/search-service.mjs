import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { MAX_QUERY_CHARACTERS } from "./search-text.mjs";
import { releaseWriterLease } from "./search-lease.mjs";
import { normalizeDateRange, publicDateRange, rangeKey } from "../../assets/date-range.mjs";

const RESULT_CACHE_BYTES = 4 * 1024 * 1024;

function abortError() {
  return Object.assign(new Error("Search canceled"), { name: "AbortError", statusCode: 499 });
}

function fromError(value) {
  return Object.assign(new Error(value.message), { name: value.name || "Error", statusCode: value.statusCode || 500 });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class WorkerClient {
  constructor(url, workerData, onStatus) {
    this.worker = new Worker(url, { workerData, execArgv: [] });
    this.pending = new Map();
    this.nextId = 0;
    this.failed = null;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.on("message", (message) => {
      if (message.type === "ready") this.resolveReady(message);
      else if (message.type === "startup-error") fail(fromError(message.error));
      else if (message.type === "status") {
        onStatus?.(message.source, message.status);
        this.pending.get(message.id)?.onProgress?.(message.status);
      }
      else {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        entry.cleanup();
        if (message.error) entry.reject(fromError(message.error));
        else entry.resolve(message.value);
      }
    });
    const fail = (error) => {
      this.failed = error;
      this.rejectReady(error);
      for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) => {
      fail(new Error(`Search worker exited with code ${code}`));
    });
    // Construction must not produce an unhandled rejection if startup fails
    // before the first API call awaits readiness.
    this.ready.catch(() => {});
  }

  async call(method, args = {}, signal, onProgress) {
    await abortable(this.ready, signal);
    if (this.failed) throw this.failed;
    if (signal?.aborted) throw abortError();
    const id = ++this.nextId;
    const cancelBuffer = new SharedArrayBuffer(4);
    const flag = new Int32Array(cancelBuffer);
    return new Promise((resolve, reject) => {
      const abort = () => {
        Atomics.store(flag, 0, 1);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(abortError());
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, cleanup, flag, onProgress });
      signal?.addEventListener("abort", abort, { once: true });
      this.worker.postMessage({ id, method, ...args, cancelBuffer });
    });
  }

  async close() {
    for (const entry of this.pending.values()) {
      Atomics.store(entry.flag, 0, 1);
      entry.cleanup();
      entry.reject(abortError());
    }
    this.pending.clear();
    // Terminating an index worker is safe: only fully published per-file
    // generations are active, and startup removes interrupted staging rows.
    await this.worker.terminate();
  }
}

export function createSearchService({ sources, cacheRoot } = {}) {
  if (!sources || typeof sources !== "object") throw new Error("Session sources are required");
  const configs = {};
  for (const [source, config] of Object.entries(sources)) {
    if (!["codex", "claude"].includes(source) || !config?.root) throw new Error(`Invalid source configuration: ${source}`);
    configs[source] = { root: path.resolve(config.root) };
  }
  const directory = path.resolve(cacheRoot || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "SessionViewer", "search")
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "session-viewer", "search")));
  const cacheIdentity = Object.entries(configs).sort(([left], [right]) => left.localeCompare(right))
    .map(([source, config]) => [source, process.platform === "win32" ? config.root.toLowerCase() : config.root]);
  const cacheKey = createHash("sha256").update(JSON.stringify(cacheIdentity)).digest("hex").slice(0, 24);
  const workerData = {
    databasePath: path.join(directory, `index-v1-${cacheKey}.sqlite`),
    sources: configs, leaseToken: randomUUID(),
  };
  const statuses = new Map();
  const latestStatuses = new Map();
  const writer = new WorkerClient(new URL("./search-index-worker.mjs", import.meta.url), workerData);
  let reader;
  let closed = false;
  const readerReady = writer.ready.then(() => {
    if (closed) throw abortError();
    reader = new WorkerClient(new URL("./search-read-worker.mjs", import.meta.url), workerData);
    return reader.ready;
  });
  readerReady.catch(() => {});
  const tasks = new Map();
  const results = new Map();
  let resultBytes = 0;

  function requireSource(source) {
    if (closed) throw Object.assign(new Error("Search service is closed"), { statusCode: 503 });
    if (!Object.hasOwn(configs, source)) throw Object.assign(new Error("Unknown session source"), { statusCode: 404 });
  }

  function updateStatus(source, range, progress) {
    const key = JSON.stringify([source, rangeKey(range)]);
    const value = { ...statuses.get(key), ...progress, range: publicDateRange(range) };
    statuses.set(key, value);
    latestStatuses.set(source, value);
  }

  function runTask(method, source, range, { refresh = false, signal, onProgress } = {}) {
    requireSource(source);
    if (signal?.aborted) return Promise.reject(abortError());
    const key = JSON.stringify([method, source, rangeKey(range), Boolean(refresh)]);
    let task = tasks.get(key);
    if (!task || task.controller.signal.aborted) {
      const controller = new AbortController();
      task = { controller, subscribers: new Set(), progress: { phase: "queued", operation: method,
        indexedFiles: 0, totalFiles: 0, rebuiltFiles: 0, reusedFiles: 0, generation: 0, range: publicDateRange(range) } };
      const current = task;
      const progress = (value) => {
        current.progress = value;
        updateStatus(source, range, value);
        for (const subscriber of current.subscribers) {
          try { subscriber.onProgress?.(structuredClone(value)); } catch { /* Observers cannot fail indexing. */ }
        }
      };
      updateStatus(source, range, task.progress);
      task.promise = writer.call(method, { source, range, refresh }, controller.signal, progress).finally(() => {
        if (tasks.get(key) === current) tasks.delete(key);
      });
      task.promise.catch(() => {});
      tasks.set(key, task);
    }
    return new Promise((resolve, reject) => {
      const subscriber = { onProgress };
      task.subscribers.add(subscriber);
      try { onProgress?.(structuredClone(task.progress)); } catch { /* Observer only. */ }
      let finished = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        task.subscribers.delete(subscriber);
      };
      const abort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        if (!task.subscribers.size) task.controller.abort();
        reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      task.promise.then((value) => {
        if (finished) return;
        finished = true; cleanup(); resolve(value);
      }, (error) => {
        if (finished) return;
        finished = true; cleanup(); reject(error);
      });
    });
  }

  function publicListing(value) {
    const { fileIds, ...result } = value;
    return structuredClone(result);
  }

  return {
    databasePath: workerData.databasePath,
    async list(source, { range: input, refresh = false, signal, onProgress } = {}) {
      const range = normalizeDateRange(input);
      return publicListing(await runTask("summary", source, range, { refresh, signal, onProgress }));
    },
    async search(source, query, { range: input, signal, onProgress } = {}) {
      requireSource(source);
      if (signal?.aborted) throw abortError();
      const text = String(query ?? "").trim();
      const normalized = text.toLowerCase();
      if (!text || [...normalized].length > MAX_QUERY_CHARACTERS) {
        throw Object.assign(new Error(`Enter a search term of 1–${MAX_QUERY_CHARACTERS} characters`), { statusCode: 400 });
      }
      const range = normalizeDateRange(input);
      const listing = await runTask("body", source, range, { signal, onProgress });
      const key = JSON.stringify([source, rangeKey(range), listing.generation, normalized]);
      if (results.has(key)) {
        const entry = results.get(key);
        results.delete(key);
        results.set(key, entry);
        return structuredClone({ ...entry.value, query: text, errors: listing.errors, complete: listing.complete });
      }
      await abortable(readerReady, signal);
      const progress = (value) => {
        updateStatus(source, range, value);
        try { onProgress?.(structuredClone(value)); } catch { /* Observer only. */ }
      };
      const value = await reader.call("search", { source, query: text, range, fileIds: listing.fileIds,
        errors: listing.errors, complete: listing.complete }, signal, progress);
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes <= RESULT_CACHE_BYTES && value.generation === listing.generation) {
        if (results.has(key)) {
          resultBytes -= results.get(key).bytes;
          results.delete(key);
        }
        while (resultBytes + bytes > RESULT_CACHE_BYTES && results.size) {
          const oldest = results.keys().next().value;
          resultBytes -= results.get(oldest).bytes;
          results.delete(oldest);
        }
        results.set(key, { source, value, bytes });
        resultBytes += bytes;
      }
      return structuredClone(value);
    },
    async resolveSession(source, id, { range: input, signal } = {}) {
      requireSource(source);
      if (!id || typeof id !== "string") throw Object.assign(new Error("Session ID is required"), { statusCode: 400 });
      let range;
      if (input !== undefined) {
        if (!input || input.from == null || input.to == null) {
          throw Object.assign(new Error("请同时填写开始日期和结束日期"), { statusCode: 400 });
        }
        range = normalizeDateRange(input);
      }
      return structuredClone(await writer.call("resolve", { source, sessionId: id, range }, signal));
    },
    status(source, { range: input } = {}) {
      requireSource(source);
      const range = normalizeDateRange(input);
      return structuredClone(statuses.get(JSON.stringify([source, rangeKey(range)])) || {
        phase: "idle", indexedFiles: 0, totalFiles: 0, rebuiltFiles: 0, reusedFiles: 0,
        generation: latestStatuses.get(source)?.generation || 0, errors: [], range: publicDateRange(range),
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([writer.close(), reader?.close()]);
      releaseWriterLease(workerData.databasePath, workerData.leaseToken);
    },
  };
}
