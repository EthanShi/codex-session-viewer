export async function assertSupportedRuntime(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error("Node.js 22.13 or newer is required to run Session Viewer.");
  }
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(":memory:");
    database.exec("CREATE VIRTUAL TABLE runtime_check USING fts5(text, tokenize='trigram', detail=none)");
  } catch {
    throw new Error("Session Viewer requires Node.js 22.13+ with built-in SQLite FTS5 support (Node.js 23 requires 23.4+).");
  } finally {
    database?.close();
  }
}
