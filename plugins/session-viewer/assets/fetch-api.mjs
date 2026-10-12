function abortError() {
  return Object.assign(new Error("Request canceled"), { name: "AbortError" });
}

function operationUrl(value) {
  const base = "http://session-viewer.local";
  const target = new URL(value.statusUrl, base);
  if (!value.jobId || target.origin !== base || !/^\/api\/sources\/[a-z-]+\/search\/status$/i.test(target.pathname)
    || target.searchParams.get("job") !== value.jobId) {
    throw new Error("Invalid pending operation response");
  }
  return target.pathname + target.search;
}

export function createApiClient({
  fetchFn = fetch,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  pollInterval = 1000,
} = {}) {
  function waitForPoll(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeoutFn(timer);
        reject(abortError());
      };
      const timer = setTimeoutFn(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, pollInterval);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async function readResponse(response) {
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
    return value;
  }

  return async function fetchJson(url, options = {}) {
    const { signal, onProgress, ...requestOptions } = options;
    if (signal?.aborted) throw abortError();
    let jobUrl = null;
    let canceled = false;
    let cancelSent = false;
    let onAbort;

    async function cancelJob() {
      if (!jobUrl || cancelSent) return;
      cancelSent = true;
      const target = new URL(jobUrl, "http://session-viewer.local");
      target.searchParams.set("cancel", "1");
      try {
        await fetchFn(target.pathname + target.search, { cache: "no-store", keepalive: true });
      } catch { /* The server also expires abandoned operations. */ }
    }

    const aborted = new Promise((resolve, reject) => {
      onAbort = () => {
        canceled = true;
        void cancelJob();
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    async function run() {
      // Keep the first fast response alive to learn its job ID even when the
      // caller cancels. The caller rejects promptly; the learned job is then
      // canceled, rather than left indexing or searching without an owner.
      const response = await fetchFn(url, { cache: "no-store", ...requestOptions });
      const value = await readResponse(response);
      if (response.status !== 202) {
        if (canceled) throw abortError();
        return value;
      }
      if (value.pending !== true) throw new Error("Invalid pending operation response");
      jobUrl = operationUrl(value);
      if (canceled) {
        await cancelJob();
        throw abortError();
      }
      if (value.status) onProgress?.(value.status);
      while (true) {
        await waitForPoll(signal);
        const progress = await readResponse(await fetchFn(jobUrl, { cache: "no-store", ...requestOptions, signal }));
        if (canceled) throw abortError();
        if (progress.pending === true) {
          if (progress.status) onProgress?.(progress.status);
          continue;
        }
        if (progress.pending === false && Object.hasOwn(progress, "result")) {
          jobUrl = null;
          return progress.result;
        }
        throw new Error("Invalid operation status response");
      }
    }

    try {
      return await Promise.race([run(), aborted]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (jobUrl) void cancelJob();
    }
  };
}

export const fetchJson = createApiClient();
