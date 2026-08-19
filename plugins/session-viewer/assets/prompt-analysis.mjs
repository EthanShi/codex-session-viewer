const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const COMBINING_MARK_RE = /\p{Mark}/u;
const CODE_PUNCTUATION_RE = /[{}\[\]()<>=+\-*\/\\|&!?:;.,`#@$%^~]/;

export function countCharacters(value) {
  return [...String(value ?? "")].length;
}

// Codex uses GPT-5.x-family tokenization. This offline estimate follows the
// official ~4 characters/token English guideline, then adjusts CJK, emoji,
// newlines, and code-heavy punctuation that usually tokenize more densely.
export function estimateCodexTokens(value) {
  const text = String(value ?? "");
  if (!text) return 0;

  let asciiCharacters = 0;
  let cjkCharacters = 0;
  let otherUnicodeCharacters = 0;
  let combiningMarks = 0;
  let newlines = 0;
  let codePunctuation = 0;

  for (const character of text) {
    const codePoint = character.codePointAt(0) || 0;
    if (character === "\n") newlines += 1;
    if (codePoint <= 0x7f) {
      asciiCharacters += 1;
      if (CODE_PUNCTUATION_RE.test(character)) codePunctuation += 1;
    } else if (CJK_RE.test(character)) {
      cjkCharacters += 1;
    } else if (COMBINING_MARK_RE.test(character)) {
      combiningMarks += 1;
    } else {
      otherUnicodeCharacters += 1;
    }
  }

  const estimate =
    asciiCharacters / 4 +
    cjkCharacters * 0.9 +
    otherUnicodeCharacters * 1.25 +
    combiningMarks * 0.2 +
    newlines * 0.25 +
    codePunctuation * 0.1;
  return Math.max(1, Math.ceil(estimate));
}

export function analyzePromptText(value) {
  const text = String(value ?? "");
  return {
    characterCount: countCharacters(text),
    estimatedTokens: estimateCodexTokens(text),
  };
}

export function analyzeSystemPrompts(prompts) {
  return (prompts || []).reduce(
    (total, prompt) => {
      const stats =
        Number.isFinite(prompt?.characterCount) && Number.isFinite(prompt?.estimatedTokens)
          ? prompt
          : analyzePromptText(prompt?.content);
      total.characterCount += stats.characterCount || 0;
      total.estimatedTokens += stats.estimatedTokens || 0;
      return total;
    },
    { characterCount: 0, estimatedTokens: 0 },
  );
}

export function combineSystemPrompts(prompts) {
  return (prompts || [])
    .map((prompt) => `## ${prompt.label || "System prompt"} [${prompt.kind || "system"}]\n${prompt.content || ""}`)
    .join("\n\n");
}

function directDiff(leftLines, rightLines) {
  const operations = [];
  let prefix = 0;
  while (prefix < leftLines.length && prefix < rightLines.length && leftLines[prefix] === rightLines[prefix]) {
    operations.push({ type: "equal", leftText: leftLines[prefix], rightText: rightLines[prefix] });
    prefix += 1;
  }

  let leftSuffix = leftLines.length - 1;
  let rightSuffix = rightLines.length - 1;
  const suffix = [];
  while (
    leftSuffix >= prefix &&
    rightSuffix >= prefix &&
    leftLines[leftSuffix] === rightLines[rightSuffix]
  ) {
    suffix.unshift({ type: "equal", leftText: leftLines[leftSuffix], rightText: rightLines[rightSuffix] });
    leftSuffix -= 1;
    rightSuffix -= 1;
  }

  for (let index = prefix; index <= leftSuffix; index += 1) {
    operations.push({ type: "remove", leftText: leftLines[index] });
  }
  for (let index = prefix; index <= rightSuffix; index += 1) {
    operations.push({ type: "add", rightText: rightLines[index] });
  }
  return operations.concat(suffix);
}

