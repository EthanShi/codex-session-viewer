import assert from "node:assert/strict";
import test from "node:test";
import { createSearchController, indexReportMessages, sameDateRange, searchResultSessions } from "../assets/search-controller.mjs";
import { normalizeDateRange, recentDateRange } from "../assets/date-range.mjs";

const range = normalizeDateRange({ from: "2026-10-06", to: "2026-10-12" }, { timeZone: "Asia/Singapore" });
const otherRange = normalizeDateRange({ from: "2026-09-01", to: "2026-09-30" }, { timeZone: range.timeZone });
const listing = (scope = range, generation = 1, ids = ["match"]) => ({ range: scope, generation, sessions: ids.map((id) => ({ id })), errors: [], complete: true });
const result = (scope = range, generation = 2, id = "match") => ({ range: scope, generation, matches: [{ id, snippet: "10.104.5.20 in a later tool output", kind: "tool-output" }], errors: [], complete: true });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

function harness() {
  const searches = [];
  const lists = [];
  const catalogs = [];
  const changes = [];
  const controller = createSearchController({
    initialRange: range,
    requestList(source, range, options) {
      const pending = deferred();
      lists.push({ source, range, ...options, ...pending });
      return pending.promise;
    },
    requestSearch(source, query, range, options) {
      const pending = deferred();
      searches.push({ source, query, range, ...options, ...pending });
      return pending.promise;
    },
    onCatalog: (report, scope) => catalogs.push({ report, scope }),
    onChange: (state) => changes.push(state),
  });
  return { controller, searches, lists, catalogs, changes };
}

async function completeSearch(h, query = "term", scope = range, generation = 2) {
  h.controller.setDraft(query);
  const pending = h.controller.submit();
  h.lists.at(-1).resolve(listing(scope));
  await flush();
  h.searches.at(-1).resolve(result(scope, generation));
  await pending;
}

test("default uses seven inclusive local dates and initial loading reads summaries only", async () => {
  assert.deepEqual(recentDateRange(7, { now: Date.parse("2026-10-11T20:00:00Z"), timeZone: range.timeZone }), range);
  const h = harness();
  const pending = h.controller.loadList();
  assert.equal(h.lists.length, 1);
  assert.equal(h.searches.length, 0);
  assert.equal(h.controller.getState().stage, "summary");
  h.lists[0].onProgress({ range, phase: "summarizing", indexedFiles: 3, totalFiles: 10 });
  assert.equal(h.controller.getState().status.indexedFiles, 3);
  h.lists[0].resolve(listing());
  await pending;
  assert.equal(h.controller.getState().listLoading, false);
  assert.equal(h.catalogs.length, 1);
  assert.equal(h.searches.length, 0);
});

test("typing, date edits, clearing and source reset do not submit searches or lists", () => {
  const h = harness();
  h.controller.setDraft("10.");
  h.controller.setDraft("10.104.5.20");
  h.controller.setRange(otherRange);
  assert.equal(h.controller.getState().draftRange.from, otherRange.from);
  assert.equal(h.controller.getState().appliedRange.from, range.from);
  h.controller.setDraft("   ");
  h.controller.reset("claude");
  assert.equal(h.controller.getState().source, "claude");
  assert.equal(h.lists.length, 0);
  assert.equal(h.searches.length, 0);
});

test("blank submission applies the draft range only after successful summary loading", async () => {
  const h = harness();
  h.controller.setRange(otherRange);
  const pending = h.controller.submit();
  assert.equal(h.controller.getState().appliedRange.from, range.from);
  assert.ok(sameDateRange(h.lists[0].range, otherRange));
  h.lists[0].resolve(listing(otherRange));
  await pending;
  assert.ok(sameDateRange(h.controller.getState().appliedRange, otherRange));
  assert.equal(h.controller.getState().submittedRange, null);
  assert.equal(h.controller.getState().phase, "idle");
  assert.equal(h.searches.length, 0);
});

test("failed or mismatched summary response preserves applied scope and never starts body indexing", async () => {
  const h = harness();
  h.controller.setRange(otherRange);
  h.controller.setDraft("term");
  const first = h.controller.submit();
  h.lists[0].reject(new Error("Summary unavailable"));
  await first;
  assert.ok(sameDateRange(h.controller.getState().appliedRange, range));
  assert.equal(h.controller.getState().catalogError, "Summary unavailable");
  assert.equal(h.controller.getState().phase, "idle");
  assert.equal(h.controller.getState().applyError, true);
  const second = h.controller.submit();
  h.lists[1].resolve(listing(range));
  await second;
  assert.match(h.controller.getState().catalogError, /时间段.*不一致/);
  assert.equal(h.searches.length, 0);
});

