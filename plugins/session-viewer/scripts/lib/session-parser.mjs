import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createQueryCollector, isoTime, eventTime } from "./codex-events.mjs";
import { createTurnAssembler } from "./codex-turns.mjs";
import { analyzePromptText } from "../../assets/prompt-analysis.mjs";

const SESSION_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function getCodexRoot(env = process.env) {
  const configured = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return path.resolve(configured || path.join(os.homedir(), ".codex"));
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function* jsonLines(filePath, { onMalformed, checkCanceled } = {}) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try { for await (const line of lines) {
    checkCanceled?.();
    lineNumber += 1;
    if (!line.trim()) continue;
    const value = parseLine(line);
    if (value) yield value;
    else if (onMalformed) onMalformed({ filePath, lineNumber, message: `Malformed JSONL record on line ${lineNumber}` });
  } } finally { lines.close(); input.destroy(); }
}

async function walkJsonl(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkJsonl(entryPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
      found.push(entryPath);
    }
  }
  return found;
}

export async function readSessionIndex(codexRoot, { strict = false, onMalformed } = {}) {
  const names = new Map();
  const indexPath = path.join(codexRoot, "session_index.jsonl");
  try {
    for await (const item of jsonLines(indexPath, { onMalformed })) {
      if (item?.id && item?.thread_name) {
        names.set(String(item.id), {
          title: String(item.thread_name),
          updatedAt: isoTime(item.updated_at),
        });
      }
    }
  } catch (error) {
    if (strict && error.code !== "ENOENT") throw error;
    // The rollout metadata remains usable when an index is absent or mid-write.
  }
  return names;
}

function idFromPath(filePath) {
  return path.basename(filePath).match(SESSION_ID_RE)?.[1] || path.basename(filePath, ".jsonl");
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (part.type === "input_image" || part.type === "output_image") return "[image]";
      if (part.type === "input_audio" || part.type === "output_audio") return "[audio]";
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function instructionText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(instructionText).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (value.content) return textFromContent(value.content);
  if (value.instructions) return instructionText(value.instructions);
  return "";
}

