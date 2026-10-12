#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getClaudeRoot } from "./lib/claude-session-parser.mjs";
import { getCodexRoot } from "./lib/session-parser.mjs";
import { createSearchService } from "./lib/search-service.mjs";
import { closeDetailReaders, readSessionDetail } from "./lib/detail-reader.mjs";
import { assertSupportedRuntime } from "./lib/runtime.mjs";
import { createHttpOperations } from "./lib/http-operations.mjs";
import { normalizeDateRange } from "../assets/date-range.mjs";

await assertSupportedRuntime();

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetsRoot = path.join(path.dirname(scriptDirectory), "assets");

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const host = "127.0.0.1";
const requestedPort = Number(readArgument("--port", process.env.SESSION_VIEWER_PORT || "3847"));
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3847;
const sources = {
  codex: { root: path.resolve(readArgument("--codex-root", getCodexRoot())) },
  claude: { root: path.resolve(readArgument("--claude-root", getClaudeRoot())) },
};
const searchService = createSearchService({ sources, cacheRoot: readArgument("--cache-root", undefined) });
const operations = createHttpOperations({ getStatus: (source) => searchService.status(source) });

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.css", { file: "app.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/search-controller.mjs", { file: "search-controller.mjs", type: "text/javascript; charset=utf-8" }],
  ["/fetch-api.mjs", { file: "fetch-api.mjs", type: "text/javascript; charset=utf-8" }],
  ["/date-range.mjs", { file: "date-range.mjs", type: "text/javascript; charset=utf-8" }],
  ["/ui-preferences.mjs", { file: "ui-preferences.mjs", type: "text/javascript; charset=utf-8" }],
  ["/ui-render.mjs", { file: "ui-render.mjs", type: "text/javascript; charset=utf-8" }],
  ["/prompt-analysis.mjs", { file: "prompt-analysis.mjs", type: "text/javascript; charset=utf-8" }],
  ["/session-groups.mjs", { file: "session-groups.mjs", type: "text/javascript; charset=utf-8" }],
  ["/icon.svg", { file: "icon.svg", type: "image/svg+xml" }],
]);

function commonHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, commonHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function requestHandler(request, response) {
  if (request.method !== "GET") {
    sendError(response, 405, "Read-only server: GET requests only");
    return;
  }
  const url = new URL(request.url || "/", `http://${host}`);
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, searchVersion: 2, rangeSearch: true, maxRangeDays: 30, memoryRssBytes: process.memoryUsage().rss, sources });
    return;
  }

  const route = url.pathname.match(/^\/api\/sources\/([a-z-]+)\/(sessions(?:\/([^/]+))?|search(?:\/status)?)$/i);
  if (route) {
    const source = route[1].toLowerCase();
    if (!Object.hasOwn(sources, source)) {
      sendError(response, 404, "Unknown session source");
      return;
    }
    if (route[2].toLowerCase() === "search/status") {
      if (url.searchParams.has("job")) {
        const operation = operations.poll(source, url.searchParams.get("job"), { cancel: url.searchParams.get("cancel") === "1" });
        sendJson(response, operation.status, operation.value);
      } else {
        const range = normalizeDateRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
        sendJson(response, 200, searchService.status(source, { range }));
      }
      return;
    }
    if (route[2].toLowerCase() === "search" || !route[3]) {
      const range = normalizeDateRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      const operation = await operations.run(source, (signal, onProgress) => route[2].toLowerCase() === "search"
        ? searchService.search(source, url.searchParams.get("q") || "", { range, signal, onProgress })
        : searchService.list(source, { range, refresh: url.searchParams.get("refresh") === "1", signal, onProgress }), response,
        { range: { from: range.from, to: range.to, timeZone: range.timeZone } });
      sendJson(response, operation.status, operation.value);
      return;
    }
    const detailRange = url.searchParams.has("from") || url.searchParams.has("to")
      ? normalizeDateRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") }) : undefined;
    const controller = new AbortController();
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", onClose);
    try {
      let id;
      try { id = decodeURIComponent(route[3]); }
      catch { sendError(response, 400, "Invalid session id"); return; }
      if (!/^[0-9a-z-]{1,80}$/i.test(id)) { sendError(response, 400, "Invalid session id"); return; }
      const summary = await searchService.resolveSession(source, id, { range: detailRange, signal: controller.signal });
      if (!summary) { sendError(response, 404, "Session not found"); return; }
      const body = await readSessionDetail(source, summary, { signal: controller.signal });
      if (!response.destroyed) {
        response.writeHead(200, commonHeaders("application/json; charset=utf-8"));
        response.end(body);
      }
    } finally {
      response.removeListener("close", onClose);
    }
    return;
  }

  const descriptor = staticFiles.get(url.pathname);
  if (descriptor) {
    try {
      const body = await readFile(path.join(assetsRoot, descriptor.file));
      if (!response.destroyed) {
        response.writeHead(200, commonHeaders(descriptor.type));
        response.end(body);
      }
    } catch { sendError(response, 404, "Asset not found"); }
    return;
  }
  sendError(response, 404, "Not found");
}

const server = createServer((request, response) => {
  requestHandler(request, response).catch((error) => {
    if (response.destroyed || response.writableEnded) return;
    if (!response.headersSent) sendError(response, error?.statusCode || 500, error?.message || "Unexpected error");
    else response.end();
  });
});

server.on("error", async (error) => {
  console.error(`Session Viewer failed to start: ${error.message}`);
  operations.close();
  await Promise.allSettled([searchService.close(), closeDetailReaders()]);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`Session Viewer: http://${host}:${typeof address === "object" && address ? address.port : port}`);
  console.log(`Codex sessions: ${sources.codex.root}`);
  console.log(`Claude Code sessions: ${sources.claude.root}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    operations.close();
    server.close();
    server.closeAllConnections();
    await Promise.allSettled([searchService.close(), closeDetailReaders()]);
    process.exit(0);
  });
}
