import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { createSearchService } from "./lib/search-service.mjs";
import { openWriterStore, sourceKey } from "./lib/search-store.mjs";

test("Codex uses a fresh lazy cache while Claude reuses the old shared database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-cache-compat-"));
  const options = { sources: { codex: { root: path.join(root, "codex") }, claude: { root: path.join(root, "claude") } }, cacheRoot: path.join(root, "cache") };
  const id = "11111111-2222-4333-8444-555555555555";
  const timestamp = "2026-11-06T06:54:09.000Z";
  const complete = item => ({ timestamp, type: "event_msg", payload: { type: "item_completed", turn_id: "t", item } });
  const command = complete({ type: "CommandExecution", id: "command", command: ["echo", "run"], aggregated_output: "full-only-marker", status: "completed", exit_code: 0 });
  let service;
  try {
    const codexPath = path.join(options.sources.codex.root, "sessions", `${id}.jsonl`);
    const claudePath = path.join(options.sources.claude.root, "projects", "test", `${id}.jsonl`);
    await mkdir(path.dirname(codexPath), { recursive: true });
    await mkdir(path.dirname(claudePath), { recursive: true });
    await writeFile(codexPath, [
      { timestamp, type: "session_meta", payload: { id, history_mode: "paginated" } },
      complete({ type: "UserMessage", id: "user", content: [{ type: "text", text: "fresh question" }] }),
      command, command,
      complete({ type: "AgentMessage", id: "a", content: [{ type: "Text", text: "safe-text" }, { type: "image", data: "SECRETIMAGE" }] }),
      complete({ type: "Reasoning", id: "r", summary_text: ["safe-summary"], encrypted_content: "SECRETCIPHER" }),
    ].map(JSON.stringify).join("\n"));
    await writeFile(claudePath, JSON.stringify({ timestamp, sessionId: id, type: "user", message: { content: "claude-cache-marker" } }));
    const identity = Object.entries(options.sources).sort(([a], [b]) => a.localeCompare(b))
      .map(([source, value]) => [source, process.platform === "win32" ? value.root.toLowerCase() : value.root]);
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
    const legacyPath = path.join(options.cacheRoot, `index-v1-${key}.sqlite`);
    const { db } = await openWriterStore(legacyPath);
    try {
      for (const [source, file, text] of [["codex", codexPath, "stale-codex-marker"], ["claude", claudePath, "claude-cache-marker"]]) {
        const stats = await stat(file), fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
        const summary = { id, title: text, preview: text, timestamp, updatedAt: timestamp, filePath: file, logModifiedAt: stats.mtime.toISOString(), archived: false };
        const sourceId = sourceKey(source, options.sources[source].root);
        db.prepare("INSERT INTO sources(source_key,generation) VALUES(?,7)").run(sourceId);
        const result = db.prepare(`INSERT INTO files(source_key,path,session_id,fingerprint,observed_fingerprint,summary_fingerprint,body_fingerprint,
          active_generation,visible,summary_json,fallback_title,fallback_updated_at,file_mtime_ms) VALUES(?,?,?,?,?,?,?,11,1,?,?,?,?)`)
          .run(sourceId, file, id, fingerprint, fingerprint, fingerprint, fingerprint, JSON.stringify(summary), text, timestamp, stats.mtimeMs);
        db.prepare("INSERT INTO chunks(file_id,generation,block_no,ordinal,kind,text,search_text) VALUES(?,11,0,0,'user',?,?)")
          .run(result.lastInsertRowid, text, text);
      }
    } finally { db.close(); }
    service = createSearchService(options);
    assert.notEqual(service.databasePaths.codex, legacyPath);
    assert.equal(service.databasePaths.claude, legacyPath);
    const listing = await service.list("codex");
    assert.equal(listing.sessions[0].preview, "fresh question");
    function inspect(file, sql) {
      const db = new DatabaseSync(file, { readOnly: true });
      try { return db.prepare(sql).all(); } finally { db.close(); }
    }
    assert.equal(inspect(service.databasePath, "SELECT count(*) n FROM chunks")[0].n, 0);
    assert.equal((await service.search("codex", "full-only-marker")).matches.length, 1);
    assert.equal((await service.search("codex", "stale-codex-marker")).matches.length, 0);
    for (const marker of ["SECRETIMAGE", "SECRETCIPHER"]) assert.equal((await service.search("codex", marker)).matches.length, 0);
    assert.equal(inspect(service.databasePath, "SELECT count(*) n FROM chunks WHERE text='full-only-marker'")[0].n, 1, "duplicate completed records share one search block");
    const codexGeneration = (await service.search("codex", "full-only-marker")).generation;
    assert.equal((await service.search("claude", "claude-cache-marker")).matches.length, 1);
    assert.equal(service.status("claude").rebuiltFiles, 0);
    assert.equal(inspect(legacyPath, "SELECT active_generation FROM files WHERE source_key LIKE 'claude:%'")[0].active_generation, 11);
    assert.equal(inspect(legacyPath, "SELECT count(*) n FROM chunks WHERE text='stale-codex-marker'")[0].n, 1, "old Codex cache remains intact");
    await service.close();
    service = createSearchService(options);
    assert.equal((await service.search("codex", "full-only-marker")).generation, codexGeneration);
    assert.equal(service.status("codex").rebuiltFiles, 0);
    assert.equal((await service.search("claude", "claude-cache-marker")).matches.length, 1);
    assert.equal(service.status("claude").rebuiltFiles, 0);
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
