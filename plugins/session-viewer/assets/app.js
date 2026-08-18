import {
  adjustFontScale,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  loadFontScale,
  normalizeFontScale,
  saveFontScale,
} from "./ui-preferences.mjs";
import { renderCollapsedToolResult, renderCollapsedTurn } from "./ui-render.mjs";

const state = {
  sessions: [],
  selectedId: null,
  filter: "all",
  query: "",
  scan: null,
  fontScale: 1,
};

const copyValues = new Map();
let copySequence = 0;
let toastTimer = null;

const elements = {
  list: document.querySelector("#session-list"),
  search: document.querySelector("#session-search"),
  refresh: document.querySelector("#refresh-button"),
  fontDecrease: document.querySelector("#font-decrease"),
  fontIncrease: document.querySelector("#font-increase"),
  fontScaleValue: document.querySelector("#font-scale-value"),
  empty: document.querySelector("#empty-state"),
  detail: document.querySelector("#detail"),
  title: document.querySelector("#session-title"),
  id: document.querySelector("#session-id"),
  state: document.querySelector("#session-state"),
  stateDot: document.querySelector("#session-state-dot"),
  stats: document.querySelector("#session-stats"),
  metadata: document.querySelector("#metadata"),
  systemCount: document.querySelector("#system-count"),
  systemPrompts: document.querySelector("#system-prompts"),
  turns: document.querySelector("#turns"),
  toast: document.querySelector("#toast"),
};

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

function renderSessions() {
  const sessions = visibleSessions();
  if (!sessions.length) {
    elements.list.innerHTML = `<div class="list-message">${state.sessions.length ? "没有匹配的 session" : "没有发现 Codex session"}</div>`;
    return;
  }

  let lastGroup = "";
  elements.list.innerHTML = sessions
    .map((session) => {
      const group = groupLabel(session.updatedAt || session.timestamp);
      const heading = group !== lastGroup ? `<div class="session-group-label">${escapeHtml(group)}</div>` : "";
      lastGroup = group;
      return `${heading}
        <button class="session-card ${session.id === state.selectedId ? "selected" : ""}" data-session-id="${escapeHtml(session.id)}" title="${escapeHtml(session.title)}">
          <div class="session-card-top">
            <span class="mini-state ${session.archived ? "archived" : ""}"></span>
            <span class="session-card-title">${escapeHtml(session.title)}</span>
            <span class="session-card-time">${escapeHtml(relativeTime(session.updatedAt || session.timestamp))}</span>
          </div>
          <div class="session-card-meta">
            <span>${session.turnCount} turn${session.turnCount === 1 ? "" : "s"}</span>
            <span>${escapeHtml(formatBytes(session.size))}</span>
            <span>${escapeHtml(session.model || session.originator || "Codex")}</span>
          </div>
        </button>`;
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
  elements.systemCount.textContent = `${prompts.length} item${prompts.length === 1 ? "" : "s"}`;
  if (!prompts.length) {
    elements.systemPrompts.innerHTML = '<div class="empty-cell">This rollout does not persist a readable system prompt.</div>';
    return;
  }
  elements.systemPrompts.innerHTML = prompts
    .map(
      (prompt, index) => `
        <details class="prompt-card" data-prompt-kind="${escapeHtml(prompt.kind)}" ${index === 0 ? "open" : ""}>
          <summary><span>${escapeHtml(prompt.label)}</span><span class="prompt-kind">${escapeHtml(prompt.kind)}</span></summary>
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
      `<div class="content-block notice-block">${step.hiddenReasoningCount} 个 reasoning block 仅以加密形式持久化；这里只显示日志中明确保存的 summary。</div>`,
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

function renderDetail(data) {
  copyValues.clear();
  const { summary, metadata, systemPrompts, turns } = data;
  const toolCount = turns.reduce((total, turn) => total + (turn.toolCalls?.length || 0), 0);
  const thoughtCount = turns.reduce((total, turn) => total + (turn.thinking?.length || 0), 0);
  elements.empty.classList.add("hidden");
  elements.detail.classList.remove("hidden");
  elements.title.textContent = summary.title;
  elements.id.textContent = summary.id;
  elements.state.textContent = summary.archived ? "Archived session" : "Active session";
  elements.stateDot.classList.toggle("archived", summary.archived);
  elements.stats.innerHTML =
    statCard(turns.length, "turns") + statCard(toolCount, "tools") + statCard(thoughtCount, "thoughts") + statCard(formatBytes(summary.size), "rollout");
  elements.metadata.innerHTML = [
    metadataItem("Updated", formatDate(summary.updatedAt || summary.timestamp)),
    metadataItem("Model", metadata.model || summary.model || metadata.modelProvider),
    metadataItem("Working directory", metadata.cwd || summary.cwd),
    metadataItem("Source", metadata.originator || metadata.source || summary.originator),
    metadataItem("Rollout file", summary.filePath),
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
  elements.refresh.classList.add("spinning");
  if (!state.sessions.length) elements.list.innerHTML = '<div class="list-message">Scanning local rollout files…</div>';
  try {
    const result = await fetchJson("/api/sessions");
    state.sessions = result.sessions || [];
    state.scan = result;
    if (!preserveSelection) state.selectedId = null;
    renderSessions();
    if (result.errors?.length) showToast(`已扫描，${result.errors.length} 个文件无法读取`);
  } catch (error) {
    elements.list.innerHTML = `<div class="list-message error">${escapeHtml(error.message)}</div>`;
  } finally {
    elements.refresh.classList.remove("spinning");
  }
}

async function selectSession(id, { updateHash = true } = {}) {
  if (!id) return;
  state.selectedId = id;
  renderSessions();
  elements.empty.classList.add("hidden");
  elements.detail.classList.remove("hidden");
  elements.title.textContent = "Loading session…";
  elements.id.textContent = id;
  elements.stats.innerHTML = "";
  elements.metadata.innerHTML = "";
  elements.systemPrompts.innerHTML = '<div class="list-message">Parsing rollout…</div>';
  elements.turns.innerHTML = "";
  if (updateHash) history.replaceState(null, "", `#session=${encodeURIComponent(id)}`);
  try {
    renderDetail(await fetchJson(`/api/sessions/${encodeURIComponent(id)}`));
  } catch (error) {
    elements.systemPrompts.innerHTML = `<div class="list-message error">${escapeHtml(error.message)}</div>`;
  }
}

elements.list.addEventListener("click", (event) => {
  const card = event.target.closest("[data-session-id]");
  if (card) selectSession(card.dataset.sessionId);
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

applyFontScale(loadFontScale(localStorage));
await loadSessions();
const hashId = new URLSearchParams(location.hash.slice(1)).get("session");
if (hashId && state.sessions.some((session) => session.id === hashId)) {
  await selectSession(hashId, { updateHash: false });
}
