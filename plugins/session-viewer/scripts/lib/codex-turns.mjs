import { normalizeCodexEvent, createQueryCollector, isoTime, eventTime } from "./codex-events.mjs";

function stringify(value) {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return value == null ? "" : JSON.stringify(value, null, 2);
}

// Delay projection until EOF: a late completion can enrich an earlier turn.
export function createTurnAssembler() {
  const turns = [], byTurn = new Map(), owners = new Map();
  const queries = createQueryCollector();
  let current = null, anonymous = 0;
  function getTurn(id, timestamp, activate = false) {
    let turn = id ? byTurn.get(id) : current;
    if (!turn) {
      turn = { id: id || `implicit-${turns.length}`, startedAt: timestamp, completedAt: null,
        durationMs: null, status: "incomplete", model: null, cwd: null, entries: [], keys: new Map() };
      turns.push(turn); byTurn.set(turn.id, turn);
    }
    if (activate || !current) current = turn;
    return turn;
  }
  const category = event => event.kind === "tool-output" ? "tool" : event.kind;
  function merge(entry, event) {
    const firstTimestamp = entry.timestamp;
    const hidden = entry.hidden || event.hidden;
    if (event.kind !== "tool-output" && event.rank >= (entry.rank || 0)) {
      const { output, outputRank, outputTimestamp, hidden } = entry;
      Object.assign(entry, event, { output, outputRank, outputTimestamp });
      if (event.kind === "reasoning" && !event.summary.length && !event.content.length) entry.hidden = hidden || event.hidden;
    }
    if (event.output !== undefined && event.rank >= (entry.outputRank || 0)) {
      entry.output = event.output; entry.outputRank = event.rank; entry.outputTimestamp = event.outputTimestamp;
    }
    entry.timestamp = firstTimestamp || event.timestamp;
    if (entry.kind === "reasoning" && !entry.summary?.length && !entry.content?.length) entry.hidden = hidden;
  }
  function add(turn, event) {
    const group = category(event), keys = event.ids.map(id => `${group}:${id}`);
    const matches = [...new Set(keys.map(key => turn.keys.get(key)).filter(Boolean))]
      .sort((a, b) => turn.entries.indexOf(a) - turn.entries.indexOf(b));
    let entry = matches[0];
    if (!entry) {
      entry = { kind: group, id: event.ids[0] || `anonymous-${++anonymous}`, timestamp: event.timestamp, rank: 0 };
      turn.entries.push(entry);
    }
    for (const other of matches.slice(1)) {
      merge(entry, other);
      turn.entries.splice(turn.entries.indexOf(other), 1);
      for (const [key, value] of turn.keys) if (value === other) turn.keys.set(key, entry);
    }
    merge(entry, event);
    for (const key of keys) {
      turn.keys.set(key, entry);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(turn);
    }
  }
  return {
    observe(record) {
      const p = record.payload || {}, timestamp = isoTime(record.timestamp);
      if (p.type === "task_started" || record.type === "turn_context") {
        const turn = getTurn(p.turn_id, timestamp, true);
        if (p.type === "task_started") turn.startedAt = eventTime(p, "started_at", timestamp);
        else { turn.model = p.model || turn.model; turn.cwd = p.cwd || turn.cwd; }
        queries.add(record);
        return;
      }
      const event = normalizeCodexEvent(record);
      if (event) {
        let target = event.turnId;
        if (!target && event.kind === "tool-output") {
          const candidates = new Set(event.ids.flatMap(id => [...(owners.get(`tool:${id}`) || [])]));
          if (candidates.size === 1) target = [...candidates][0].id;
        }
        const turn = getTurn(target, event.timestamp);
        queries.add(record, { ...event, turnId: turn.id });
        if (!["query", "agent-query"].includes(event.kind)) add(turn, event);
      } else if (p.type === "context_compacted") {
        add(getTurn(p.turn_id, timestamp), { kind: "reasoning", ids: [], rank: 1, timestamp,
          summary: [], content: ["Context was compacted during this turn."], hidden: false, context: true });
      } else if (["task_complete", "turn_aborted"].includes(p.type)) {
        const turn = getTurn(p.turn_id, timestamp);
        turn.completedAt = eventTime(p, "completed_at", timestamp);
        turn.startedAt = eventTime(p, "started_at", turn.startedAt);
        turn.durationMs = p.duration_ms ?? turn.durationMs;
        turn.status = p.type === "task_complete" ? "complete" : `aborted${p.reason ? `: ${p.reason}` : ""}`;
        turn.finalFallback = p.last_agent_message;
      }
    },
    finish() {
      return turns.map(turn => {
        const selected = queries.entries(turn.id);
        const value = { id: turn.id, startedAt: turn.startedAt, completedAt: turn.completedAt,
          durationMs: turn.durationMs, status: turn.status, model: turn.model, cwd: turn.cwd,
          query: selected.map(e => e.text).filter(Boolean).join("\n\n"), queryAttachments: selected.flatMap(e => e.attachments),
          thinking: [], hiddenReasoningCount: 0, assistantMessages: [], toolCalls: [], steps: [] };
        let step;
        function nextStep(force = false) {
          if (!step || force) {
            step = { ordinal: value.steps.length + 1, startedAt: null, thinking: [], hiddenReasoningCount: 0, assistantMessages: [], toolCalls: [] };
            value.steps.push(step);
          }
          return step;
        }
        for (const entry of turn.entries) {
          const active = nextStep(entry.kind !== "tool" && step?.toolCalls.length > 0);
          active.startedAt ||= entry.timestamp;
          if (entry.kind === "assistant") {
            if (!entry.text?.trim()) continue;
            const message = { id: entry.id, text: entry.text.trim(), phase: entry.phase, timestamp: entry.timestamp };
            value.assistantMessages.push(message); active.assistantMessages.push(message);
          } else if (entry.kind === "reasoning") {
            for (const [kind, texts] of [["summary", entry.summary || []], [entry.context ? "context" : "thinking", entry.content || []]]) {
              for (const text of texts) {
                const thought = { id: entry.id, text: text.trim(), kind, timestamp: entry.timestamp };
                value.thinking.push(thought); active.thinking.push(thought);
              }
            }
            if (entry.hidden && !entry.summary?.length && !entry.content?.length) {
              value.hiddenReasoningCount++; active.hiddenReasoningCount++;
            }
          } else if (entry.kind === "tool") {
            const call = { id: entry.id, name: entry.name || "tool result", kind: entry.toolKind || "orphan-result",
              input: stringify(entry.input), output: entry.toolKind === "command" && typeof entry.output === "string" ? entry.output : stringify(entry.output), timestamp: entry.timestamp,
              outputTimestamp: entry.outputTimestamp || null, status: entry.status, exitCode: entry.exitCode, durationMs: entry.durationMs };
            value.toolCalls.push(call); active.toolCalls.push(call);
          }
        }
        if (!value.assistantMessages.length && turn.finalFallback) {
          const message = { text: turn.finalFallback, phase: "final", timestamp: turn.completedAt };
          value.assistantMessages.push(message); nextStep(Boolean(step?.toolCalls.length)).assistantMessages.push(message);
        }
        value.steps = value.steps.filter(s => s.thinking.length || s.hiddenReasoningCount || s.assistantMessages.length || s.toolCalls.length)
          .map((s, index) => ({ ...s, ordinal: index + 1 }));
        return value;
      }).filter(t => t.query || t.queryAttachments.length || t.thinking.length || t.hiddenReasoningCount || t.assistantMessages.length || t.toolCalls.length)
        .map((t, index) => ({ ...t, ordinal: index + 1 }));
    },
  };
}