test("failed submitted summary keeps the previously visible normal sessions and supports manual retry", async () => {
  const h = harness();
  const initial = h.controller.loadList();
  h.lists[0].resolve(listing(range, 1, ["old-a", "old-b"]));
  await initial;
  h.controller.setRange(otherRange);
  h.controller.setDraft("new keyword");
  const failed = h.controller.submit();
  h.lists[1].reject(new Error("Cannot load requested dates"));
  await failed;
  const state = h.controller.getState();
  assert.deepEqual(searchResultSessions(state.catalog.sessions, state).sessions.map((session) => session.id), ["old-a", "old-b"]);
  assert.equal(state.submittedQuery, "");
  assert.equal(state.submittedRange, null);
  assert.ok(sameDateRange(state.appliedRange, range));
  assert.ok(sameDateRange(state.draftRange, otherRange));
  assert.equal(state.draft, "new keyword");
  assert.equal(state.applyError, true);
  assert.equal(h.catalogs.length, 1, "failed summary must not replace the rendered catalog");
  assert.equal(h.searches.length, 0);
  const retry = h.controller.submit();
  h.lists[2].resolve(listing(otherRange));
  await flush();
  h.searches[0].resolve(result(otherRange));
  await retry;
  assert.equal(h.controller.getState().applyError, false);
  assert.equal(h.controller.getState().submittedQuery, "new keyword");
  assert.ok(sameDateRange(h.controller.getState().appliedRange, otherRange));
});

test("failed new-date summary restores visible old results with their actual query and range", async () => {
  const h = harness();
  h.controller.setDraft("old keyword");
  const initial = h.controller.submit();
  h.lists[0].resolve(listing(range, 1, ["match", "not-a-match"]));
  await flush();
  h.searches[0].resolve(result());
  await initial;
  h.controller.setRange(otherRange);
  h.controller.setDraft("new keyword");
  const firstAttempt = h.controller.submit();
  const secondAttempt = h.controller.submit();
  assert.equal(h.lists[1].signal.aborted, true);
  h.lists[2].reject(new Error("Summary failed"));
  await secondAttempt;
  h.lists[1].resolve(listing(otherRange, 99, ["late-new"]));
  await firstAttempt;
  const state = h.controller.getState();
  const visible = searchResultSessions(state.catalog.sessions, state);
  assert.deepEqual(visible.sessions.map((session) => session.id), ["match"]);
  assert.equal(visible.matches.get("match").snippet, "10.104.5.20 in a later tool output");
  assert.equal(state.submittedQuery, "old keyword");
  assert.ok(sameDateRange(state.submittedRange, range));
  assert.ok(sameDateRange(state.appliedRange, range));
  assert.equal(state.phase, "complete");
  assert.equal(state.generation, 2);
  assert.equal(state.draft, "new keyword");
  assert.ok(sameDateRange(state.draftRange, otherRange));
  assert.equal(state.catalogError, "Summary failed");
  assert.equal(h.searches.length, 1, "both failed or canceled summary attempts must not search");
});

test("explicit keyword submission loads summaries before searching its captured dates", async () => {
  const h = harness();
  h.controller.setRange(otherRange);
  h.controller.setDraft(" 10.104.5.20 ");
  const pending = h.controller.submit();
  assert.equal(h.searches.length, 0);
  h.controller.setRange(range);
  h.controller.setDraft("another term");
  h.lists[0].resolve(listing(otherRange));
  await flush();
  assert.equal(h.searches.length, 1);
  assert.equal(h.searches[0].query, "10.104.5.20");
  assert.ok(sameDateRange(h.searches[0].range, otherRange));
  h.searches[0].resolve(result(otherRange));
  await pending;
  const state = h.controller.getState();
  assert.equal(state.submittedQuery, "10.104.5.20");
  assert.ok(sameDateRange(state.submittedRange, otherRange));
  assert.ok(sameDateRange(state.appliedRange, otherRange));
  assert.ok(sameDateRange(state.draftRange, range));
  assert.equal(state.draft, "another term");
  assert.equal(state.matches[0].id, "match");
});

