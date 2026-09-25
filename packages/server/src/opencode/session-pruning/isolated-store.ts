import type { DatabaseSync } from "node:sqlite"
import { type PruneRequest, type PruneResult } from "./contract"
import { pruneTransaction } from "./transaction"
import { storageDirectory } from "./storage-path"

// Intentionally memory-only in this draft. No filename discovery or live DB
// connection exists. A SQLite lock alone does not fence Core execution/caches.
export function pruneIsolatedMessage(db: DatabaseSync, input: PruneRequest, directory: string): PruneResult {
  const databases = db.prepare("PRAGMA database_list").all()
  if (databases.length !== 1 || databases[0].file !== "" || db.isTransaction) {
    return { status: "blocked", reason: "maintenance_required" }
  }
  return pruneTransaction(db, input, () => {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM event WHERE aggregate_id=? LIMIT 1").get(input.sessionID)) return "unsupported_storage"
    const session = db.prepare("SELECT directory FROM session_v2 WHERE id=?").get(input.sessionID)
    return session?.directory === storageDirectory(directory) ? undefined : "not_deletable"
  })
}
