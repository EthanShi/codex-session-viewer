// Shared interpretation of persisted Codex records. No I/O and no decryption.
export const CODEX_PARSER_VERSION = 2;

export function isoTime(value, fallback = null, milliseconds = false) {
  if (typeof value === "number" && Number.isFinite(value)) value *= milliseconds ? 1 : 1000;
  else if (typeof value !== "string" || !value.trim()) value = null;
  const date = value == null ? null : new Date(value);
  if (date && Number.isFinite(date.getTime())) return date.toISOString();
  return fallback == null ? null : isoTime(fallback);
}

export function eventTime(payload, field, fallback) {
  return isoTime(payload[`${field}_ms`], null, true) || isoTime(payload[field], fallback);
}

export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => typeof part === "string" ? part :
    /(?:image|audio|video|encrypted)/i.test(part?.type || "") ? "" : part?.text || "").filter(Boolean).join("\n\n");
}

export function attachments(payload) {
  const labels = [];
  for (const [field, label] of [["images", "image"], ["local_images", "local image"], ["audio", "audio"], ["local_audio", "local audio"]]) {
    if (Array.isArray(payload[field])) payload[field].forEach((_, i) => labels.push(`${label} ${i + 1}`));
  }
  for (const part of Array.isArray(payload.content) ? payload.content : []) {
    const kind = String(part?.type || "").match(/image|audio|video/i)?.[0]?.toLowerCase();
    if (kind) labels.push(`${kind} ${labels.filter(label => label.startsWith(kind)).length + 1}`);
  }
  return labels;
}

const ids = (...values) => [...new Set(values.filter(value => typeof value === "string" && value))];
const texts = value => (Array.isArray(value) ? value : value ? [value] : [])
  .map(part => typeof part === "string" ? part : part?.text).filter(text => typeof text === "string" && text.trim());

export function normalizeCodexEvent(record) {
  const p = record?.payload || {};
  const completed = record?.type === "event_msg" && p.type === "item_completed";
  const item = completed ? p.item || {} : p;
  const base = {
    ids: ids(item.call_id, item.id),
    turnId: p.turn_id || p.turn_attribution?.turn_id || item.internal_chat_message_metadata_passthrough?.turn_id || null,
    timestamp: completed ? eventTime(p, "started_at", record.timestamp) : isoTime(record.timestamp),
    outputTimestamp: completed ? eventTime(p, "completed_at", record.timestamp) : isoTime(record.timestamp),
    rank: completed ? 3 : 1,
  };
  if (completed) {
    switch (item.type) {
      case "UserMessage": return { ...base, kind: "query", text: contentText(item.content), attachments: attachments(item) };
      case "AgentMessage": return { ...base, kind: "assistant", text: contentText(item.content) || item.text || "", phase: item.phase || "assistant" };
      case "Plan": return { ...base, kind: "assistant", text: item.text || "", phase: "plan" };
      case "Reasoning": return { ...base, kind: "reasoning", summary: texts(item.summary_text), content: texts(item.raw_content), hidden: false };
      case "CommandExecution": return { ...base, kind: "tool", toolKind: "command", name: "Command execution",
        input: { command: item.command, cwd: item.cwd }, output: item.aggregated_output,
        status: item.status, exitCode: item.exit_code,
        durationMs: item.duration_ms ?? (item.duration ? (item.duration.secs || 0) * 1000 + (item.duration.nanos || 0) / 1e6 : undefined) };
      case "FileChange": return { ...base, kind: "tool", toolKind: "file-change", name: "File change", input: item.changes,
        output: { stdout: item.stdout, stderr: item.stderr }, status: item.status };
      case "SubAgentActivity": return { ...base, kind: "tool", toolKind: "activity", name: `Sub-agent · ${item.kind || "activity"}`,
        input: { agent_thread_id: item.agent_thread_id, agent_path: item.agent_path, model: item.model, reasoning_effort: item.reasoning_effort }, status: item.status };
      case "CollabAgentToolCall": return { ...base, kind: "tool", toolKind: "activity", name: `Collaboration · ${item.tool || "activity"}`,
        input: { sender_thread_id: item.sender_thread_id, receiver_thread_ids: item.receiver_thread_ids, receiver_agents: item.receiver_agents }, output: item.agents_states, status: item.status };
      case "Extension": return { ...base, kind: "tool", toolKind: "activity", name: `Extension · ${item.kind || "activity"}`,
        input: { kind: item.kind, durationMs: item.durationMs }, status: item.status, durationMs: item.durationMs };
      default: return null;
    }
  }
  if (record?.type === "response_item") {
    if (p.type === "message") {
      if (p.role === "user") return { ...base, kind: "query", text: contentText(p.content), attachments: attachments(p) };
      if (p.role === "assistant") return { ...base, kind: "assistant", text: contentText(p.content), phase: p.phase || "assistant" };
    }
    if (p.type === "agent_message") return { ...base, kind: "agent-query", text: contentText(p.content), attachments: [] };
    if (p.type === "reasoning") return { ...base, kind: "reasoning", summary: texts(p.summary), content: texts(p.content), hidden: Boolean(p.encrypted_content) };
    if (["function_call", "custom_tool_call"].includes(p.type)) return { ...base, kind: "tool", name: p.name,
      input: p.input ?? p.arguments, toolKind: p.type === "function_call" ? "function" : "custom" };
    // The output item's own id is not the invocation id.
    if (["function_call_output", "custom_tool_call_output"].includes(p.type)) return { ...base, ids: ids(p.call_id || p.id), kind: "tool-output", output: p.output };
  }
  if (record?.type === "event_msg") {
    if (p.type === "user_message") return { ...base, rank: 2, kind: "query", text: String(p.message || ""), attachments: attachments(p) };
    if (p.type === "agent_message") return { ...base, kind: "assistant", text: p.message || "", phase: p.phase || "assistant" };
    if (p.type === "agent_reasoning") return { ...base, kind: "reasoning", summary: [], content: texts(p.text), hidden: false };
  }
  return null;
}

// Keep only query candidates here, so summary scans never retain tool bodies.
export function createQueryCollector(limit = Infinity) {
  const turns = new Map();
  let current = "implicit-0", implicit = 0;
  return {
    add(record, normalized = normalizeCodexEvent(record)) {
      const p = record.payload || {};
      if (p.type === "task_started" || record.type === "turn_context") current = p.turn_id || `implicit-${++implicit}`;
      if (!normalized || !["query", "agent-query"].includes(normalized.kind)) return;
      const key = normalized.turnId || current;
      if (!turns.has(key)) turns.set(key, []);
      const entries = turns.get(key);
      const previous = normalized.ids.length && entries.find(e => e.kind === normalized.kind && e.ids.some(id => normalized.ids.includes(id)));
      const entry = { ...normalized, text: normalized.text.trim().slice(0, limit) };
      if (previous) { if (entry.rank >= previous.rank) Object.assign(previous, entry); }
      else entries.push(entry);
    },
    entries(turnId) {
      const entries = turns.get(turnId) || [];
      const users = entries.filter(e => e.kind === "query" && (e.text || e.attachments.length));
      const candidates = users.length ? users : entries.filter(e => e.kind === "agent-query");
      const rank = Math.max(0, ...candidates.map(e => e.rank));
      return candidates.filter(e => e.rank === rank);
    },
    preview() {
      // A real user question takes precedence over inherited agent task context.
      const groups = [...turns.keys()].map(key => this.entries(key));
      return groups.flat().find(e => e.kind === "query" && e.text)?.text || groups.flat().find(e => e.text)?.text || "";
    },
  };
}
