export function renderCollapsedTurn({ queryHtml, bodyHtml }) {
  return `<details class="turn-card">
    <summary class="turn-query">${queryHtml}</summary>
    <div class="turn-detail">${bodyHtml}</div>
  </details>`;
}

export function renderCollapsedToolResult({ outputHtml, copyControlHtml }) {
  return `<details class="tool-result-details">
    <summary class="tool-result-summary">Result</summary>
    <div class="tool-part tool-result">
      <div class="tool-part-header"><span>Output</span>${copyControlHtml || ""}</div>
      <pre>${outputHtml || ""}</pre>
    </div>
  </details>`;
}

export function renderCompaction(marker, dateLabel = "", copyControlHtml = "") {
  const escape = value => String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const availability = marker.summary ? "查看压缩摘要" : marker.encrypted ? "摘要已加密" : "未记录摘要";
  const body = marker.summary
    ? `<div class="compaction-actions">${copyControlHtml}</div><pre>${escape(marker.summary)}</pre>`
    : `<p>${marker.encrypted ? "日志中的压缩摘要已加密，无法显示可读内容。" : "日志记录了上下文压缩事件，但没有保存可读摘要。"}</p>`;
  return `<details class="compaction-marker">
    <summary><strong>上下文已压缩</strong> <span class="compaction-time">${escape(dateLabel)}</span> <span class="compaction-availability">${availability}</span></summary>
    <div class="compaction-body">${body}</div>
  </details>`;
}
