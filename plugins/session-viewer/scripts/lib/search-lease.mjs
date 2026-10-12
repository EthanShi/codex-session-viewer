import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";

function busy() {
  return Object.assign(new Error("Search cache is already in use by another viewer"), { statusCode: 409 });
}

function ownerAt(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; return { invalid: true }; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export function acquireWriterLease(databasePath, token) {
  const lockPath = databasePath + ".lock";
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx");
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      closeSync(descriptor);
      return;
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* Write may already have closed it. */ }
        releaseWriterLease(databasePath, token);
      }
      if (error.code !== "EEXIST") throw error;
      const owner = ownerAt(lockPath);
      if (!owner) continue;
      if (owner.invalid) {
        // Another worker may be between exclusive creation and its tiny write.
        // Only recover an abandoned incomplete lease after a generous interval.
        if (Date.now() - statSync(lockPath).mtimeMs < 30000) throw busy();
      } else if (processAlive(owner.pid)) throw busy();
      // Re-read ownership before cleanup; never knowingly remove a successor's
      // live lease after another process has recovered an abandoned one.
      const current = ownerAt(lockPath);
      if (JSON.stringify(current) !== JSON.stringify(owner)) continue;
      try { unlinkSync(lockPath); } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
    }
  }
  throw busy();
}

export function releaseWriterLease(databasePath, token) {
  const lockPath = databasePath + ".lock";
  const owner = ownerAt(lockPath);
  if (!owner || owner.token !== token) return;
  try { unlinkSync(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
