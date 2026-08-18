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