test("second click aborts a previous summary or search and ignores late completion", async () => {
  const h = harness();
  h.controller.setDraft("old");
  const first = h.controller.submit();
  h.controller.setDraft("new");
  const second = h.controller.submit();
  assert.equal(h.lists[0].signal.aborted, true);
  h.lists[0].resolve(listing());
  await first;
  assert.equal(h.searches.length, 0);
  h.lists[1].resolve(listing());
  await flush();
  h.controller.setDraft("latest");
  const third = h.controller.submit();
  assert.equal(h.searches[0].signal.aborted, true);
  h.searches[0].resolve(result(range, 1));
  await second;
  h.lists[2].resolve(listing());
  await flush();
  h.searches[1].resolve(result(range, 2));
  await third;
  assert.equal(h.controller.getState().submittedQuery, "latest");
  assert.equal(h.searches.length, 2);
});

test("clear cancels body work and restores applied list while keeping unsubmitted date draft", async () => {
  const h = harness();
  h.controller.setDraft("term");
  const pending = h.controller.submit();
  h.lists[0].resolve(listing());
  await flush();
  h.controller.setRange(otherRange);
  h.controller.setDraft("");
  assert.equal(h.searches[0].signal.aborted, true);
  h.searches[0].resolve(result());
  await pending;
  const state = h.controller.getState();
  assert.equal(state.phase, "idle");
  assert.equal(state.submittedQuery, "");
  assert.ok(sameDateRange(state.appliedRange, range));
  assert.ok(sameDateRange(state.draftRange, otherRange));
  assert.equal(state.catalog.sessions[0].id, "match");
  assert.equal(h.lists.length, 1);
});

test("source switch preserves applied dates, reverts draft dates and rejects old source progress", async () => {
  const h = harness();
  h.controller.setRange(otherRange);
  const applied = h.controller.submit();
  h.lists[0].resolve(listing(otherRange));
  await applied;
  h.controller.setRange(range);
  h.controller.setDraft("term");
  const pending = h.controller.submit();
  h.controller.reset("claude");
  h.lists[1].onProgress({ range, phase: "summarizing", indexedFiles: 9, totalFiles: 10 });
  h.lists[1].reject(new Error("Late failure"));
  await pending;
  const state = h.controller.getState();
  assert.ok(sameDateRange(state.appliedRange, otherRange));
  assert.ok(sameDateRange(state.draftRange, otherRange));
  assert.equal(state.status, null);
  assert.equal(state.error, "");
  assert.equal(state.source, "claude");
});

test("failed search stays explicit, mismatched search scope fails and retry is manual", async () => {
  const h = harness();
  h.controller.setDraft("term");
  const first = h.controller.submit();
  h.lists[0].resolve(listing());
  await flush();
  h.searches[0].reject(new Error("Index unavailable"));
  await first;
  assert.equal(h.controller.getState().phase, "error", "body-search errors must not roll back to old visible results");
  assert.equal(h.controller.getState().error, "Index unavailable");
  const second = h.controller.submit();
  h.lists[1].resolve(listing());
  await flush();
  h.searches[1].resolve(result(otherRange));
  await second;
  assert.match(h.controller.getState().error, /时间段.*不一致/);
  const third = h.controller.submit();
  h.lists[2].resolve(listing());
  await flush();
  h.searches[2].resolve({ ...result(), complete: false, errors: [{ filePath: "fixture", error: "unreadable" }] });
  await third;
  assert.equal(h.controller.getState().phase, "complete");
  assert.equal(h.controller.getState().complete, false);
  assert.equal(h.controller.getState().errors.length, 1);
});

test("job progress must match the current operation range and stops after cancellation", async () => {
  const h = harness();
  h.controller.setDraft("term");
  const pending = h.controller.submit();
  h.lists[0].onProgress({ range: otherRange, phase: "summarizing", indexedFiles: 99 });
  assert.equal(h.controller.getState().status, null);
  h.lists[0].resolve(listing());
  await flush();
  h.searches[0].onProgress({ range, phase: "indexing", indexedFiles: 3, totalFiles: 10 });
  assert.equal(h.controller.getState().status.indexedFiles, 3);
  h.controller.setDraft("");
  h.searches[0].onProgress({ range, phase: "indexing", indexedFiles: 10, totalFiles: 10 });
  assert.equal(h.controller.getState().status, null);
  h.searches[0].resolve(result());
  await pending;
});

test("refresh ignores date drafts, reads only applied summaries and marks completed search stale", async () => {
  const h = harness();
  await completeSearch(h);
  assert.equal(h.controller.getState().stale, false, "body generation is newer than the preceding summary, not stale");
  h.controller.setRange(otherRange);
  const refreshed = h.controller.loadList({ refresh: true });
  assert.ok(sameDateRange(h.lists[1].range, range));
  assert.equal(h.lists[1].refresh, true);
  h.lists[1].resolve(listing(range, 3));
  await refreshed;
  assert.equal(h.controller.getState().stale, true);
  assert.equal(h.searches.length, 1);
  assert.equal(h.controller.getState().submittedQuery, "term");
  assert.ok(sameDateRange(h.controller.getState().draftRange, otherRange));
});

