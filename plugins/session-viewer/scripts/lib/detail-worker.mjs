import { parentPort, workerData } from "node:worker_threads";
import { readSession } from "./session-parser.mjs";
import { readClaudeSession } from "./claude-session-parser.mjs";

try {
  const { source, summary } = workerData;
  const detail = source === "codex"
    ? await readSession(summary.filePath, summary.archived)
    : await readClaudeSession(summary.filePath);
  // Serialize the selected session away from the HTTP event loop as well.
  parentPort.postMessage({ body: JSON.stringify({ summary, ...detail }) });
} catch (error) {
  parentPort.postMessage({ error: error?.message || "Could not read session" });
}
