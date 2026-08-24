import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");

async function optionalImport(relativePath) {
  try {
    return await import(pathToFileURL(path.join(pluginRoot, relativePath)));
  } catch {
    return null;
  }
}

const preferences = await optionalImport("assets/ui-preferences.mjs");
const renderers = await optionalImport("assets/ui-render.mjs");
const promptAnalysis = await optionalImport("assets/prompt-analysis.mjs");
const sessionGroups = await optionalImport("assets/session-groups.mjs");
const stylesheet = readFileSync(path.join(pluginRoot, "assets", "app.css"), "utf8");
const icon = readFileSync(path.join(pluginRoot, "assets", "icon.svg"), "utf8");
const logo = readFileSync(path.join(pluginRoot, "assets", "logo.svg"), "utf8");
const launcher = readFileSync(path.join(pluginRoot, "scripts", "open-viewer.ps1"), "utf8");
const documentHtml = readFileSync(path.join(pluginRoot, "assets", "index.html"), "utf8");
const application = readFileSync(path.join(pluginRoot, "assets", "app.js"), "utf8");
const server = readFileSync(path.join(pluginRoot, "scripts", "server.mjs"), "utf8");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("font controls adjust by ten percent and stop at the approved limits", () => {
  assert.equal(typeof preferences?.adjustFontScale, "function", "adjustFontScale should be implemented");
  assert.equal(preferences.adjustFontScale(1, 1), 1.1);
  assert.equal(preferences.adjustFontScale(1, -1), 0.9);
  assert.equal(preferences.adjustFontScale(1.6, 1), 1.6);
  assert.equal(preferences.adjustFontScale(0.9, -1), 0.9);
});

test("font scale restores a valid saved value and rejects invalid storage", () => {
  assert.equal(typeof preferences?.loadFontScale, "function", "loadFontScale should be implemented");
  assert.equal(preferences.loadFontScale(memoryStorage()), 1);
  assert.equal(preferences.loadFontScale(memoryStorage({ "session-viewer-font-scale": "1.4" })), 1.4);
  assert.equal(preferences.loadFontScale(memoryStorage({ "session-viewer-font-scale": "huge" })), 1);
});

test("font scale persists its normalized value", () => {
  assert.equal(typeof preferences?.saveFontScale, "function", "saveFontScale should be implemented");
  const storage = memoryStorage();
  assert.equal(preferences.saveFontScale(storage, 1.26), 1.3);
  assert.equal(storage.getItem("session-viewer-font-scale"), "1.3");
});

test("turn renderer is closed by default and keeps only the query in its summary", () => {
  assert.equal(typeof renderers?.renderCollapsedTurn, "function", "renderCollapsedTurn should be implemented");
  const html = renderers.renderCollapsedTurn({
    queryHtml: '<div data-part="query">Query text</div>',
    bodyHtml: '<div data-part="body">Thinking and tools</div>',
  });
  assert.match(html, /^<details class="turn-card">/);
  assert.doesNotMatch(html, /^<details[^>]*\sopen(?:\s|>)/);
  assert.match(html, /<summary class="turn-query">[\s\S]*Query text[\s\S]*<\/summary>/);
  assert.doesNotMatch(html.match(/<summary[\s\S]*?<\/summary>/)?.[0] || "", /Thinking and tools/);
});

test("tool-result renderer is independently collapsed by default", () => {
  assert.equal(typeof renderers?.renderCollapsedToolResult, "function", "renderCollapsedToolResult should be implemented");
  const html = renderers.renderCollapsedToolResult({ outputHtml: "Tool output", copyControlHtml: "<button>copy</button>" });
  assert.match(html, /^<details class="tool-result-details">/);
  assert.doesNotMatch(html, /^<details[^>]*\sopen(?:\s|>)/);
  assert.match(html, /<summary class="tool-result-summary">Result<\/summary>/);
  assert.match(html, /Tool output/);
});