export async function summarizeFile(filePath, archived, indexNames, { onRecord, onMalformed, checkCanceled } = {}) {
  const fileStats = await stat(filePath);
  let id = idFromPath(filePath);
  let timestamp = null;
  let updatedAt = fileStats.mtime.toISOString();
  let cwd = null;
  let model = null;
  let originator = null;
  let parentThreadId = null;
  let agentNickname = null;
  let agentPath = null;
  let turnCount = 0;
  const queries = createQueryCollector(220);
  let historyMode;
  const systemPromptTexts = new Set();
  const systemPromptStats = { systemPromptCharacters: 0, estimatedSystemPromptTokens: 0 };

  function captureSystemPrompt(value) {
    const content = String(value || "").trim();
    if (!content) return;
    const digest = createHash("sha256").update(content).digest("hex");
    if (systemPromptTexts.has(digest)) return;
    systemPromptTexts.add(digest);
    const stats = analyzePromptText(content);
    systemPromptStats.systemPromptCharacters += stats.characterCount;
    systemPromptStats.estimatedSystemPromptTokens += stats.estimatedTokens;
  }

  for await (const item of jsonLines(filePath, { onMalformed, checkCanceled })) {
    if (onRecord) await onRecord(item);
    queries.add(item);
    const payload = item?.payload || {};
    if (item?.type === "session_meta") {
      id = String(payload.id || payload.session_id || id);
      timestamp = isoTime(payload.timestamp, item.timestamp) || timestamp;
      historyMode = payload.history_mode || historyMode;
      cwd = payload.cwd || cwd;
      model = payload.model || payload.model_provider || model;
      originator = payload.originator || originator;
      parentThreadId = payload.parent_thread_id || parentThreadId;
      agentNickname = payload.agent_nickname || agentNickname;
      agentPath = payload.agent_path || agentPath;
      captureSystemPrompt(instructionText(payload.base_instructions));
    } else if (item?.type === "turn_context") {
      model = payload.model || model;
      cwd = payload.cwd || cwd;
    } else if (item?.type === "response_item" && payload.type === "message" && ["developer", "system"].includes(payload.role)) {
      captureSystemPrompt(textFromContent(payload.content));
    }

    if (payload.type === "task_started") turnCount += 1;
    if (["task_complete", "turn_aborted"].includes(payload.type)) updatedAt = eventTime(payload, "completed_at", item.timestamp) || updatedAt;
  }

  const preview = queries.preview();
  const indexed = indexNames.get(id);
  return {
    id,
    title:
      indexed?.title ||
      preview.split(/\r?\n/)[0]?.slice(0, 90) ||
      (agentNickname ? `Agent · ${agentNickname}` : `Session ${id.slice(0, 8)}`),
    preview: preview.slice(0, 220),
    timestamp: timestamp || fileStats.birthtime.toISOString(),
    updatedAt: indexed?.updatedAt || updatedAt,
    cwd,
    model,
    originator,
    parentThreadId,
    historyMode,
    agentNickname,
    agentPath,
    turnCount,
    systemPromptCount: systemPromptTexts.size,
    ...systemPromptStats,
    archived,
    size: fileStats.size,
    filePath,
  };
}

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error, item: items[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function listSessions(codexRoot = getCodexRoot()) {
  const [activeFiles, archivedFiles, indexNames] = await Promise.all([
    walkJsonl(path.join(codexRoot, "sessions")),
    walkJsonl(path.join(codexRoot, "archived_sessions")),
    readSessionIndex(codexRoot),
  ]);
  const files = [
    ...activeFiles.map((filePath) => ({ filePath, archived: false })),
    ...archivedFiles.map((filePath) => ({ filePath, archived: true })),
  ];
  const scanned = await mapLimited(files, 6, ({ filePath, archived }) =>
    summarizeFile(filePath, archived, indexNames),
  );

  const byId = new Map();
  const errors = [];
  for (const result of scanned) {
    if (!result || result.error) {
      if (result?.error) errors.push({ filePath: result.item?.filePath, message: result.error.message });
      continue;
    }
    const previous = byId.get(result.id);
    if (!previous || (previous.archived && !result.archived)) byId.set(result.id, result);
  }

  const sessions = [...byId.values()].sort(
    (a, b) => new Date(b.updatedAt || b.timestamp) - new Date(a.updatedAt || a.timestamp),
  );
  return { codexRoot, sessions, errors, scannedAt: new Date().toISOString() };
}

export async function readSession(filePath, archived = false) {
  const systemPrompts = [];
  const systemSeen = new Set();
  const assembler = createTurnAssembler();
  const metadata = { filePath, archived };
  let developerOrdinal = 0;

  function addSystemPrompt(label, text, timestamp, kind) {
    const content = String(text || "").trim();
    if (!content || systemSeen.has(content)) return;
    systemSeen.add(content);
    systemPrompts.push({ label, content, timestamp: timestamp || null, kind, ...analyzePromptText(content) });
  }

  for await (const item of jsonLines(filePath)) {
    const payload = item?.payload || {};
    const eventType = payload.type;
    const timestamp = isoTime(item?.timestamp);

    if (item?.type === "session_meta") {
      Object.assign(metadata, {
        id: payload.id || payload.session_id || metadata.id,
        sessionId: payload.session_id || payload.id || metadata.sessionId,
        timestamp: isoTime(payload.timestamp, timestamp),
        historyMode: payload.history_mode || metadata.historyMode,
        cwd: payload.cwd || metadata.cwd,
        originator: payload.originator || metadata.originator,
        cliVersion: payload.cli_version || metadata.cliVersion,
        source: payload.source || metadata.source,
        threadSource: payload.thread_source || metadata.threadSource,
        modelProvider: payload.model_provider || metadata.modelProvider,
        parentThreadId: payload.parent_thread_id || metadata.parentThreadId,
        agentNickname: payload.agent_nickname || metadata.agentNickname,
        agentPath: payload.agent_path || metadata.agentPath,
        contextWindow: payload.context_window || metadata.contextWindow,
      });
      addSystemPrompt("Base instructions", instructionText(payload.base_instructions), timestamp, "base");
      continue;
    }

    assembler.observe(item);
    if (item.type === "turn_context") {
      metadata.model = payload.model || metadata.model;
      metadata.cwd = payload.cwd || metadata.cwd;
    }
    if (item.type === "response_item" && eventType === "message" && ["developer", "system"].includes(payload.role)) {
      addSystemPrompt((payload.role === "system" ? "System" : "Developer") + " prompt " + (++developerOrdinal), textFromContent(payload.content), timestamp, payload.role);
    }
  }
  const turns = assembler.finish();
  metadata.id = String(metadata.id || idFromPath(filePath));
  metadata.turnCount = turns.length;
  metadata.systemPromptCount = systemPrompts.length;
  metadata.systemPromptCharacters = systemPrompts.reduce((total, prompt) => total + prompt.characterCount, 0);
  metadata.estimatedSystemPromptTokens = systemPrompts.reduce((total, prompt) => total + prompt.estimatedTokens, 0);
  return { metadata, systemPrompts, turns };
}
