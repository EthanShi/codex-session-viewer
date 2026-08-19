import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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

async function* jsonLines(filePath) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const value = parseLine(line);
    if (value) yield value;
  }
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

async function readSessionIndex(codexRoot) {
  const names = new Map();
  const indexPath = path.join(codexRoot, "session_index.jsonl");
  try {
    for await (const item of jsonLines(indexPath)) {
      if (item?.id && item?.thread_name) {
        names.set(String(item.id), {
          title: String(item.thread_name),
          updatedAt: item.updated_at || null,
        });
      }
    }
  } catch {
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

function attachmentLabels(payload) {
  const labels = [];
  const groups = [
    ["images", "image"],
    ["local_images", "local image"],
    ["audio", "audio"],
    ["local_audio", "local audio"],
  ];
  for (const [field, label] of groups) {
    const values = Array.isArray(payload?.[field]) ? payload[field] : [];
    values.forEach((_, index) => labels.push(`${label} ${index + 1}`));
  }
  return labels;
}

async function summarizeFile(filePath, archived, indexNames) {
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
  let preview = "";
  const systemPromptTexts = new Set();

  function captureSystemPrompt(value) {
    const content = String(value || "").trim();
    if (content) systemPromptTexts.add(content);
  }

  for await (const item of jsonLines(filePath)) {
    const payload = item?.payload || {};
    if (item?.type === "session_meta") {
      id = String(payload.id || payload.session_id || id);
      timestamp = payload.timestamp || item.timestamp || timestamp;
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
    } else if (item?.type === "response_item" && payload.type === "message" && payload.role === "developer") {
      captureSystemPrompt(textFromContent(payload.content));
    }

    if (payload.type === "task_started") turnCount += 1;
    if (payload.type === "user_message" && !preview) preview = String(payload.message || "").trim();
    if (item?.type === "response_item" && payload.type === "agent_message" && !preview) {
      preview = textFromContent(payload.content).trim();
    }
    if (payload.type === "task_complete") updatedAt = payload.completed_at || item.timestamp || updatedAt;
  }

  const indexed = indexNames.get(id);
  const systemPromptStats = [...systemPromptTexts].reduce(
    (total, content) => {
      const stats = analyzePromptText(content);
      total.systemPromptCharacters += stats.characterCount;
      total.estimatedSystemPromptTokens += stats.estimatedTokens;
      return total;
    },
    { systemPromptCharacters: 0, estimatedSystemPromptTokens: 0 },
  );
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

function newTurn(id, timestamp, ordinal) {
  return {
    id: id || `implicit-${ordinal}`,
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
    _queryCandidates: [],
    _calls: new Map(),
    _pendingOutputs: new Map(),
    _activeStep: null,
  };
}

function pushUniqueText(items, entry) {
  const text = String(entry.text || "").trim();
  if (!text || items.some((item) => item.text === text)) return null;
  const stored = { ...entry, text };
  items.push(stored);
  return stored;
}

function createStep(turn, timestamp) {
  const step = {
    ordinal: turn.steps.length + 1,
    startedAt: timestamp || null,
    thinking: [],
    hiddenReasoningCount: 0,
    assistantMessages: [],
    toolCalls: [],
  };
  turn.steps.push(step);
  turn._activeStep = step;
  return step;
}

function reasoningStep(turn, timestamp) {
  if (!turn._activeStep || turn._activeStep.toolCalls.length > 0) {
    return createStep(turn, timestamp);
  }
  return turn._activeStep;
}

function toolStep(turn, timestamp) {
  return turn._activeStep || createStep(turn, timestamp);
}

function messageStep(turn, timestamp) {
  if (!turn._activeStep || turn._activeStep.toolCalls.length > 0) {
    return createStep(turn, timestamp);
  }
  return turn._activeStep;
}

function pushThinking(turn, entry) {
  const stored = pushUniqueText(turn.thinking, entry);
  if (!stored) return null;
  reasoningStep(turn, entry.timestamp).thinking.push(stored);
  return stored;
}

function pushAssistantMessage(turn, entry) {
  const stored = pushUniqueText(turn.assistantMessages, entry);
  if (!stored) return null;
  messageStep(turn, entry.timestamp).assistantMessages.push(stored);
  return stored;
}

function ensureToolCall(turn, callId, name, input, timestamp, kind = "tool") {
  const stableId = callId || `${kind}-${turn.toolCalls.length + 1}`;
  let call = turn._calls.get(stableId);
  if (!call) {
    call = {
      id: stableId,
      name: name || "tool call",
      kind,
      timestamp: timestamp || null,
      input: stringifyValue(input),
      output: "",
      outputTimestamp: null,
    };
    turn.toolCalls.push(call);
    toolStep(turn, timestamp).toolCalls.push(call);
    turn._calls.set(stableId, call);
    if (turn._pendingOutputs.has(stableId)) {
      const pending = turn._pendingOutputs.get(stableId);
      call.output = pending.output;
      call.outputTimestamp = pending.timestamp;
      turn._pendingOutputs.delete(stableId);
    }
  } else {
    if (!call.name || call.name === "tool call") call.name = name || call.name;
    if (!call.input) call.input = stringifyValue(input);
  }
  return call;
}

function applyToolOutput(turn, callId, output, timestamp) {
  const stableId = callId || `result-${turn.toolCalls.length + turn._pendingOutputs.size + 1}`;
  const formatted = stringifyValue(output);
  const call = turn._calls.get(stableId);
  if (call) {
    call.output = formatted;
    call.outputTimestamp = timestamp || null;
  } else {
    turn._pendingOutputs.set(stableId, { output: formatted, timestamp: timestamp || null });
  }
}

function finalizeTurn(turn) {
  if (!turn) return null;
  if (!turn.query) {
    turn.query = [...turn._queryCandidates].reverse().find((candidate) => candidate.trim()) || "";
  }
  for (const [callId, pending] of turn._pendingOutputs) {
    const call = ensureToolCall(turn, callId, "tool result", "", pending.timestamp, "orphan-result");
    call.output = pending.output;
  }
  delete turn._queryCandidates;
  delete turn._calls;
  delete turn._pendingOutputs;
  delete turn._activeStep;
  turn.steps = turn.steps
    .filter(
      (step) =>
        step.thinking.length ||
        step.hiddenReasoningCount ||
        step.assistantMessages.length ||
        step.toolCalls.length,
    )
    .map((step, index) => ({ ...step, ordinal: index + 1 }));
  if (turn.status === "running") turn.status = "incomplete";
  return turn;
}

function hasTurnContent(turn) {
  return Boolean(
    turn.query ||
      turn._queryCandidates.length ||
      turn.thinking.length ||
      turn.assistantMessages.length ||
      turn.toolCalls.length,
  );
}

export async function readSession(filePath, archived = false) {
  const systemPrompts = [];
  const systemSeen = new Set();
  const turns = [];
  const metadata = { filePath, archived };
  let current = null;
  let ordinal = 0;
  let developerOrdinal = 0;

  function addSystemPrompt(label, text, timestamp, kind) {
    const content = String(text || "").trim();
    if (!content || systemSeen.has(content)) return;
    systemSeen.add(content);
    systemPrompts.push({ label, content, timestamp: timestamp || null, kind, ...analyzePromptText(content) });
  }

  function beginTurn(id, timestamp) {
    if (current && hasTurnContent(current)) turns.push(finalizeTurn(current));
    current = newTurn(id, timestamp, ++ordinal);
    return current;
  }

  function getTurn(timestamp) {
    return current || beginTurn(null, timestamp);
  }

  for await (const item of jsonLines(filePath)) {
    const payload = item?.payload || {};
    const eventType = payload.type;
    const timestamp = item?.timestamp || null;

    if (item?.type === "session_meta") {
      Object.assign(metadata, {
        id: payload.id || payload.session_id || metadata.id,
        sessionId: payload.session_id || payload.id || metadata.sessionId,
        timestamp: payload.timestamp || timestamp,
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

    if (eventType === "task_started") {
      beginTurn(payload.turn_id, payload.started_at || timestamp);
      continue;
    }

    if (item?.type === "turn_context") {
      const turnId = payload.turn_id;
      if (!current) beginTurn(turnId, timestamp);
      else if (turnId && current.id !== turnId && hasTurnContent(current)) beginTurn(turnId, timestamp);
      else if (turnId) current.id = turnId;
      const turn = getTurn(timestamp);
      turn.model = payload.model || turn.model;
      turn.cwd = payload.cwd || turn.cwd;
      metadata.model = payload.model || metadata.model;
      metadata.cwd = payload.cwd || metadata.cwd;
      continue;
    }

    if (item?.type === "response_item" && eventType === "message") {
      const text = textFromContent(payload.content);
      if (payload.role === "developer") {
        developerOrdinal += 1;
        addSystemPrompt(`Developer prompt ${developerOrdinal}`, text, timestamp, "developer");
      } else if (payload.role === "user") {
        if (text) getTurn(timestamp)._queryCandidates.push(text);
      } else if (payload.role === "assistant") {
        pushAssistantMessage(getTurn(timestamp), {
          text,
          phase: payload.phase || "assistant",
          timestamp,
        });
      }
      continue;
    }

    if (eventType === "user_message") {
      const turn = getTurn(timestamp);
      turn.query = String(payload.message || "").trim();
      turn.queryAttachments = attachmentLabels(payload);
      continue;
    }

    if (item?.type === "response_item" && eventType === "agent_message") {
      const text = textFromContent(payload.content);
      if (text) getTurn(timestamp)._queryCandidates.push(text);
      continue;
    }

    if (eventType === "agent_message") {
      pushAssistantMessage(getTurn(timestamp), {
        text: payload.message,
        phase: payload.phase || "assistant",
        timestamp,
      });
      continue;
    }

    if (eventType === "agent_reasoning") {
      pushThinking(getTurn(timestamp), {
        text: payload.text,
        kind: "thinking",
        timestamp,
      });
      continue;
    }

    if (item?.type === "response_item" && eventType === "reasoning") {
      const turn = getTurn(timestamp);
      const step = reasoningStep(turn, timestamp);
      const summaries = Array.isArray(payload.summary) ? payload.summary : [];
      let added = 0;
      for (const summary of summaries) {
        const text = typeof summary === "string" ? summary : summary?.text;
        if (String(text || "").trim()) {
          const stored = pushUniqueText(turn.thinking, { text, kind: "summary", timestamp });
          if (stored) {
            step.thinking.push(stored);
            added += 1;
          }
        }
      }
      if (!added && payload.encrypted_content) {
        turn.hiddenReasoningCount += 1;
        step.hiddenReasoningCount += 1;
      }
      continue;
    }

    if (item?.type === "response_item" && (eventType === "custom_tool_call" || eventType === "function_call")) {
      ensureToolCall(
        getTurn(timestamp),
        payload.call_id || payload.id,
        payload.name,
        payload.input ?? payload.arguments,
        timestamp,
        eventType === "function_call" ? "function" : "custom",
      );
      continue;
    }

    if (
      item?.type === "response_item" &&
      (eventType === "custom_tool_call_output" || eventType === "function_call_output")
    ) {
      applyToolOutput(getTurn(timestamp), payload.call_id || payload.id, payload.output, timestamp);
      continue;
    }

    if (eventType === "context_compacted") {
      pushThinking(getTurn(timestamp), {
        text: "Context was compacted during this turn.",
        kind: "context",
        timestamp,
      });
      continue;
    }

    if (eventType === "task_complete") {
      const turn = getTurn(timestamp);
      turn.id = payload.turn_id || turn.id;
      turn.completedAt = payload.completed_at || timestamp;
      turn.startedAt = payload.started_at || turn.startedAt;
      turn.durationMs = payload.duration_ms ?? turn.durationMs;
      turn.status = "complete";
      if (!turn.assistantMessages.length && payload.last_agent_message) {
        pushAssistantMessage(turn, {
          text: payload.last_agent_message,
          phase: "final",
          timestamp: turn.completedAt,
        });
      }
      continue;
    }

    if (eventType === "turn_aborted") {
      const turn = getTurn(timestamp);
      turn.id = payload.turn_id || turn.id;
      turn.completedAt = payload.completed_at || timestamp;
      turn.durationMs = payload.duration_ms ?? turn.durationMs;
      turn.status = `aborted${payload.reason ? `: ${payload.reason}` : ""}`;
    }
  }

  if (current && hasTurnContent(current)) turns.push(finalizeTurn(current));
  metadata.id = String(metadata.id || idFromPath(filePath));
  metadata.turnCount = turns.length;
  metadata.systemPromptCount = systemPrompts.length;
  metadata.systemPromptCharacters = systemPrompts.reduce((total, prompt) => total + prompt.characterCount, 0);
  metadata.estimatedSystemPromptTokens = systemPrompts.reduce((total, prompt) => total + prompt.estimatedTokens, 0);
  return { metadata, systemPrompts, turns };
}
