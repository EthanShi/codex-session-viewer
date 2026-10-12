import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { analyzePromptText } from "../../assets/prompt-analysis.mjs";

export function getClaudeRoot(env = process.env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return path.resolve(configured || path.join(os.homedir(), ".claude"));
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

async function listProjectSessionFiles(claudeRoot) {
  const projectsRoot = path.join(claudeRoot, "projects");
  let projects;
  try {
    projects = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const groups = await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map(async (project) => {
        const projectDirectory = path.join(projectsRoot, project.name);
        try {
          const entries = await readdir(projectDirectory, { withFileTypes: true });
          return entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"))
            .map((entry) => path.join(projectDirectory, entry.name));
        } catch {
          return [];
        }
      }),
  );
  return groups.flat();
}

function idFromPath(filePath) {
  return path.basename(filePath, ".jsonl");
}

function contentParts(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((part) => part && typeof part === "object") : [];
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  return contentParts(content)
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (typeof part.thinking === "string") return part.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function stringifyValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function queryAttachmentLabels(content) {
  const counts = new Map();
  const labels = [];
  for (const part of contentParts(content)) {
    if (["text", "input_text", "tool_result"].includes(part.type)) continue;
    const label = part.type === "image" ? "image" : part.type === "document" ? "document" : part.type || "attachment";
    const count = (counts.get(label) || 0) + 1;
    counts.set(label, count);
    labels.push(`${label} ${count}`);
  }
  return labels;
}

function isHumanQuery(item) {
  if (item?.type !== "user" || item.isMeta || item.isSidechain) return false;
  const content = item.message?.content;
  if (typeof content === "string") return Boolean(content.trim());
  return contentParts(content).some(
    (part) => ["text", "input_text"].includes(part.type) && String(part.text || "").trim(),
  );
}

function updateTimestamp(current, candidate, comparison) {
  if (!candidate || Number.isNaN(new Date(candidate).getTime())) return current;
  if (!current) return candidate;
  return comparison(new Date(candidate).getTime(), new Date(current).getTime()) ? candidate : current;
}

export async function summarizeFile(filePath, { onRecord, onMalformed, checkCanceled } = {}) {
  const fileStats = await stat(filePath);
  let id = idFromPath(filePath);
  let title = "";
  let lastPrompt = "";
  let agentName = "";
  let preview = "";
  let timestamp = null;
  let updatedAt = null;
  let cwd = null;
  let model = null;
  let version = null;
  let gitBranch = null;
  let entrypoint = null;
  let turnCount = 0;
  const contextTexts = new Set();
  const contextStats = { systemPromptCharacters: 0, estimatedSystemPromptTokens: 0 };

  for await (const item of jsonLines(filePath, { onMalformed, checkCanceled })) {
    if (onRecord) await onRecord(item);
    id = String(item.sessionId || id);
    timestamp = updateTimestamp(timestamp, item.timestamp, (left, right) => left < right);
    updatedAt = updateTimestamp(updatedAt, item.timestamp, (left, right) => left > right);
    cwd = item.cwd || cwd;
    version = item.version || version;
    gitBranch = item.gitBranch || gitBranch;
    entrypoint = item.entrypoint || entrypoint;

    if (item.type === "ai-title" && item.aiTitle) title = String(item.aiTitle).trim();
    if (item.type === "last-prompt" && item.lastPrompt) lastPrompt = String(item.lastPrompt).trim();
    if (item.type === "agent-name" && item.agentName) agentName = String(item.agentName).trim();
    if (item.type === "assistant") model = item.message?.model || model;
    if (item.type === "user" && item.isMeta && !item.isSidechain) {
      const context = textFromContent(item.message?.content).trim();
      if (context) {
        const digest = createHash("sha256").update(context).digest("hex");
        if (!contextTexts.has(digest)) {
          contextTexts.add(digest);
          const stats = analyzePromptText(context);
          contextStats.systemPromptCharacters += stats.characterCount;
          contextStats.estimatedSystemPromptTokens += stats.estimatedTokens;
        }
      }
    }
    if (isHumanQuery(item)) {
      const query = textFromContent(item.message?.content).trim();
      turnCount += 1;
      if (!preview) preview = query;
    }
  }


  return {
    id,
    source: "claude",
    title:
      title ||
      preview.split(/\r?\n/)[0]?.slice(0, 90) ||
      lastPrompt.split(/\r?\n/)[0]?.slice(0, 90) ||
      (agentName ? `Agent · ${agentName}` : `Session ${id.slice(0, 8)}`),
    preview: preview.slice(0, 220),
    timestamp: timestamp || fileStats.birthtime.toISOString(),
    updatedAt: updatedAt || fileStats.mtime.toISOString(),
    cwd,
    model,
    version,
    gitBranch,
    originator: entrypoint ? `claude-code/${entrypoint}` : "claude-code",
    turnCount,
    systemPromptCount: contextTexts.size,
    ...contextStats,
    archived: false,
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

export async function listClaudeSessions(claudeRoot = getClaudeRoot()) {
  const files = await listProjectSessionFiles(claudeRoot);
  const scanned = await mapLimited(files, 6, summarizeFile);
  const byId = new Map();
  const errors = [];
  for (const result of scanned) {
    if (!result || result.error) {
      if (result?.error) errors.push({ filePath: result.item, message: result.error.message });
      continue;
    }
    const previous = byId.get(result.id);
    if (!previous || new Date(result.updatedAt) > new Date(previous.updatedAt)) byId.set(result.id, result);
  }
  const sessions = [...byId.values()].sort(
    (left, right) => new Date(right.updatedAt || right.timestamp) - new Date(left.updatedAt || left.timestamp),
  );
  return {
    source: "claude",
    claudeRoot,
    sessions,
    errors,
    capabilities: { archives: false, promptKind: "persisted-context" },
    scannedAt: new Date().toISOString(),
  };
}

function newTurn(id, timestamp, ordinal) {
  return {
    id: id || `turn-${ordinal}`,
    ordinal,
    startedAt: timestamp || null,
    completedAt: null,
    durationMs: null,
    status: "running",
    model: null,
    cwd: null,
    query: "",
    queryAttachments: [],
    thinking: [],
    hiddenReasoningCount: 0,
    assistantMessages: [],
    toolCalls: [],
    steps: [],
    _calls: new Map(),
    _pendingOutputs: new Map(),
  };
}

function finalizeTurn(turn) {
  if (!turn) return null;
  for (const [callId, pending] of turn._pendingOutputs) {
    const call = {
      id: callId,
      name: "tool result",
      kind: "orphan-result",
      timestamp: pending.timestamp,
      input: "",
      output: pending.output,
      outputTimestamp: pending.timestamp,
    };
    turn.toolCalls.push(call);
    turn.steps.push({
      ordinal: turn.steps.length + 1,
      startedAt: pending.timestamp,
      thinking: [],
      hiddenReasoningCount: 0,
      assistantMessages: [],
      toolCalls: [call],
    });
  }
  delete turn._calls;
  delete turn._pendingOutputs;
  turn.steps = turn.steps.map((step, index) => ({ ...step, ordinal: index + 1 }));
  if (turn.status === "running") turn.status = "incomplete";
  if (!Number.isFinite(turn.durationMs) && turn.startedAt && turn.completedAt) {
    const duration = new Date(turn.completedAt).getTime() - new Date(turn.startedAt).getTime();
    if (Number.isFinite(duration) && duration >= 0) turn.durationMs = duration;
  }
  return turn;
}

function formatToolResult(part) {
  if (part?.content != null) return stringifyValue(part.content);
  return stringifyValue(part);
}

function applyToolResult(turn, callId, output, timestamp) {
  const stableId = callId || `result-${turn.toolCalls.length + turn._pendingOutputs.size + 1}`;
  const call = turn._calls.get(stableId);
  if (call) {
    call.output = output;
    call.outputTimestamp = timestamp || null;
  } else {
    turn._pendingOutputs.set(stableId, { output, timestamp: timestamp || null });
  }
}

export async function readClaudeSession(filePath) {
  const metadata = { filePath, archived: false, originator: "claude-code" };
  const systemPrompts = [];
  const contextSeen = new Set();
  const turns = [];
  let current = null;
  let ordinal = 0;
  let contextOrdinal = 0;

  function addContext(content, timestamp) {
    const text = String(content || "").trim();
    if (!text || contextSeen.has(text)) return;
    contextSeen.add(text);
    systemPrompts.push({
      label: `Persisted context ${++contextOrdinal}`,
      content: text,
      timestamp: timestamp || null,
      kind: "context",
      ...analyzePromptText(text),
    });
  }

  function beginTurn(query, item) {
    if (current) turns.push(finalizeTurn(current));
    current = newTurn(item.uuid || item.promptId, item.timestamp, ++ordinal);
    current.query = query;
    current.queryAttachments = queryAttachmentLabels(item.message?.content);
    current.cwd = item.cwd || null;
    return current;
  }

  function getTurn(item) {
    if (!current) current = newTurn(item?.uuid, item?.timestamp, ++ordinal);
    return current;
  }

  for await (const item of jsonLines(filePath)) {
    metadata.id = item.sessionId || metadata.id;
    metadata.sessionId = item.sessionId || metadata.sessionId;
    metadata.cwd = item.cwd || metadata.cwd;
    metadata.version = item.version || metadata.version;
    metadata.gitBranch = item.gitBranch || metadata.gitBranch;
    metadata.entrypoint = item.entrypoint || metadata.entrypoint;
    metadata.sessionKind = item.sessionKind || metadata.sessionKind;
    metadata.timestamp = metadata.timestamp || item.timestamp || null;

    if (item.type === "ai-title" && item.aiTitle) metadata.aiTitle = String(item.aiTitle);
    if (item.type === "agent-name" && item.agentName) metadata.agentName = String(item.agentName);

    if (item.type === "user" && item.isMeta && !item.isSidechain) {
      addContext(textFromContent(item.message?.content), item.timestamp);
      continue;
    }

    if (isHumanQuery(item)) {
      beginTurn(textFromContent(item.message?.content).trim(), item);
      continue;
    }

    if (item.type === "user" && !item.isSidechain) {
      const turn = getTurn(item);
      for (const part of contentParts(item.message?.content)) {
        if (part.type !== "tool_result") continue;
        applyToolResult(turn, part.tool_use_id, formatToolResult(part), item.timestamp);
        if (part.is_error && turn.status === "running") turn.status = "tool-error";
      }
      continue;
    }

    if (item.type === "assistant" && !item.isSidechain) {
      const turn = getTurn(item);
      const message = item.message || {};
      const isApiError = Boolean(item.isApiErrorMessage);
      turn.model = message.model || turn.model;
      metadata.model = message.model || metadata.model;
      const step = {
        ordinal: turn.steps.length + 1,
        startedAt: item.timestamp || null,
        thinking: [],
        hiddenReasoningCount: 0,
        assistantMessages: [],
        toolCalls: [],
      };
      for (const part of contentParts(message.content)) {
        if (part.type === "thinking") {
          if (String(part.thinking || "").trim()) {
            const thought = { text: String(part.thinking).trim(), kind: "thinking", timestamp: item.timestamp || null };
            turn.thinking.push(thought);
            step.thinking.push(thought);
          } else {
            turn.hiddenReasoningCount += 1;
            step.hiddenReasoningCount += 1;
          }
        } else if (part.type === "text" && String(part.text || "").trim()) {
          const assistantMessage = {
            text: String(part.text).trim(),
            phase: isApiError
              ? "error"
              : ["end_turn", "stop_sequence"].includes(message.stop_reason)
                ? "final"
                : "assistant",
            timestamp: item.timestamp || null,
          };
          turn.assistantMessages.push(assistantMessage);
          step.assistantMessages.push(assistantMessage);
        } else if (part.type === "tool_use") {
          const call = {
            id: part.id || `tool-${turn.toolCalls.length + 1}`,
            name: part.name || "tool call",
            kind: "tool",
            timestamp: item.timestamp || null,
            input: stringifyValue(part.input),
            output: "",
            outputTimestamp: null,
          };
          turn.toolCalls.push(call);
          step.toolCalls.push(call);
          turn._calls.set(call.id, call);
          if (turn._pendingOutputs.has(call.id)) {
            const pending = turn._pendingOutputs.get(call.id);
            call.output = pending.output;
            call.outputTimestamp = pending.timestamp;
            turn._pendingOutputs.delete(call.id);
          }
        }
      }
      if (step.thinking.length || step.hiddenReasoningCount || step.assistantMessages.length || step.toolCalls.length) {
        turn.steps.push(step);
      }
      if (isApiError) {
        turn.status = "aborted: API error";
        turn.completedAt = item.timestamp || turn.completedAt;
      } else if (["end_turn", "stop_sequence"].includes(message.stop_reason)) {
        turn.status = "complete";
        turn.completedAt = item.timestamp || turn.completedAt;
      }
      continue;
    }

    if (item.type === "system" && item.subtype === "turn_duration" && current) {
      current.durationMs = Number.isFinite(item.durationMs) ? item.durationMs : current.durationMs;
      current.completedAt = item.timestamp || current.completedAt;
      if (current.status === "running") current.status = "complete";
    }
  }

  if (current) turns.push(finalizeTurn(current));
  metadata.id = String(metadata.id || idFromPath(filePath));
  metadata.turnCount = turns.length;
  metadata.systemPromptCount = systemPrompts.length;
  metadata.systemPromptCharacters = systemPrompts.reduce((total, prompt) => total + prompt.characterCount, 0);
  metadata.estimatedSystemPromptTokens = systemPrompts.reduce((total, prompt) => total + prompt.estimatedTokens, 0);
  return { metadata, systemPrompts, turns };
}