test("theme uses a near-black grid with a restrained coral accent", () => {
  assert.match(stylesheet, /--bg:\s*#000/i);
  assert.match(stylesheet, /--accent:\s*#ed765f/i);
  assert.match(stylesheet, /background-image:[^}]*linear-gradient/is);
  assert.doesNotMatch(icon, /gradient/i);
  assert.doesNotMatch(logo, /gradient/i);
});

test("session list and detail pane have independent vertical scrolling", () => {
  assert.match(stylesheet, /\.session-list\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*scroll/is);
  assert.match(stylesheet, /\.workspace\s*\{[^}]*height:\s*100vh[^}]*overflow-y:\s*scroll/is);
  assert.match(stylesheet, /scrollbar-gutter:\s*stable/i);
});

test("launcher returns the local URL without opening it automatically", () => {
  assert.match(launcher, /url\s*=\s*\$viewerUrl/i);
  assert.doesNotMatch(launcher, /Start-Process\s+\$viewerUrl/i);
  assert.match(launcher, /health\.sources\.codex/i);
  assert.match(launcher, /health\.sources\.claude/i);
});

test("Codex and Claude Code are separate selectable session sources", () => {
  assert.match(documentHtml, /data-source="codex"/);
  assert.match(documentHtml, /data-source="claude"/);
  assert.match(documentHtml, /role="tablist"/);
  assert.match(application, /\/api\/sources\/\$\{encodeURIComponent\(state\.source\)\}\/sessions/);
  assert.match(application, /state\.detailCache\.clear\(\)/);
  assert.match(application, /state\.compareIds\s*=\s*\[\]/);
  assert.match(server, /listClaudeSessions/);
  assert.doesNotMatch(application, /fetchJson\("\/api\/sessions"\)/);
});

test("sessions are grouped by normalized project path and ordered by recent activity", () => {
  assert.equal(typeof sessionGroups?.groupSessionsByProject, "function", "session grouping should be implemented");
  const groups = sessionGroups.groupSessionsByProject([
    { id: "alpha-old", cwd: "D:\\work\\alpha", updatedAt: "2026-08-22T10:00:00Z" },
    { id: "unknown", cwd: null, updatedAt: "2026-08-21T10:00:00Z" },
    { id: "beta", cwd: "/work/beta", updatedAt: "2026-08-24T10:00:00Z" },
    { id: "alpha-new", cwd: "d:/work/alpha/", updatedAt: "2026-08-23T10:00:00Z" },
  ]);
  assert.deepEqual(groups.map((group) => group.name), ["beta", "alpha", "未知项目"]);
  assert.deepEqual(groups[1].sessions.map((session) => session.id), ["alpha-new", "alpha-old"]);
  assert.equal(groups[1].path, "D:\\work\\alpha");
});

test("project groups expose independent accessible collapse controls", () => {
  assert.match(application, /groupSessionsByProject\(sessions\)/);
  assert.match(application, /data-project-toggle=/);
  assert.match(application, /aria-expanded=/);
  assert.match(application, /state\.collapsedProjects\.has\(group\.key\)/);
  assert.match(stylesheet, /\.project-session-list\[hidden\]\s*\{\s*display:\s*none/is);
});

test("system prompt metrics count Unicode characters and estimate Codex tokens", () => {
  assert.equal(typeof promptAnalysis?.analyzePromptText, "function", "analyzePromptText should be implemented");
  assert.deepEqual(promptAnalysis.analyzePromptText("abc中文"), {
    characterCount: 5,
    estimatedTokens: 3,
  });
  assert.equal(promptAnalysis.estimateCodexTokens("a".repeat(40)), 10);
  assert.equal(promptAnalysis.countCharacters("😀中文"), 3);
});

test("system prompt comparison aligns changed lines and highlights exact changed text", () => {
  assert.equal(typeof promptAnalysis?.buildSideBySideDiff, "function", "buildSideBySideDiff should be implemented");
  const rows = promptAnalysis.buildSideBySideDiff("same\nold value\ntail", "same\nnew value\ntail");
  assert.deepEqual(rows.map((row) => row.kind), ["unchanged", "changed", "unchanged"]);
  assert.deepEqual(promptAnalysis.splitChangedText("old value", "new value"), {
    prefix: "",
    leftChanged: "old",
    rightChanged: "new",
    suffix: " value",
  });
  assert.deepEqual(promptAnalysis.summarizeDiff(rows), {
    changedRows: 1,
    removedLines: 1,
    addedLines: 1,
    unchangedLines: 2,
  });
});