test("newly discovered search match loads same-range summaries without searching again", async () => {
  const h = harness();
  h.controller.setDraft("term");
  const pending = h.controller.submit();
  h.lists[0].resolve(listing(range, 1, ["old"]));
  await flush();
  h.controller.setRange(otherRange);
  h.searches[0].resolve(result(range, 2, "new"));
  await flush();
  assert.equal(h.lists.length, 2);
  assert.ok(sameDateRange(h.lists[1].range, range));
  assert.equal(h.lists[1].refresh, true);
  h.lists[1].resolve(listing(range, 2, ["old", "new"]));
  await pending;
  const state = h.controller.getState();
  assert.equal(searchResultSessions(state.catalog.sessions, state).total, 1);
  assert.equal(state.stale, false);
  assert.equal(h.searches.length, 1);
});

test("summary synchronization failure preserves successful search with an explicit catalog error", async () => {
  const h = harness();
  h.controller.setDraft("term");
  const pending = h.controller.submit();
  h.lists[0].resolve(listing(range, 1, []));
  await flush();
  h.searches[0].resolve(result());
  await flush();
  h.lists[1].reject(new Error("Cannot read new match summary"));
  await pending;
  assert.equal(h.controller.getState().phase, "complete");
  assert.equal(h.controller.getState().matches.length, 1);
  assert.equal(h.controller.getState().catalogError, "Cannot read new match summary");
  assert.equal(h.searches.length, 1);
});

test("invalid reversed or longer-than-thirty-day date drafts disable all submitted work", async () => {
  const h = harness();
  h.controller.setDraft("term");
  h.controller.setRange({ from: "2026-09-01", to: "2026-10-12" });
  assert.match(h.controller.getState().rangeError, /30/);
  await h.controller.submit();
  h.controller.setRange({ from: "2026-10-12", to: "2026-10-01" });
  assert.match(h.controller.getState().rangeError, /开始日期/);
  await h.controller.submit();
  h.controller.setRange({ from: "", to: "2026-10-01" });
  assert.ok(h.controller.getState().rangeError);
  await h.controller.submit();
  assert.equal(h.lists.length, 0);
  assert.equal(h.searches.length, 0);
});

test("archive filtering and 100-result pages use completed results without requests", () => {
  const sessions = Array.from({ length: 245 }, (_, index) => ({ id: `session-${index}`, archived: index % 2 === 1 }));
  const search = { phase: "complete", submittedQuery: "term", matches: sessions.map((session) => ({ id: session.id, kind: "query", snippet: "term" })) };
  const page = searchResultSessions(sessions, search);
  assert.equal(page.total, 245);
  assert.equal(page.sessions.length, 100);
  assert.equal(searchResultSessions(sessions, search, "all", 200).sessions.length, 200);
  assert.equal(searchResultSessions(sessions, search, "archived").total, 122);
  assert.equal(searchResultSessions(sessions, { phase: "idle", submittedQuery: "", matches: [] }, "active").total, 123);
  assert.equal(searchResultSessions(sessions, { ...search, phase: "loading" }).sessions.length, 0);
});

test("cache recovery is disclosed without falsely reporting unreadable or incomplete files", () => {
  const report = { complete: true, errors: [{ cacheRecovery: true, message: "Rebuilt search cache" }] };
  assert.deepEqual(indexReportMessages(report), ["搜索缓存已重建"]);
  assert.deepEqual(indexReportMessages(report, "search"), ["搜索缓存已重建"]);
  assert.deepEqual(indexReportMessages({ complete: true, errors: [] }), []);
  assert.deepEqual(indexReportMessages(null), []);
});

test("list and search warnings count affected files once and exclude recovery notices", () => {
  const report = { complete: false, errors: [
    { cacheRecovery: true, message: "Recovered" },
    { filePath: "fixture-a.jsonl", message: "Malformed record" },
    { filePath: "fixture-a.jsonl", message: "Another malformed record" },
    { filePath: "fixture-b.jsonl", message: "Permission denied" },
  ] };
  assert.deepEqual(indexReportMessages(report), ["2 个文件读取失败或内容损坏，列表可能不完整", "搜索缓存已重建"]);
  assert.deepEqual(indexReportMessages(report, "search"), ["2 个文件无法完整搜索，结果可能不完整", "搜索缓存已重建"]);
  assert.deepEqual(indexReportMessages({ complete: false, errors: [] }), ["部分日志无法读取，列表可能不完整"]);
});
