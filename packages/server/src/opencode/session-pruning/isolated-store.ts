import type { DatabaseSync } from "node:sqlite"
import { pruneRequestSchema, type PruneRequest, type PruneResult } from "./contract"
import { planPrune, revision } from "./planner"

// Intentionally memory-only in this draft. No filename discovery or live DB
// connection exists. A SQLite lock alone does not fence Core execution/caches.
export function pruneIsolatedMessage(db: DatabaseSync, input: PruneRequest, directory: string): PruneResult {
  const request = pruneRequestSchema.parse(input)
  const databases = db.prepare("PRAGMA database_list").all()
  if (databases.length !== 1 || databases[0].file !== "" || db.isTransaction) {
    return { status: "blocked", reason: "maintenance_required" }
  }
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' LIMIT 1").get()
    || db.prepare("SELECT 1 FROM event WHERE aggregate_id = ? LIMIT 1").get(request.sessionID)) {
    return { status: "blocked", reason: "unsupported_storage" }
  }
  db.exec("BEGIN IMMEDIATE")
  try {
    const session = db.prepare("SELECT directory FROM session_v2 WHERE id = ?").get(request.sessionID)
    if (session?.directory !== directory) return { status: "blocked", reason: "not_deletable" }
    const row = db.prepare("SELECT type, data FROM session_message WHERE session_id = ? AND id = ?")
      .get(request.sessionID, request.messageID)
    if (!row || row.type !== "assistant" || typeof row.data !== "string") return { status: "blocked", reason: "not_deletable" }
    const plan = planPrune(JSON.parse(row.data), request)
    if (plan.status !== "planned") return plan
    // SQLite preserves all message metadata. Only the content array is changed.
    const update = db.prepare("UPDATE session_message SET data = json_set(data, '$.content', json(?)) WHERE session_id = ? AND id = ? AND data = ?")
      .run(JSON.stringify(plan.content), request.sessionID, request.messageID, row.data)
    if (update.changes !== 1) return { status: "blocked", reason: "conflict" }
    db.exec("COMMIT")
    return { status: "pruned", messageID: request.messageID, revision: revision(plan.content), removedCount: request.indexes.length }
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK")
  }
}
