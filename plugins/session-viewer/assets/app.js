import {
  adjustFontScale,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  loadFontScale,
  normalizeFontScale,
  saveFontScale,
} from "./ui-preferences.mjs";
import { renderCollapsedToolResult, renderCollapsedTurn } from "./ui-render.mjs";
import {
  analyzeSystemPrompts,
  buildSideBySideDiff,
  combineSystemPrompts,
  splitChangedText,
  summarizeDiff,
} from "./prompt-analysis.mjs";

const SOURCES = {
  codex: {
    label: "Codex",
    subtitle: "Local Codex traces",
    emptyTitle: "选择一个 Codex session",
    emptyDescription: "查看 system prompt、每轮 query、thinking、tool call 与 tool result。",
    noSessions: "没有发现 Codex session",
    scanning: "Scanning local Codex rollout files…",
    parsing: "Parsing Codex rollout…",
    activeState: "Active session",
    promptHeading: "System prompt",
    promptCompare: "System prompt 对比",
    compareEyebrow: "SYSTEM PROMPT DIFF",
    compareDescription: "绿色表示新增，红色表示删除；修改行会在两侧高亮具体变化片段。",
    promptEmpty: "This Codex rollout does not persist a readable system prompt.",
    promptMetricTitle: "System prompt 内容统计；token 为 Codex/GPT-5.x 离线预估值",
    promptCharacterStat: "prompt chars",
    promptTokenStat: "prompt tokens",
    fileLabel: "Rollout file",
    fileStatLabel: "rollout",
    fallbackModel: "Codex",
    hiddenThinkingLabel: "个 reasoning block 仅以加密形式持久化；这里只显示日志中明确保存的 summary。",
  },
  claude: {
    label: "Claude Code",
    subtitle: "Local Claude Code traces",
    emptyTitle: "选择一个 Claude Code session",
    emptyDescription: "查看每轮 query、thinking、tool call、tool result，以及 JSONL 中持久化的 context。",
    noSessions: "没有发现 Claude Code session",
    scanning: "Scanning local Claude Code session files…",
    parsing: "Parsing Claude Code session…",
    activeState: "Claude Code session",
    promptHeading: "Persisted context",
    promptCompare: "Context 对比",
    compareEyebrow: "PERSISTED CONTEXT DIFF",
    compareDescription: "仅比较 Claude Code JSONL 中明确持久化的 meta context；绿色表示新增，红色表示删除。",
    promptEmpty: "Claude Code JSONL does not persist the full base system prompt; no readable meta context was found.",
    promptMetricTitle: "Claude Code 持久化 context 内容统计；token 为通用离线预估值",
    promptCharacterStat: "context chars",
    promptTokenStat: "context tokens",
    fileLabel: "Session file",
    fileStatLabel: "session log",
    fallbackModel: "Claude Code",
    hiddenThinkingLabel: "个 thinking block 没有在 Claude Code JSONL 中持久化可读文本。",
  },
};

const state = {
  source: "codex",
  sessions: [],
  selectedId: null,
  filter: "all",
  query: "",
  scan: null,
  fontScale: 1,
  compareIds: [],
  detailCache: new Map(),
};

const copyValues = new Map();
let copySequence = 0;
let toastTimer = null;

