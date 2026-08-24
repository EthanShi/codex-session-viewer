#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getClaudeRoot,
  listClaudeSessions,
  readClaudeSession,
} from "./lib/claude-session-parser.mjs";
import {
  getCodexRoot,
  listSessions as listCodexSessions,
  readSession as readCodexSession,
} from "./lib/session-parser.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(scriptDirectory);
const assetsRoot = path.join(pluginRoot, "assets");

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const host = "127.0.0.1";
const requestedPort = Number(readArgument("--port", process.env.SESSION_VIEWER_PORT || "3847"));
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3847;
const codexRoot = path.resolve(readArgument("--codex-root", getCodexRoot()));
const claudeRoot = path.resolve(readArgument("--claude-root", getClaudeRoot()));

const sessionSources = {
  codex: {
    root: codexRoot,
    list: listCodexSessions,
    read: (summary) => readCodexSession(summary.filePath, summary.archived),
    label: "Codex",
  },
  claude: {
    root: claudeRoot,
    list: listClaudeSessions,
    read: (summary) => readClaudeSession(summary.filePath),
    label: "Claude Code",
  },
};

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.css", { file: "app.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/ui-preferences.mjs", { file: "ui-preferences.mjs", type: "text/javascript; charset=utf-8" }],
  ["/ui-render.mjs", { file: "ui-render.mjs", type: "text/javascript; charset=utf-8" }],
  ["/prompt-analysis.mjs", { file: "prompt-analysis.mjs", type: "text/javascript; charset=utf-8" }],
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
  response.writeHead(status, commonHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function serveStatic(response, descriptor) {
  try {
    const body = await readFile(path.join(assetsRoot, descriptor.file));
    response.writeHead(200, commonHeaders(descriptor.type));
    response.end(body);
  } catch {
    sendError(response, 404, "Asset not found");
  }
}

async function requestHandler(request, response) {
  if (request.method !== "GET") {
    sendError(response, 405, "Read-only server: GET requests only");
    return;
  }

  const url = new URL(request.url || "/", `http://${host}`);
  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      sources: {
        codex: { root: codexRoot },
        claude: { root: claudeRoot },
      },
    });
    return;
  }

  const sessionRoute = url.pathname.match(/^\/api\/sources\/([a-z-]+)\/sessions(?:\/([^/]+))?$/i);
  if (sessionRoute) {
    const sourceId = sessionRoute[1].toLowerCase();
    const source = sessionSources[sourceId];
    if (!source) {
      sendError(response, 404, "Unknown session source");
      return;
    }
    if (!sessionRoute[2]) {
      try {
        const listing = await source.list(source.root);
        sendJson(response, 200, { ...listing, source: sourceId });
      } catch (error) {
        sendError(response, 500, error?.message || `Could not scan ${source.label} sessions`);
      }
      return;
    }

    let id;
    try {
      id = decodeURIComponent(sessionRoute[2]);
    } catch {
      sendError(response, 400, "Invalid session id");
      return;
    }
    if (!/^[0-9a-z-]{1,80}$/i.test(id)) {
      sendError(response, 400, "Invalid session id");
      return;
    }
    try {
      const listing = await source.list(source.root);
      const summary = listing.sessions.find((session) => session.id === id);
      if (!summary) {
        sendError(response, 404, "Session not found");
        return;
      }
      const detail = await source.read(summary);
      sendJson(response, 200, { summary, ...detail });
    } catch (error) {
      sendError(response, 500, error?.message || `Could not read the ${source.label} session`);
    }
    return;
  }

  const descriptor = staticFiles.get(url.pathname);
  if (descriptor) {
    await serveStatic(response, descriptor);
    return;
  }
  sendError(response, 404, "Not found");
}

const server = createServer((request, response) => {
  requestHandler(request, response).catch((error) => {
    if (!response.headersSent) sendError(response, 500, error?.message || "Unexpected error");
    else response.end();
  });
});

server.on("error", (error) => {
  console.error(`Session Viewer failed to start: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Session Viewer: http://${host}:${actualPort}`);
  console.log(`Codex sessions: ${codexRoot}`);
  console.log(`Claude Code sessions: ${claudeRoot}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
