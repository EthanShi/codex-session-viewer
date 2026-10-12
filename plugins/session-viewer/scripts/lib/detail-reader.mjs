import { Worker } from "node:worker_threads";

const queue = [];
const workers = new Set();
const concurrency = 2;
let closed = false;

function abortError() {
  return Object.assign(new Error("Request cancelled"), { name: "AbortError", statusCode: 499 });
}

function drain() {
  while (!closed && workers.size < concurrency && queue.length) {
    const job = queue.shift();
    if (job.signal?.aborted) { job.reject(abortError()); continue; }
    job.start();
  }
}

export function readSessionDetail(source, summary, { signal } = {}) {
  if (closed || signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    const job = {
      signal,
      reject,
      start() {
        try {
          worker = new Worker(new URL("./detail-worker.mjs", import.meta.url), { workerData: { source, summary }, execArgv: [] });
        } catch (error) {
          finish(error);
          return;
        }
        workers.add(worker);
        worker.once("message", (message) => finish(message.error ? new Error(message.error) : null, message.body));
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => {
          workers.delete(worker);
          if (!settled) finish(new Error(`Session reader exited before returning a result (${code})`));
          drain();
        });
      },
    };
    function finish(error, body) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(body);
    }
    function onAbort() {
      const queuedIndex = queue.indexOf(job);
      if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
      finish(abortError());
      if (worker) void worker.terminate();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(job);
    drain();
  });
}

export async function closeDetailReaders() {
  closed = true;
  for (const job of queue.splice(0)) job.reject(abortError());
  await Promise.allSettled([...workers].map((worker) => worker.terminate()));
}