const elements = {
  sourceTabs: [...document.querySelectorAll("[data-source]")],
  archiveFilters: [...document.querySelectorAll(".source-archive-filter")],
  brandSubtitle: document.querySelector("#brand-subtitle"),
  list: document.querySelector("#session-list"),
  search: document.querySelector("#session-search"),
  refresh: document.querySelector("#refresh-button"),
  fontDecrease: document.querySelector("#font-decrease"),
  fontIncrease: document.querySelector("#font-increase"),
  fontScaleValue: document.querySelector("#font-scale-value"),
  compareSelectionLabel: document.querySelector("#compare-selection-label"),
  compareControlTitle: document.querySelector("#compare-control-title"),
  compareClear: document.querySelector("#compare-clear"),
  compareButton: document.querySelector("#compare-button"),
  empty: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyDescription: document.querySelector("#empty-description"),
  compareView: document.querySelector("#compare-view"),
  compareClose: document.querySelector("#compare-close"),
  compareEyebrow: document.querySelector("#compare-eyebrow"),
  compareDescription: document.querySelector("#compare-description"),
  compareSessionSummary: document.querySelector("#compare-session-summary"),
  compareDiffSummary: document.querySelector("#compare-diff-summary"),
  compareDiff: document.querySelector("#compare-diff"),
  detail: document.querySelector("#detail"),
  title: document.querySelector("#session-title"),
  id: document.querySelector("#session-id"),
  state: document.querySelector("#session-state"),
  stateDot: document.querySelector("#session-state-dot"),
  stats: document.querySelector("#session-stats"),
  metadata: document.querySelector("#metadata"),
  systemHeading: document.querySelector("#system-heading"),
  systemCount: document.querySelector("#system-count"),
  systemPrompts: document.querySelector("#system-prompts"),
  turns: document.querySelector("#turns"),
  toast: document.querySelector("#toast"),
};

function sourceConfig() {
  return SOURCES[state.source];
}

