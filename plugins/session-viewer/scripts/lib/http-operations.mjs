import { randomUUID } from "node:crypto";

// Cold indexes can take longer than a browser's HTTP header timeout. Keep the
// first request short, then let the client poll the same submitted operation.
export function createHttpOperations({ getStatus, graceMs = 100, idleMs = 60000, maxPending = 32 } = {}) {
  const jobs = new Map();
  let closed = false;
  const failure = (error) => ({ status: error?.statusCode || 500, value: { error: error?.message || "Operation failed" } });
  const abortError = () => Object.assign(new Error("Request cancelled"), { statusCode: 499 });

  function remove(job) {
    jobs.delete(job.id);
    if (job.state === "pending") job.controller.abort();
  }
  const expiry = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) if (now - job.touchedAt > idleMs) remove(job);
  }, Math.min(15000, idleMs));
  expiry.unref();

  return {
    async run(source, action, response, { range } = {}) {
      if (closed) return failure(Object.assign(new Error("Server is closing"), { statusCode: 503 }));
      if (jobs.size >= maxPending) return failure(Object.assign(new Error("Too many pending requests; retry shortly"), { statusCode: 503 }));
      const job = {
        id: randomUUID(), source, controller: new AbortController(),
        state: "pending", touchedAt: Date.now(), exposed: false, range,
        progress: null,
      };
      jobs.set(job.id, job);
      const onClose = () => {
        if (!response.writableEnded && !job.exposed) remove(job);
      };
      response.once("close", onClose);
      const onProgress = (progress) => {
        if (job.controller.signal.aborted || job.state !== "pending") return;
        if (range && (progress.range?.from !== range.from || progress.range?.to !== range.to)) return;
        job.progress = progress;
      };
      const completion = Promise.resolve().then(() => action(job.controller.signal, onProgress)).then((value) => {
        job.state = "complete";
        job.value = value;
      }, (error) => {
        job.state = "error";
        job.error = error;
      });
      let timer;
      await Promise.race([completion, new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
      clearTimeout(timer);
      response.removeListener("close", onClose);
      if (job.controller.signal.aborted || response.destroyed) {
        remove(job);
        return failure(abortError());
      }
      if (job.state !== "pending") {
        jobs.delete(job.id);
        return job.state === "error" ? failure(job.error) : { status: 200, value: job.value };
      }
      job.exposed = true;
      return {
        status: 202,
        value: { pending: true, jobId: job.id, ...(range ? { range } : {}), statusUrl: `/api/sources/${encodeURIComponent(source)}/search/status?job=${job.id}` },
      };
    },
    poll(source, id, { cancel = false } = {}) {
      const job = jobs.get(id);
      if (!job || job.source !== source) return failure(Object.assign(new Error("Operation expired or was cancelled; retry the request"), { statusCode: 404 }));
      job.touchedAt = Date.now();
      if (cancel) {
        remove(job);
        return { status: 200, value: { cancelled: true } };
      }
      if (job.state === "pending") return { status: 200, value: {
        pending: true, ...(job.range ? { range: job.range } : {}),
        status: job.progress || (job.range ? { phase: "queued", range: job.range } : getStatus?.(source)),
      } };
      jobs.delete(job.id);
      return job.state === "error" ? failure(job.error) : { status: 200, value: { pending: false, result: job.value } };
    },
    close() {
      closed = true;
      clearInterval(expiry);
      for (const job of jobs.values()) remove(job);
    },
  };
}
