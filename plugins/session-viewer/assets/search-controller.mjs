import { normalizeDateRange, recentDateRange, rangeKey } from "./date-range.mjs";

export const SEARCH_PAGE_SIZE = 100;

export function indexReportMessages(report, kind = "list") {
  if (!report) return [];
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const failures = errors.filter((error) => !error.cacheRecovery);
  const failureCount = new Set(failures.map((error, index) => error.filePath || `failure-${index}`)).size;
  const messages = [];
  if (failureCount || report.complete === false) {
    messages.push(kind === "search"
      ? (failureCount ? `${failureCount} 个文件无法完整搜索，结果可能不完整` : "部分日志无法完整搜索，结果可能不完整")
      : (failureCount ? `${failureCount} 个文件读取失败或内容损坏，列表可能不完整` : "部分日志无法读取，列表可能不完整"));
  }
  if (errors.some((error) => error.cacheRecovery)) messages.push("搜索缓存已重建");
  return messages;
}

export function sameDateRange(left, right) {
  return Boolean(left && right && rangeKey(left) === rangeKey(right));
}

export function searchResultSessions(sessions, search, filter = "all", limit = SEARCH_PAGE_SIZE) {
  const matches = search.submittedQuery && search.phase === "complete"
    ? new Map(search.matches.map((match) => [match.id, match])) : null;
  const filtered = sessions.filter((session) => {
    if (filter === "active" && session.archived) return false;
    if (filter === "archived" && !session.archived) return false;
    return !search.submittedQuery || Boolean(matches?.has(session.id));
  });
  return { total: filtered.length, sessions: search.submittedQuery ? filtered.slice(0, limit) : filtered, matches: matches || new Map() };
}