function lcsDiff(leftLines, rightLines, maxCells) {
  const height = leftLines.length + 1;
  const width = rightLines.length + 1;
  if (height * width > maxCells) return directDiff(leftLines, rightLines);

  const matrix = new Uint32Array(height * width);
  for (let leftIndex = leftLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = rightLines.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const offset = leftIndex * width + rightIndex;
      matrix[offset] =
        leftLines[leftIndex] === rightLines[rightIndex]
          ? matrix[(leftIndex + 1) * width + rightIndex + 1] + 1
          : Math.max(matrix[(leftIndex + 1) * width + rightIndex], matrix[offset + 1]);
    }
  }

  const operations = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLines.length && rightIndex < rightLines.length) {
    if (leftLines[leftIndex] === rightLines[rightIndex]) {
      operations.push({ type: "equal", leftText: leftLines[leftIndex], rightText: rightLines[rightIndex] });
      leftIndex += 1;
      rightIndex += 1;
    } else if (matrix[(leftIndex + 1) * width + rightIndex] >= matrix[leftIndex * width + rightIndex + 1]) {
      operations.push({ type: "remove", leftText: leftLines[leftIndex] });
      leftIndex += 1;
    } else {
      operations.push({ type: "add", rightText: rightLines[rightIndex] });
      rightIndex += 1;
    }
  }
  while (leftIndex < leftLines.length) operations.push({ type: "remove", leftText: leftLines[leftIndex++] });
  while (rightIndex < rightLines.length) operations.push({ type: "add", rightText: rightLines[rightIndex++] });
  return operations;
}

export function buildSideBySideDiff(leftValue, rightValue, { maxCells = 2_000_000 } = {}) {
  const leftLines = String(leftValue ?? "").replaceAll("\r\n", "\n").split("\n");
  const rightLines = String(rightValue ?? "").replaceAll("\r\n", "\n").split("\n");
  const operations = lcsDiff(leftLines, rightLines, maxCells);
  const rows = [];
  let leftLine = 1;
  let rightLine = 1;
  let removed = [];
  let added = [];

  function flushChanges() {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      const left = removed[index] || null;
      const right = added[index] || null;
      rows.push({
        kind: left && right ? "changed" : left ? "removed" : "added",
        leftText: left?.text ?? "",
        leftLine: left?.line ?? null,
        rightText: right?.text ?? "",
        rightLine: right?.line ?? null,
      });
    }
    removed = [];
    added = [];
  }

  for (const operation of operations) {
    if (operation.type === "equal") {
      flushChanges();
      rows.push({
        kind: "unchanged",
        leftText: operation.leftText,
        leftLine: leftLine++,
        rightText: operation.rightText,
        rightLine: rightLine++,
      });
    } else if (operation.type === "remove") {
      removed.push({ text: operation.leftText, line: leftLine++ });
    } else {
      added.push({ text: operation.rightText, line: rightLine++ });
    }
  }
  flushChanges();
  return rows;
}

export function splitChangedText(leftValue, rightValue) {
  const left = [...String(leftValue ?? "")];
  const right = [...String(rightValue ?? "")];
  let prefixLength = 0;
  while (prefixLength < left.length && prefixLength < right.length && left[prefixLength] === right[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < left.length - prefixLength &&
    suffixLength < right.length - prefixLength &&
    left[left.length - 1 - suffixLength] === right[right.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  return {
    prefix: left.slice(0, prefixLength).join(""),
    leftChanged: left.slice(prefixLength, left.length - suffixLength).join(""),
    rightChanged: right.slice(prefixLength, right.length - suffixLength).join(""),
    suffix: suffixLength ? left.slice(left.length - suffixLength).join("") : "",
  };
}

export function summarizeDiff(rows) {
  return (rows || []).reduce(
    (summary, row) => {
      if (row.kind === "unchanged") summary.unchangedLines += 1;
      else {
        summary.changedRows += 1;
        if (row.leftLine != null) summary.removedLines += 1;
        if (row.rightLine != null) summary.addedLines += 1;
      }
      return summary;
    },
    { changedRows: 0, removedLines: 0, addedLines: 0, unchangedLines: 0 },
  );
}