function sessionsApiPath(id = "") {
  const base = `/api/sources/${encodeURIComponent(state.source)}/sessions`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

function sourceHash(parameters = {}) {
  const hash = new URLSearchParams({ source: state.source });
  if (parameters.session) hash.set("session", parameters.session);
  if (parameters.compare?.length) hash.set("compare", parameters.compare.join(","));
  return `#${hash.toString()}`;
}

function updateSourceChrome() {
  const config = sourceConfig();
  document.title = `${config.label} · Session Viewer`;
  elements.brandSubtitle.textContent = config.subtitle;
  elements.emptyTitle.textContent = config.emptyTitle;
  elements.emptyDescription.textContent = config.emptyDescription;
  elements.compareControlTitle.textContent = config.promptCompare;
  elements.compareEyebrow.textContent = config.compareEyebrow;
  elements.compareDescription.textContent = config.compareDescription;
  elements.systemHeading.textContent = config.promptHeading;
  elements.sourceTabs.forEach((tab) => {
    const selected = tab.dataset.source === state.source;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  elements.archiveFilters.forEach((button) => button.classList.toggle("hidden", state.source === "claude"));
}

function applyFontScale(value, { persist = false } = {}) {
  const normalized = persist ? saveFontScale(localStorage, value) : normalizeFontScale(value);
  state.fontScale = normalized;
  document.documentElement.style.fontSize = `${16 * normalized}px`;
  elements.fontScaleValue.textContent = `${Math.round(normalized * 100)}%`;
  elements.fontDecrease.disabled = normalized <= FONT_SCALE_MIN;
  elements.fontIncrease.disabled = normalized >= FONT_SCALE_MAX;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function copyButton(value) {
  const id = `copy-${++copySequence}`;
  copyValues.set(id, String(value ?? ""));
  return `<button class="copy-button" data-copy="${id}" title="复制内容">copy</button>`;
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: options.short ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}

function formatCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

function groupLabel(value) {
  const date = new Date(value);
  const now = new Date();
  const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const nowKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
  if (dateKey === nowKey) return "Today";
  if (dateKey === yesterdayKey) return "Yesterday";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function visibleSessions() {
  const needle = state.query.trim().toLowerCase();
  return state.sessions.filter((session) => {
    if (state.filter === "active" && session.archived) return false;
    if (state.filter === "archived" && !session.archived) return false;
    if (!needle) return true;
    return [session.title, session.id, session.cwd, session.model, session.preview]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

function renderCompareControls() {
  const selected = state.compareIds
    .map((id, index) => {
      const session = state.sessions.find((item) => item.id === id);
      return session ? `${index === 0 ? "A" : "B"} · ${session.title}` : null;
    })
    .filter(Boolean);
  elements.compareSelectionLabel.textContent = selected.length ? selected.join("  /  ") : "请选择两个 session";
  elements.compareClear.disabled = !state.compareIds.length;
  elements.compareButton.disabled = state.compareIds.length !== 2;
}

function renderSessions() {
  const sessions = visibleSessions();
  const config = sourceConfig();
  renderCompareControls();
  if (!sessions.length) {
    elements.list.innerHTML = `<div class="list-message">${state.sessions.length ? "没有匹配的 session" : config.noSessions}</div>`;
    return;
  }

  let lastGroup = "";
  elements.list.innerHTML = sessions
    .map((session) => {
      const group = groupLabel(session.updatedAt || session.timestamp);
      const heading = group !== lastGroup ? `<div class="session-group-label">${escapeHtml(group)}</div>` : "";
      const compareIndex = state.compareIds.indexOf(session.id);
      lastGroup = group;
      return `${heading}
        <div class="session-entry">
          <button class="session-card ${session.id === state.selectedId ? "selected" : ""}" data-session-id="${escapeHtml(session.id)}" title="${escapeHtml(session.title)}">
            <div class="session-card-top">
              <span class="mini-state ${session.archived ? "archived" : ""}"></span>
              <span class="session-card-title">${escapeHtml(session.title)}</span>
              <span class="session-card-time">${escapeHtml(relativeTime(session.updatedAt || session.timestamp))}</span>
            </div>
            <div class="session-card-meta">
              <span>${session.turnCount} turn${session.turnCount === 1 ? "" : "s"}</span>
              <span>${escapeHtml(formatBytes(session.size))}</span>
              <span>${escapeHtml(session.model || session.originator || config.fallbackModel)}</span>
            </div>
            <div class="session-card-prompt-stats" title="${escapeHtml(config.promptMetricTitle)}">
              <span>${formatCount(session.systemPromptCharacters)} 字符</span>
              <span>≈ ${formatCount(session.estimatedSystemPromptTokens)} tokens</span>
            </div>
          </button>
          <button class="compare-toggle ${compareIndex >= 0 ? "selected" : ""}" data-compare-id="${escapeHtml(session.id)}" type="button" aria-pressed="${compareIndex >= 0}" title="${compareIndex >= 0 ? "取消对比选择" : "加入 system prompt 对比"}">${compareIndex >= 0 ? (compareIndex === 0 ? "A" : "B") : "+"}</button>
        </div>`;
    })
    .join("");
}

function statCard(value, label) {
  return `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function metadataItem(label, value, title = value) {
  return `<div class="metadata-item"><label>${escapeHtml(label)}</label><span title="${escapeHtml(title || "")}">${escapeHtml(value || "—")}</span></div>`;
}

function renderSystemPrompts(prompts) {
  const config = sourceConfig();
  const totals = analyzeSystemPrompts(prompts);
  elements.systemCount.textContent = `${prompts.length} items · ${formatCount(totals.characterCount)} 字符 · ≈ ${formatCount(totals.estimatedTokens)} tokens`;
  elements.systemCount.title = config.promptMetricTitle;
  if (!prompts.length) {
    elements.systemPrompts.innerHTML = `<div class="empty-cell">${escapeHtml(config.promptEmpty)}</div>`;
    return;
  }
  elements.systemPrompts.innerHTML = prompts
    .map(
      (prompt, index) => `
        <details class="prompt-card" data-prompt-kind="${escapeHtml(prompt.kind)}" ${index === 0 ? "open" : ""}>
          <summary><span>${escapeHtml(prompt.label)}</span><span class="prompt-metrics">${formatCount(prompt.characterCount)} 字符 · ≈ ${formatCount(prompt.estimatedTokens)} tokens</span><span class="prompt-kind">${escapeHtml(prompt.kind)}</span></summary>
          <pre class="prompt-content">${escapeHtml(prompt.content)}</pre>
        </details>`,
    )
    .join("");
}

function statusClass(status) {
  if (String(status).startsWith("aborted")) return "aborted";
  if (status !== "complete") return "incomplete";
  return "";
}

function renderTextBlock(label, value, className = "") {
  return `<div class="content-block ${className}">
    <div class="content-label"><span>${escapeHtml(label)}</span>${copyButton(value)}</div>
    <pre>${escapeHtml(value)}</pre>
  </div>`;
}

function renderStepThinking(step) {
  const items = [];
  for (const thought of step.thinking || []) {
    const label = thought.kind === "summary" ? "Reasoning summary" : thought.kind === "context" ? "Context event" : "Thinking";
    items.push(renderTextBlock(label, thought.text, "thinking-block"));
  }
  if (step.hiddenReasoningCount) {
    items.push(
      `<div class="content-block notice-block">${step.hiddenReasoningCount} ${escapeHtml(sourceConfig().hiddenThinkingLabel)}</div>`,
    );
  }
  for (const message of step.assistantMessages || []) {
    items.push(renderTextBlock(message.phase === "final" ? "Final answer" : `Assistant · ${message.phase || "message"}`, message.text, "assistant-block"));
  }
  return items.length ? items.join("") : '<div class="empty-cell">No persisted thinking for this call</div>';
}

function renderToolCall(call, index) {
  const input = call.input || "";
  const output = call.output || "";
  const inputPart = input
    ? `<div class="tool-part"><div class="tool-part-header"><span>Input</span>${copyButton(input)}</div><pre>${escapeHtml(input)}</pre></div>`
    : "";
  const outputPart = output
    ? renderCollapsedToolResult({ outputHtml: escapeHtml(output), copyControlHtml: copyButton(output) })
    : '<div class="tool-part tool-result"><div class="empty-cell">No persisted result</div></div>';
  return `<details class="tool-card" ${index === 0 ? "open" : ""}>
    <summary><span class="tool-name">${escapeHtml(call.name || "tool call")}</span><span class="tool-kind">${escapeHtml(call.kind || "tool")}</span></summary>
    <div class="tool-body">${inputPart}${outputPart}</div>
  </details>`;
}

function renderTurns(turns) {
  if (!turns.length) {
    elements.turns.innerHTML = '<div class="list-message">This session has no persisted turns.</div>';
    return;
  }
  elements.turns.innerHTML = turns
    .map((turn) => {
      const query = turn.query || "No persisted query";
      const attachments = (turn.queryAttachments || []).length
        ? `<div class="attachment-row">${turn.queryAttachments.map((item) => `<span class="attachment">${escapeHtml(item)}</span>`).join("")}</div>`
        : "";
      const steps = (turn.steps || []).length
        ? turn.steps
        : [{
            ordinal: 1,
            thinking: turn.thinking || [],
            hiddenReasoningCount: turn.hiddenReasoningCount || 0,
            assistantMessages: turn.assistantMessages || [],
            toolCalls: turn.toolCalls || [],
          }];
      const stepRows = steps
        .map((step) => {
          const tools = (step.toolCalls || []).length
            ? step.toolCalls.map(renderToolCall).join("")
            : '<div class="empty-cell">No tool call in this step</div>';
          return `<div class="step-row step-grid" data-step="${String(step.ordinal).padStart(2, "0")}">
            <section class="step-cell thinking-cell">
              <div class="cell-meta"><span>${(step.thinking || []).length} thoughts</span><span>·</span><span>${(step.assistantMessages || []).length} messages</span></div>
              ${renderStepThinking(step)}
            </section>
            <section class="step-cell tools-cell">
              <div class="cell-meta"><span>${(step.toolCalls || []).length} calls</span></div>
              ${tools}
            </section>
          </div>`;
        })
        .join("");
      const queryHtml = `
          <div class="turn-query-meta">
            <strong>Turn ${String(turn.ordinal).padStart(2, "0")}</strong>
            <span class="status-chip ${statusClass(turn.status)}">${escapeHtml(turn.status)}</span>
            <span>${escapeHtml(formatDate(turn.startedAt, { short: true }))}</span>
            <span>·</span>
            <span>${escapeHtml(formatDuration(turn.durationMs))}</span>
            <span class="turn-summary">${steps.length} steps · ${(turn.toolCalls || []).length} calls</span>
          </div>
          ${renderTextBlock("Query", query, "query-block")}${attachments}`;
      const bodyHtml = `<div class="step-header step-grid">
          <div><span class="column-number">01</span> Thinking &amp; output</div>
          <div><span class="column-number">02</span> Tool calls &amp; results</div>
        </div>
        <div class="step-list">${stepRows}</div>`;
      return renderCollapsedTurn({ queryHtml, bodyHtml });
    })
    .join("");
}

function renderDiffCell(row, side) {
  const value = side === "left" ? row.leftText : row.rightText;
  if (row.kind === "unchanged") return escapeHtml(value);
  if (row.kind === "changed") {
    const parts = splitChangedText(row.leftText, row.rightText);
    const changed = side === "left" ? parts.leftChanged : parts.rightChanged;
    const markerClass = side === "left" ? "diff-removed-text" : "diff-added-text";
    return `${escapeHtml(parts.prefix)}<mark class="${markerClass}">${escapeHtml(changed) || "&nbsp;"}</mark>${escapeHtml(parts.suffix)}`;
  }
  const markerClass = side === "left" ? "diff-removed-text" : "diff-added-text";
  return value === "" ? "" : `<mark class="${markerClass}">${escapeHtml(value)}</mark>`;
}

function comparisonSessionCard(data, side) {
  const totals = analyzeSystemPrompts(data.systemPrompts || []);
  return `<article class="comparison-session-card side-${side.toLowerCase()}">
    <div class="comparison-side">${side}</div>
    <div>
      <h3>${escapeHtml(data.summary.title)}</h3>
      <p class="mono">${escapeHtml(data.summary.id)}</p>
      <div class="comparison-metrics">
        <span>${formatCount(totals.characterCount)} 字符</span>
        <span>≈ ${formatCount(totals.estimatedTokens)} tokens</span>
        <span>${data.systemPrompts?.length || 0} prompts</span>
      </div>
    </div>
  </article>`;
}

function renderComparison(leftData, rightData) {
  const rows = buildSideBySideDiff(
    combineSystemPrompts(leftData.systemPrompts),
    combineSystemPrompts(rightData.systemPrompts),
  );
  const summary = summarizeDiff(rows);
  elements.compareSessionSummary.innerHTML =
    comparisonSessionCard(leftData, "A") + comparisonSessionCard(rightData, "B");
  elements.compareDiffSummary.innerHTML = summary.changedRows
    ? `<span class="diff-chip removed">− ${formatCount(summary.removedLines)} 行</span><span class="diff-chip added">+ ${formatCount(summary.addedLines)} 行</span><span>${formatCount(summary.unchangedLines)} 行未变化</span>`
    : '<span class="diff-identical">两个 session 的 system prompt 完全相同</span>';
  elements.compareDiff.innerHTML = `<div class="diff-row diff-header" role="row">
      <div class="diff-line-number">行</div><div class="diff-column-title">A · ${escapeHtml(leftData.summary.title)}</div>
      <div class="diff-line-number">行</div><div class="diff-column-title">B · ${escapeHtml(rightData.summary.title)}</div>
    </div>${rows
      .map(
        (row) => `<div class="diff-row ${row.kind}" role="row">
          <div class="diff-line-number">${row.leftLine ?? ""}</div>
          <pre class="diff-code left">${renderDiffCell(row, "left")}</pre>
          <div class="diff-line-number">${row.rightLine ?? ""}</div>
          <pre class="diff-code right">${renderDiffCell(row, "right")}</pre>
        </div>`,
      )
      .join("")}`;
}

async function loadSessionDetail(id) {
  if (!state.detailCache.has(id)) {
    state.detailCache.set(
      id,
      fetchJson(sessionsApiPath(id)).catch((error) => {
        state.detailCache.delete(id);
        throw error;
      }),
    );
  }
  return state.detailCache.get(id);
}

async function openComparison({ updateHash = true } = {}) {
  if (state.compareIds.length !== 2) return;
  elements.compareButton.disabled = true;
  elements.compareButton.textContent = "正在比较…";
  elements.empty.classList.add("hidden");
  elements.detail.classList.add("hidden");
  elements.compareView.classList.remove("hidden");
  elements.compareDiff.innerHTML = '<div class="list-message">正在读取两个 session…</div>';
  if (updateHash) history.replaceState(null, "", sourceHash({ compare: state.compareIds }));
  const source = state.source;
  try {
    const [leftData, rightData] = await Promise.all(state.compareIds.map(loadSessionDetail));
    if (source !== state.source) return;
    renderComparison(leftData, rightData);
  } catch (error) {
    elements.compareDiff.innerHTML = `<div class="list-message error">${escapeHtml(error.message)}</div>`;
  } finally {
    elements.compareButton.textContent = "开始比较";
    elements.compareButton.disabled = state.compareIds.length !== 2;
  }
}

function closeComparison() {
  elements.compareView.classList.add("hidden");
  if (state.selectedId) {
    elements.detail.classList.remove("hidden");
    history.replaceState(null, "", sourceHash({ session: state.selectedId }));
  } else {
    elements.empty.classList.remove("hidden");
    history.replaceState(null, "", sourceHash());
  }
}

function toggleCompareSession(id) {
  const selectedIndex = state.compareIds.indexOf(id);
  if (selectedIndex >= 0) state.compareIds.splice(selectedIndex, 1);
  else if (state.compareIds.length < 2) state.compareIds.push(id);
  else {
    showToast("最多选择两个 session，请先取消一个");
    return;
  }
  renderSessions();
}

function renderDetail(data) {
  copyValues.clear();
  const config = sourceConfig();
  const { summary, metadata, systemPrompts, turns } = data;
  const toolCount = turns.reduce((total, turn) => total + (turn.toolCalls?.length || 0), 0);
  const thoughtCount = turns.reduce((total, turn) => total + (turn.thinking?.length || 0), 0);
  const promptTotals = analyzeSystemPrompts(systemPrompts || []);
  elements.empty.classList.add("hidden");
  elements.compareView.classList.add("hidden");
  elements.detail.classList.remove("hidden");
  elements.title.textContent = summary.title;
  elements.id.textContent = summary.id;
  elements.state.textContent = summary.archived ? "Archived session" : config.activeState;
  elements.stateDot.classList.toggle("archived", summary.archived);
  elements.stats.innerHTML =
    statCard(turns.length, "turns") +
    statCard(toolCount, "tools") +
    statCard(thoughtCount, "thoughts") +
    statCard(formatCount(promptTotals.characterCount), config.promptCharacterStat) +
    statCard(`≈${formatCount(promptTotals.estimatedTokens)}`, config.promptTokenStat) +
    statCard(formatBytes(summary.size), config.fileStatLabel);
  elements.metadata.innerHTML = [
    metadataItem("Updated", formatDate(summary.updatedAt || summary.timestamp)),
    metadataItem("Model", metadata.model || summary.model || metadata.modelProvider),
    metadataItem("Working directory", metadata.cwd || summary.cwd),
    metadataItem("Source", metadata.originator || metadata.entrypoint || metadata.source || summary.originator),
    metadataItem(config.fileLabel, summary.filePath),
  ].join("");
  renderSystemPrompts(systemPrompts || []);
  renderTurns(turns || []);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 1400);
}

async function loadSessions({ preserveSelection = true } = {}) {
  const source = state.source;
  const config = sourceConfig();
  elements.refresh.classList.add("spinning");
  if (!state.sessions.length) elements.list.innerHTML = `<div class="list-message">${escapeHtml(config.scanning)}</div>`;
  try {
    const result = await fetchJson(sessionsApiPath());
    if (source !== state.source) return;
    state.sessions = result.sessions || [];
    state.detailCache.clear();
    state.compareIds = state.compareIds.filter((id) => state.sessions.some((session) => session.id === id));
    state.scan = result;
    if (!preserveSelection) state.selectedId = null;
    renderSessions();
    if (result.errors?.length) showToast(`已扫描，${result.errors.length} 个文件无法读取`);
  } catch (error) {
    if (source !== state.source) return;
    elements.list.innerHTML = `<div class="list-message error">${escapeHtml(error.message)}</div>`;
  } finally {
    if (source === state.source) elements.refresh.classList.remove("spinning");
  }
}

async function selectSession(id, { updateHash = true } = {}) {
  if (!id) return;
  const source = state.source;
  const config = sourceConfig();
  state.selectedId = id;
  renderSessions();
  elements.empty.classList.add("hidden");
  elements.compareView.classList.add("hidden");
  elements.detail.classList.remove("hidden");
  elements.title.textContent = "Loading session…";
  elements.id.textContent = id;
  elements.stats.innerHTML = "";
  elements.metadata.innerHTML = "";
  elements.systemPrompts.innerHTML = `<div class="list-message">${escapeHtml(config.parsing)}</div>`;
  elements.turns.innerHTML = "";
  if (updateHash) history.replaceState(null, "", sourceHash({ session: id }));
  try {
    const detail = await loadSessionDetail(id);
    if (source !== state.source || state.selectedId !== id) return;
    renderDetail(detail);
  } catch (error) {
    if (source !== state.source || state.selectedId !== id) return;
    elements.systemPrompts.innerHTML = `<div class="list-message error">${escapeHtml(error.message)}</div>`;
  }
}

async function switchSource(source, { updateHash = true } = {}) {
  if (!SOURCES[source] || source === state.source) return;
  state.source = source;
  state.sessions = [];
  state.selectedId = null;
  state.filter = "all";
  state.query = "";
  state.scan = null;
  state.compareIds = [];
  state.detailCache.clear();
  elements.search.value = "";
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === "all");
  });
  elements.detail.classList.add("hidden");
  elements.compareView.classList.add("hidden");
  elements.empty.classList.remove("hidden");
  updateSourceChrome();
  renderSessions();
  if (updateHash) history.replaceState(null, "", sourceHash());
  await loadSessions({ preserveSelection: false });
}

elements.list.addEventListener("click", (event) => {
  const compareToggle = event.target.closest("[data-compare-id]");
  if (compareToggle) {
    toggleCompareSession(compareToggle.dataset.compareId);
    return;
  }
  const card = event.target.closest("[data-session-id]");
  if (card) selectSession(card.dataset.sessionId);
});

elements.sourceTabs.forEach((tab) => {
  tab.addEventListener("click", () => switchSource(tab.dataset.source));
  tab.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const currentIndex = elements.sourceTabs.indexOf(tab);
    const nextTab = elements.sourceTabs[(currentIndex + direction + elements.sourceTabs.length) % elements.sourceTabs.length];
    nextTab.focus();
    switchSource(nextTab.dataset.source);
  });
});

elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  renderSessions();
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    renderSessions();
  });
});

elements.refresh.addEventListener("click", () => loadSessions());

elements.fontDecrease.addEventListener("click", () => {
  applyFontScale(adjustFontScale(state.fontScale, -1), { persist: true });
});

elements.fontIncrease.addEventListener("click", () => {
  applyFontScale(adjustFontScale(state.fontScale, 1), { persist: true });
});

elements.compareClear.addEventListener("click", () => {
  state.compareIds = [];
  renderSessions();
  if (!elements.compareView.classList.contains("hidden")) closeComparison();
});

elements.compareButton.addEventListener("click", () => openComparison());
elements.compareClose.addEventListener("click", closeComparison);

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const value = copyValues.get(button.dataset.copy) || "";
  try {
    await navigator.clipboard.writeText(value);
    showToast("Copied");
  } catch {
    showToast("Clipboard permission denied");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== elements.search) {
    event.preventDefault();
    elements.search.focus();
  }
});

const hashParameters = new URLSearchParams(location.hash.slice(1));
const hashSource = hashParameters.get("source");
if (SOURCES[hashSource]) state.source = hashSource;
updateSourceChrome();
applyFontScale(loadFontScale(localStorage));
await loadSessions();
const compareIds = (hashParameters.get("compare") || "").split(",").filter(Boolean);
const hashId = hashParameters.get("session");
if (compareIds.length === 2 && compareIds.every((id) => state.sessions.some((session) => session.id === id))) {
  state.compareIds = compareIds;
  renderSessions();
  await openComparison({ updateHash: false });
} else if (hashId && state.sessions.some((session) => session.id === hashId)) {
  await selectSession(hashId, { updateHash: false });
}