export function createSearchController({
  requestList,
  requestSearch,
  onCatalog = () => {},
  onChange = () => {},
  source = "codex",
  initialRange = recentDateRange(7),
}) {
  let epoch = 0;
  let operationAbort = null;
  let summaryFallback = null;
  let state = initialState(source, initialRange);

  function initialState(currentSource, range) {
    return {
      source: currentSource, draft: "", draftRange: { ...range }, appliedRange: { ...range }, submittedRange: null,
      rangeError: "", submittedQuery: "", phase: "idle", stage: null, listLoading: false, catalog: null,
      catalogError: "", applyError: false, matches: [], errors: [], error: "", complete: true, generation: null,
      stale: false, status: null, displayLimit: SEARCH_PAGE_SIZE,
    };
  }

  function emit() { onChange({ ...state }); }

  function cancel() {
    epoch += 1;
    operationAbort?.abort();
    operationAbort = null;
  }

  function clearSearch() {
    Object.assign(state, {
      submittedQuery: "", submittedRange: null, phase: "idle", matches: [], errors: [], error: "",
      complete: true, generation: null, stale: false, displayLimit: SEARCH_PAGE_SIZE,
    });
  }

  function searchSnapshot() {
    const { submittedQuery, submittedRange, phase, matches, errors, error, complete, generation, stale, displayLimit } = state;
    return { submittedQuery, submittedRange, phase, matches, errors, error, complete, generation, stale, displayLimit };
  }

  function observeGeneration(generation, range = state.appliedRange) {
    if (!sameDateRange(range, state.submittedRange)) return;
    const changed = typeof generation === "number" && typeof state.generation === "number"
      ? generation > state.generation : generation !== state.generation;
    if (state.phase === "complete" && generation != null && state.generation != null && changed) state.stale = true;
  }

  function reset(currentSource = state.source) {
    cancel();
    summaryFallback = null;
    state = initialState(currentSource, state.appliedRange);
    emit();
  }

  function setDraft(value) {
    state.draft = String(value || "");
    if (!state.draft.trim()) {
      if (state.submittedQuery && state.phase === "loading") {
        cancel();
        state.listLoading = false;
        state.stage = null;
        state.status = null;
      }
      clearSearch();
      summaryFallback = null;
    }
    emit();
  }

  function setRange(value) {
    try {
      state.draftRange = normalizeDateRange(value, { timeZone: state.appliedRange.timeZone });
      state.rangeError = "";
    } catch (error) {
      state.draftRange = { from: value.from, to: value.to, timeZone: state.appliedRange.timeZone };
      state.rangeError = error.message || String(error);
    }
    emit();
  }

  function assertRange(result, range) {
    if (!sameDateRange(result?.range, range)) throw new Error("服务器返回的时间段与请求不一致，请重试");
  }

  function progressHandler(currentEpoch, abort, range) {
    return (status) => {
      if (epoch !== currentEpoch || abort.signal.aborted || !status) return;
      if (status.range && !sameDateRange(status.range, range)) return;
      state.status = status;
      emit();
    };
  }

  async function readCatalog(currentEpoch, abort, source, range, refresh = false) {
    const result = await requestList(source, range, {
      signal: abort.signal, refresh, onProgress: progressHandler(currentEpoch, abort, range),
    });
    if (epoch !== currentEpoch || abort.signal.aborted) return null;
    assertRange(result, range);
    const previousRange = state.appliedRange;
    state.appliedRange = { ...range };
    state.catalog = result;
    state.catalogError = "";
    state.listLoading = false;
    observeGeneration(result.generation, range);
    onCatalog(result, { source, range: state.appliedRange, previousRange });
    return result;
  }

  async function submit() {
    if (state.rangeError) return;
    const query = state.draft.trim();
    const range = { ...state.draftRange };
    const source = state.source;
    // A second click can cancel a still-pending summary attempt. Keep the last
    // visible list/results rather than saving that attempt's loading state.
    const previousSearch = state.phase === "loading" && summaryFallback ? summaryFallback : searchSnapshot();
    summaryFallback = previousSearch;
    cancel();
    const currentEpoch = epoch;
    const abort = new AbortController();
    operationAbort = abort;
    clearSearch();
    Object.assign(state, {
      submittedQuery: query, submittedRange: query ? range : null, phase: query ? "loading" : "idle",
      stage: "summary", listLoading: true, catalogError: "", applyError: false, status: null,
    });
    emit();
    try {
      const catalog = await readCatalog(currentEpoch, abort, source, range);
      if (!catalog) return;
      // Once this catalog is applied, old matches from another scope cannot be
      // restored. A later canceled body operation falls back to this list.
      summaryFallback = { ...searchSnapshot(), submittedQuery: "", submittedRange: null, phase: "idle", matches: [],
        errors: [], error: "", complete: true, generation: null, stale: false, displayLimit: SEARCH_PAGE_SIZE };
      if (!query) {
        summaryFallback = null;
        state.stage = null;
        state.status = null;
        emit();
        return;
      }
      state.stage = "body";
      state.status = null;
      emit();
      const result = await requestSearch(source, query, range, {
        signal: abort.signal, onProgress: progressHandler(currentEpoch, abort, range),
      });
      if (epoch !== currentEpoch || abort.signal.aborted) return;
      assertRange(result, range);
      Object.assign(state, {
        phase: "complete", stage: null, matches: result.matches || [], errors: result.errors || [],
        complete: result.complete !== false, generation: result.generation ?? null, status: null,
      });
      // A search can discover a log written after its preceding summary scan.
      // Read that same range again so a new match is not silently discarded.
      const catalogIds = new Set((state.catalog?.sessions || []).map((session) => session.id));
      if (state.matches.some((match) => !catalogIds.has(match.id))) {
        state.stage = "summary";
        state.listLoading = true;
        emit();
        try {
          await readCatalog(currentEpoch, abort, source, range, true);
        } catch (error) {
          if (epoch !== currentEpoch || abort.signal.aborted) return;
          state.catalogError = error.message || String(error);
        }
        if (epoch !== currentEpoch || abort.signal.aborted) return;
        state.stage = null;
        state.listLoading = false;
        state.status = null;
      }
      emit();
      summaryFallback = null;
    } catch (error) {
      if (epoch !== currentEpoch || abort.signal.aborted) return;
      if (state.stage === "summary") {
        Object.assign(state, previousSearch);
        state.catalogError = error.message || String(error);
        state.applyError = true;
      } else if (query) {
        state.phase = "error";
        state.error = error.message || String(error);
      }
      summaryFallback = null;
      state.stage = null;
      state.listLoading = false;
      state.status = null;
      emit();
    } finally {
      if (operationAbort === abort) operationAbort = null;
    }
  }

  async function loadList({ refresh = false } = {}) {
    const range = { ...state.appliedRange };
    const source = state.source;
    cancel();
    summaryFallback = null;
    if (state.phase === "loading") clearSearch();
    const currentEpoch = epoch;
    const abort = new AbortController();
    operationAbort = abort;
    Object.assign(state, { stage: "summary", listLoading: true, catalogError: "", applyError: false, status: null });
    emit();
    try {
      await readCatalog(currentEpoch, abort, source, range, refresh);
    } catch (error) {
      if (epoch !== currentEpoch || abort.signal.aborted) return;
      state.catalogError = error.message || String(error);
    } finally {
      if (epoch === currentEpoch && !abort.signal.aborted) {
        state.listLoading = false;
        state.stage = null;
        state.status = null;
        emit();
      }
      if (operationAbort === abort) operationAbort = null;
    }
  }

  return {
    getState: () => ({ ...state }), setDraft, setRange, submit, reset, loadList,
    observeGeneration(generation, range) { observeGeneration(generation, range); emit(); },
    loadMore() { state.displayLimit += SEARCH_PAGE_SIZE; emit(); },
    dispose: cancel,
  };
}
