import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "../assets/fetch-api.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function response(value, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => value };
}

const pending = (jobId = "fixture-job") => ({
  pending: true,
  jobId,
  statusUrl: `/api/sources/codex/search/status?job=${jobId}`,
});

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function harness(replies = []) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const fetchJson = createApiClient({
    fetchFn(url, options) {
      calls.push({ url, options });
      const reply = replies.shift();
      assert.ok(reply, `unexpected request ${url}`);
      return typeof reply === "function" ? reply(url, options) : Promise.resolve(reply);
    },
    setTimeoutFn(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
  });
  function tick() {
    const next = timers.entries().next().value;
    assert.ok(next, "a pending operation should schedule one status poll");
    const [id, timer] = next;
    assert.equal(timer.delay, 1000);
    timers.delete(id);
    timer.callback();
  }
  return { fetchJson, calls, timers, tick };
}

test("ordinary JSON responses preserve request options and HTTP failures reject", async () => {
  const { fetchJson, calls } = harness([response({ sessions: ["fixture"] }), response({ error: "Read failed" }, 500)]);
  assert.deepEqual(await fetchJson("/api/sources/codex/sessions", { credentials: "same-origin" }), { sessions: ["fixture"] });
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.cache, "no-store");
  await assert.rejects(fetchJson("/failure"), /Read failed/);
});

test("202 catalog operations poll only their status URL until original result arrives", async () => {
  const listing = { sessions: [{ id: "one" }], generation: 3 };
  const { fetchJson, calls, timers, tick } = harness([
    response(pending(), 202),
    response({ pending: true, status: { phase: "indexing", indexedFiles: 2, totalFiles: 5 } }),
    response({ pending: false, result: listing }),
  ]);
  const result = fetchJson("/api/sources/codex/sessions");
  await flush();
  assert.equal(calls.length, 1);
  tick();
  await flush();
  assert.equal(calls.length, 2);
  tick();
  assert.deepEqual(await result, listing);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.map((call) => call.url), ["/api/sources/codex/sessions", pending().statusUrl, pending().statusUrl]);
});

test("search continuation does not issue the submitted search twice", async () => {
  const searched = { query: "10.104.5.20", matches: [{ id: "one", snippet: "later output" }], generation: 3 };
  const { fetchJson, calls, tick } = harness([response(pending(), 202), response({ pending: false, result: searched })]);
  const searchUrl = "/api/sources/codex/search?q=10.104.5.20";
  const result = fetchJson(searchUrl);
  await flush();
  tick();
  assert.deepEqual(await result, searched);
  assert.equal(calls.filter((call) => call.url === searchUrl).length, 1);
});

test("pending job progress stays attached to that request and never becomes a fetch option", async () => {
  const range = { from: "2026-10-06", to: "2026-10-12", timeZone: "Asia/Singapore" };
  const statuses = [];
  const initial = { range, phase: "scanning", indexedFiles: 0, totalFiles: 0 };
  const building = { range, phase: "indexing", indexedFiles: 2, totalFiles: 5 };
  const { fetchJson, calls, tick } = harness([
    response({ ...pending(), range, status: initial }, 202),
    response({ pending: true, status: building }),
    response({ pending: false, result: { matches: [], range } }),
  ]);
  const result = fetchJson("/api/sources/codex/search?q=term&from=2026-10-06&to=2026-10-12", {
    onProgress: (status) => statuses.push(status),
  });
  await flush();
  assert.deepEqual(statuses, [initial]);
  tick();
  await flush();
  assert.deepEqual(statuses, [initial, building]);
  tick();
  await result;
  assert.ok(calls.every((call) => !Object.hasOwn(call.options, "onProgress")));
});

test("progress arriving after cancellation is not delivered to the abandoned request", async () => {
  const poll = deferred();
  const statuses = [];
  const controller = new AbortController();
  const { fetchJson, tick } = harness([
    response(pending(), 202),
    () => poll.promise,
    response({ cancelled: true }),
  ]);
  const result = fetchJson("/api/sources/codex/search?q=term", { signal: controller.signal, onProgress: (status) => statuses.push(status) });
  await flush();
  tick();
  await flush();
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  poll.resolve(response({ pending: true, status: { phase: "indexing", indexedFiles: 10 } }));
  await flush();
  assert.deepEqual(statuses, []);
});

test("cancel during initial response rejects promptly and cancels the later learned job", async () => {
  const firstResponse = deferred();
  const controller = new AbortController();
  const { fetchJson, calls, timers } = harness([
    () => firstResponse.promise,
    response({ cancelled: true }),
  ]);
  const result = fetchJson("/api/sources/codex/search?q=term", { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(calls.length, 1);
  firstResponse.resolve(response(pending("late-job"), 202));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/api/sources/codex/search/status?job=late-job&cancel=1");
  assert.equal(calls[1].options.keepalive, true);
  assert.equal(calls[1].options.signal, undefined);
  assert.equal(timers.size, 0);
});

test("cancel between status polls clears the timer and sends one cancellation", async () => {
  const controller = new AbortController();
  const { fetchJson, calls, timers } = harness([response(pending(), 202), response({ cancelled: true })]);
  const result = fetchJson("/api/sources/codex/search?q=term", { signal: controller.signal });
  await flush();
  assert.equal(timers.size, 1);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(timers.size, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /[?&]cancel=1/);
});

test("cancel during a status request aborts its transport and ignores late completion", async () => {
  const pollResponse = deferred();
  const controller = new AbortController();
  const { fetchJson, calls, timers, tick } = harness([
    response(pending(), 202),
    () => pollResponse.promise,
    response({ cancelled: true }),
  ]);
  const result = fetchJson("/api/sources/codex/search?q=term", { signal: controller.signal });
  await flush();
  tick();
  await flush();
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(calls[1].options.signal.aborted, true);
  pollResponse.resolve(response({ pending: false, result: { matches: [] } }));
  await flush();
  assert.equal(timers.size, 0);
  assert.equal(calls.length, 3);
});

test("job failures remain errors rather than becoming empty results", async () => {
  const { fetchJson, timers, tick } = harness([
    response(pending(), 202),
    response({ error: "Index failed while reading fixture" }, 500),
    response({ cancelled: true }),
  ]);
  const result = fetchJson("/api/sources/codex/search?q=term");
  await flush();
  tick();
  await assert.rejects(result, /Index failed while reading fixture/);
  assert.equal(timers.size, 0);
});

test("invalid pending responses and cross-origin job URLs fail explicitly", async () => {
  const { fetchJson } = harness([
    response({ pending: false }, 202),
    response({ ...pending(), statusUrl: "https://example.com/api/sources/codex/search/status?job=fixture-job" }, 202),
  ]);
  await assert.rejects(fetchJson("/one"), /Invalid pending/);
  await assert.rejects(fetchJson("/two"), /Invalid pending/);
});

test("an already aborted request never starts transport", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchJson, calls } = harness();
  await assert.rejects(fetchJson("/api/sources/codex/sessions", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls.length, 0);
});
