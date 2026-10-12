import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createHttpOperations } from "./lib/http-operations.mjs";

const response = () => Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const pause = () => new Promise((resolve) => setImmediate(resolve));

test("short operations preserve ordinary API responses and status codes", async () => {
  const operations = createHttpOperations({ getStatus: () => ({ phase: "ready" }), graceMs: 5 });
  try {
    assert.deepEqual(await operations.run("codex", async () => ({ matches: [] }), response()), { status: 200, value: { matches: [] } });
    const failed = await operations.run("codex", async () => { throw Object.assign(new Error("Invalid query"), { statusCode: 400 }); }, response());
    assert.equal(failed.status, 400);
    assert.equal(failed.value.error, "Invalid query");
  } finally { operations.close(); }
});

test("long indexing uses a single operation and polling never reruns it", async () => {
  const operations = createHttpOperations({ getStatus: () => ({ phase: "indexing", indexedFiles: 2, totalFiles: 1000 }), graceMs: 1 });
  const work = deferred();
  let calls = 0;
  try {
    const started = await operations.run("codex", () => { calls += 1; return work.promise; }, response());
    assert.equal(started.status, 202);
    assert.ok(started.value.statusUrl.endsWith(started.value.jobId));
    for (let n = 0; n < 3; n += 1) {
      const polling = operations.poll("codex", started.value.jobId);
      assert.equal(polling.value.pending, true);
      assert.equal(polling.value.status.indexedFiles, 2);
    }
    assert.equal(operations.poll("claude", started.value.jobId).status, 404);
    work.resolve({ query: "10.104.5.20", matches: [{ id: "fixture" }] });
    await pause();
    const finished = operations.poll("codex", started.value.jobId);
    assert.equal(finished.value.pending, false);
    assert.equal(finished.value.result.query, "10.104.5.20");
    assert.equal(calls, 1);
    assert.equal(operations.poll("codex", started.value.jobId).status, 404);
  } finally { operations.close(); }
});

test("transport disconnect and manual cancellation abort pending operations", async () => {
  const operations = createHttpOperations({ getStatus: () => ({ phase: "indexing" }), graceMs: 1 });
  const work = deferred();
  let signal;
  try {
    const started = await operations.run("codex", (value) => { signal = value; return work.promise; }, response());
    assert.equal(operations.poll("codex", started.value.jobId, { cancel: true }).value.cancelled, true);
    assert.equal(signal.aborted, true);
    work.resolve(null);
    await pause();
    const transport = response();
    const disconnectedWork = deferred();
    const pending = operations.run("codex", (value) => { signal = value; return disconnectedWork.promise; }, transport);
    await pause();
    transport.destroyed = true;
    transport.emit("close");
    assert.equal(signal.aborted, true);
    disconnectedWork.resolve(null);
    assert.equal((await pending).status, 499);
  } finally { operations.close(); }
});

test("abandoned operations expire", async () => {
  const operations = createHttpOperations({ getStatus: () => ({}), graceMs: 1, idleMs: 10 });
  const work = deferred();
  let signal;
  try {
    const started = await operations.run("codex", (value) => { signal = value; return work.promise; }, response());
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(signal.aborted, true);
    assert.equal(operations.poll("codex", started.value.jobId).status, 404);
    work.resolve(null);
  } finally { operations.close(); }
});

test("later failures stay explicit", async () => {
  const operations = createHttpOperations({ getStatus: () => ({}), graceMs: 1 });
  try {
    const failedWork = deferred();
    const failed = await operations.run("codex", () => failedWork.promise, response());
    failedWork.reject(new Error("Reader failed"));
    await pause();
    const outcome = operations.poll("codex", failed.value.jobId);
    assert.equal(outcome.status, 500);
    assert.equal(outcome.value.error, "Reader failed");
  } finally { operations.close(); }
});

test("progress is isolated by operation and range instead of a source-wide status", async () => {
  const operations = createHttpOperations({ getStatus: () => ({ phase: "wrong-source-status" }), graceMs: 1 });
  const week = { from: "2026-10-06", to: "2026-10-12", timeZone: "Asia/Singapore" };
  const month = { from: "2026-09-13", to: "2026-10-12", timeZone: "Asia/Singapore" };
  const firstWork = deferred();
  const secondWork = deferred();
  let firstProgress;
  let secondProgress;
  try {
    const first = await operations.run("codex", (_signal, report) => { firstProgress = report; return firstWork.promise; }, response(), { range: week });
    const second = await operations.run("codex", (_signal, report) => { secondProgress = report; return secondWork.promise; }, response(), { range: month });
    assert.deepEqual(first.value.range, week);
    assert.equal(operations.poll("codex", first.value.jobId).value.status.phase, "queued");
    firstProgress({ phase: "indexing", indexedFiles: 2, totalFiles: 7, range: week });
    secondProgress({ phase: "summarizing", indexedFiles: 9, totalFiles: 30, range: month });
    firstProgress({ phase: "incorrect", range: month });
    assert.equal(operations.poll("codex", first.value.jobId).value.status.indexedFiles, 2);
    assert.equal(operations.poll("codex", second.value.jobId).value.status.phase, "summarizing");
    operations.poll("codex", first.value.jobId, { cancel: true });
    firstProgress({ phase: "late", range: week });
    assert.equal(operations.poll("codex", first.value.jobId).status, 404);
    assert.equal(operations.poll("codex", second.value.jobId).value.status.indexedFiles, 9);
    firstWork.resolve(null);
    secondWork.resolve({ range: month });
    await pause();
  } finally { operations.close(); }
});
