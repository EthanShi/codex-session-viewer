import { DatabaseSync } from "node:sqlite";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

export const SCHEMA_VERSION = 2;

export function sourceKey(source, root) {
  const resolved = path.resolve(root);
  return `${source}:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
}

function configure(db, writable) {
  db.exec("PRAGMA cache_size=-16384; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA busy_timeout=5000;");
  if (writable) db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
}

function initialize(db) {
  transaction(db, () => {
  const previousVersion = db.prepare("PRAGMA user_version").get().user_version;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      source_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT,
      index_fingerprint TEXT,
      errors_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL,
      path TEXT NOT NULL,
      session_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT,
      active_generation INTEGER NOT NULL DEFAULT 0,
      visible INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT,
      fallback_title TEXT,
      fallback_updated_at TEXT,
      errors_json TEXT NOT NULL DEFAULT '[]',
      file_mtime_ms REAL,
      observed_fingerprint TEXT,
      summary_fingerprint TEXT,
      body_fingerprint TEXT,
      UNIQUE(source_key, path)
    );
    CREATE INDEX IF NOT EXISTS files_source ON files(source_key, visible);
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      block_no INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      search_text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id, generation, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
      search_text, content='chunks', content_rowid='id',
      tokenize='trigram case_sensitive 1', detail=none, columnsize=0
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunk_fts(rowid, search_text) VALUES(new.id, new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
    END;
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(files)").all().map((column) => column.name));
  for (const [name, type] of [["file_mtime_ms", "REAL"], ["observed_fingerprint", "TEXT"], ["summary_fingerprint", "TEXT"], ["body_fingerprint", "TEXT"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
  }
  if (previousVersion < 2) db.exec(`UPDATE files SET observed_fingerprint=COALESCE(observed_fingerprint,fingerprint),
    summary_fingerprint=COALESCE(summary_fingerprint,CASE WHEN summary_json IS NOT NULL THEN fingerprint END),
    body_fingerprint=COALESCE(body_fingerprint,CASE WHEN active_generation>0 THEN fingerprint END);`);
  db.exec(`CREATE INDEX IF NOT EXISTS files_range ON files(source_key,file_mtime_ms);
    PRAGMA user_version=${SCHEMA_VERSION};`);
  });
}

export async function openWriterStore(databasePath) {
  await mkdir(path.dirname(databasePath), { recursive: true });
  let db;
  let recoveryError = null;
  try {
    db = new DatabaseSync(databasePath);
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version && version !== 1 && version !== SCHEMA_VERSION) throw new Error(`Search cache schema ${version} is incompatible with ${SCHEMA_VERSION}`);
    // Check the small catalog, not every persisted body and FTS page at startup.
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='files'").get()) {
      const check = db.prepare("PRAGMA quick_check('files')").get();
      if (Object.values(check)[0] !== "ok") throw new Error(`Search cache integrity check failed: ${Object.values(check)[0]}`);
    }
    configure(db, true);
    initialize(db);
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* Failed opening may leave no connection. */ }
    }
    recoveryError = { message: `Rebuilt search cache: ${error.message}`, cacheRecovery: true };
    // Keep a recoverable copy instead of concealing a damaged cache. The input
    // session stores are never modified by recovery.
    const backup = `${databasePath}.invalid-${Date.now()}`;
    try { await rename(databasePath, backup); } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    for (const suffix of ["-wal", "-shm"]) {
      try { await rename(databasePath + suffix, backup + suffix); } catch (failure) {
        if (failure.code !== "ENOENT") throw failure;
      }
    }
    db = new DatabaseSync(databasePath);
    configure(db, true);
    initialize(db);
  }
  // An interrupted writer may have committed staging batches. They were never
  // made active, so remove them before exposing the cache to the read worker.
  const stale = db.prepare(`SELECT c.id FROM chunks c JOIN files f ON f.id=c.file_id
    WHERE c.generation != f.active_generation ORDER BY c.id LIMIT 128`);
  const removeChunk = db.prepare("DELETE FROM chunks WHERE id=?");
  while (true) {
    const rows = stale.all();
    if (!rows.length) break;
    db.exec("BEGIN");
    try {
      for (const row of rows) removeChunk.run(row.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { db, recoveryError };
}

export function openReaderStore(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  configure(db, false);
  return db;
}

export function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function deleteChunks(db, condition, args) {
  const find = db.prepare(`SELECT id FROM chunks WHERE ${condition} ORDER BY id LIMIT 128`);
  const remove = db.prepare("DELETE FROM chunks WHERE id=?");
  while (true) {
    const rows = find.all(...args);
    if (!rows.length) return;
    transaction(db, () => { for (const row of rows) remove.run(row.id); });
    await new Promise((resolve) => setImmediate(resolve));
  }
}
