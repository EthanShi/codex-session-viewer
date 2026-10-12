// Only readable, persisted values enter the index. Media payloads and encrypted
// reasoning are deliberately excluded before values are stringified.
const MEDIA_TYPES = /^(?:input_|output_)?(?:image|audio|video)(?:_url)?$/i;
const PRIVATE_KEYS = /^(?:encrypted_content|encrypted_reasoning|base64|base64_data|audio_data|image_data|binary|bytes)$/i;

function cleanText(value) {
  return String(value ?? "").replace(/data:[^;,\s]+;base64,[a-z0-9+/=\r\n]+/gi, "[media]");
}

function scrub(value) {
  if (typeof value === "string") return cleanText(value);
  if (value == null || typeof value !== "object") return value;
  const mediaObject = MEDIA_TYPES.test(String(value.type || ""));
  const base64Object = String(value.type || "").toLowerCase() === "base64";
  if (Array.isArray(value)) return value.map(scrub).filter((part) => part !== undefined);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.test(key)) continue;
    if ((mediaObject || base64Object) && ["data", "buffer", "blob"].includes(key)) continue;
    if (key === "signature" && ["thinking", "reasoning"].includes(value.type)) continue;
    const readable = scrub(child);
    if (readable !== undefined) result[key] = readable;
  }
  return result;
}

function readableValue(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return readableValue(parsed);
    } catch { /* Ordinary text is not JSON. */ }
    return cleanText(value);
  }
  const readable = scrub(value);
  if (readable == null) return "";
  return typeof readable === "string" ? readable : JSON.stringify(readable, null, 2);
}

function* contentTexts(content) {
  if (typeof content === "string") {
    yield cleanText(content);
    return;
  }
  if (!Array.isArray(content)) {
    if (content?.text) yield cleanText(content.text);
    return;
  }
  for (const part of content) {
    if (typeof part === "string") yield cleanText(part);
    else if (part && !MEDIA_TYPES.test(String(part.type || ""))) {
      if (typeof part.text === "string") yield cleanText(part.text);
      if (typeof part.thinking === "string") yield cleanText(part.thinking);
      if (typeof part.reasoning === "string") yield cleanText(part.reasoning);
    }
  }
}

function instructionValue(value) {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(instructionValue).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  if (value.text != null) return cleanText(value.text);
  if (value.content != null) return [...contentTexts(value.content)].join("\n\n");
  if (value.instructions != null) return instructionValue(value.instructions);
  return "";
}

export function* extractReadableText(source, item) {
  function* emit(kind, text) {
    if (typeof text === "string" && text.trim()) yield { kind, text };
  }
  if (source === "codex") {
    const payload = item?.payload || {};
    const type = payload.type;
    if (item?.type === "session_meta" || item?.type === "turn_context") {
      for (const key of ["base_instructions", "developer_instructions", "user_instructions"]) {
        yield* emit("prompt", instructionValue(payload[key]) || readableValue(payload[key]));
      }
    }
    if (item?.type === "response_item" && type === "message") {
      const kind = ["developer", "system"].includes(payload.role) ? "prompt" : payload.role === "user" ? "user" : "assistant";
      for (const text of contentTexts(payload.content)) yield* emit(kind, text);
    } else if (type === "user_message") {
      yield* emit("user", cleanText(payload.message));
    } else if (type === "agent_message") {
      for (const text of contentTexts(payload.content)) yield* emit("assistant", text);
      yield* emit("assistant", cleanText(payload.message));
    } else if (type === "agent_reasoning") {
      yield* emit("reasoning", cleanText(payload.text));
    } else if (item?.type === "response_item" && type === "reasoning") {
      const summaries = Array.isArray(payload.summary) ? payload.summary : payload.summary ? [payload.summary] : [];
      for (const value of summaries) {
        yield* emit("reasoning", typeof value === "string" ? cleanText(value) : cleanText(value?.text));
      }
      for (const text of contentTexts(payload.content)) yield* emit("reasoning", text);
    } else if (["custom_tool_call", "function_call"].includes(type)) {
      yield* emit("tool", cleanText(payload.name));
      yield* emit("tool-input", readableValue(payload.input ?? payload.arguments));
    } else if (["custom_tool_call_output", "function_call_output"].includes(type)) {
      yield* emit("tool-output", readableValue(payload.output));
    } else if (type === "task_complete") {
      yield* emit("assistant", cleanText(payload.last_agent_message));
    } else if (type === "context_compacted") {
      const context = payload.message ?? payload.text;
      yield* emit("context", instructionValue(context) || readableValue(context));
    }
  } else {
    if (item?.type === "user") {
      const kind = item.isMeta ? "context" : "user";
      for (const text of contentTexts(item.message?.content)) yield* emit(kind, text);
      for (const part of Array.isArray(item.message?.content) ? item.message.content : []) {
        if (part?.type === "tool_result") yield* emit("tool-output", readableValue(part.content));
      }
    } else if (item?.type === "assistant") {
      for (const part of Array.isArray(item.message?.content) ? item.message.content : []) {
        if (part?.type === "thinking") yield* emit("reasoning", cleanText(part.thinking));
        else if (part?.type === "tool_use") {
          yield* emit("tool", cleanText(part.name));
          yield* emit("tool-input", readableValue(part.input));
        } else for (const text of contentTexts([part])) yield* emit("assistant", text);
      }
      if (typeof item.message?.content === "string") yield* emit("assistant", cleanText(item.message.content));
    } else if (["summary", "system"].includes(item?.type)) {
      const context = item.content ?? item.message?.content ?? item.message ?? item.summary;
      yield* emit("context", instructionValue(context) || readableValue(context));
    } else if (item?.type === "last-prompt") {
      yield* emit("user", cleanText(item.lastPrompt));
    }
  }
}

export const CHUNK_SIZE = 32 * 1024;
export const CHUNK_OVERLAP = 255;
export const MAX_QUERY_CHARACTERS = 256;

export function* chunkText(text) {
  // Walk code points without materializing an array the size of a tool result.
  let buffer = [];
  for (const character of text) {
    buffer.push(character);
    if (buffer.length === CHUNK_SIZE) {
      yield buffer.join("");
      buffer = buffer.slice(-CHUNK_OVERLAP);
    }
  }
  if (buffer.length) yield buffer.join("");
}

export function trigramQuery(normalized) {
  const characters = [...normalized];
  if (characters.length < 3 || normalized.includes("\0")) return null;
  const candidates = new Set();
  const count = characters.length - 2;
  for (let index = 0; index < Math.min(16, count); index += 1) {
    const offset = count <= 16 ? index : Math.round(index * (count - 1) / 15);
    candidates.add(characters.slice(offset, offset + 3).join(""));
  }
  return [...candidates].map((gram) => `"${gram.replaceAll('"', '""')}"`).join(" AND ");
}

export function matchSnippet(text, normalized, needle) {
  const index = normalized.indexOf(needle);
  if (index < 0) return null;
  // Lowercasing may expand a character (for example U+0130). Translate the
  // folded position back to an original-text offset before producing a snippet.
  let offset = 0;
  let foldedOffset = 0;
  for (const character of text) {
    if (foldedOffset >= index) break;
    foldedOffset += character.toLowerCase().length;
    offset += character.length;
  }
  const prefix = [...text.slice(0, offset)].slice(-48).join("");
  const snippet = [...(prefix + text.slice(offset))].slice(0, 240).join("");
  return snippet;
}
