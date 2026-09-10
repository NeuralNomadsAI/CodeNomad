import type { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { pruneRequestSchema, pruneResultSchema, type PruneRequest, type PruneResult } from "./contract"
import { planPrune, revision } from "./planner"
import { canonicalContent } from "./revision"

type BlockReason = Extract<PruneResult, { status: "blocked" }>["reason"]

// Internal kernel. No async callback or network work is allowed while the
// SQLite write lock is held. Production callers must supply the claim fence.
export function pruneTransaction(
  db: DatabaseSync, input: PruneRequest, authorize: () => BlockReason | undefined,
  receiptPrefix?: string,
): PruneResult {
  const request = pruneRequestSchema.parse(input)
  if (db.isTransaction) return { status: "blocked", reason: "maintenance_required" }
  db.exec("BEGIN IMMEDIATE")
  try {
    const blocked = authorize()
    if (blocked) return { status: "blocked", reason: blocked }
    const key = receiptPrefix && receiptPrefix + createHash("sha256")
      .update(canonicalContent({ ...request, indexes: [...request.indexes].sort((a, b) => a - b) })).digest("hex")
    if (key) {
      const receipt = db.prepare("SELECT value FROM kv WHERE key=?").get(key)
      if (typeof receipt?.value === "string") {
        const result = pruneResultSchema.parse(JSON.parse(receipt.value))
        if (result.status !== "pruned" || result.messageID !== request.messageID) return { status: "blocked", reason: "unsupported_storage" }
        return result
      }
    }
    const row = db.prepare(`SELECT type, data FROM session_message WHERE session_id=? AND id=?
      AND length(CAST(data AS BLOB)) <= 16777216`).get(request.sessionID, request.messageID)
    if (!row || row.type !== "assistant" || typeof row.data !== "string") return { status: "blocked", reason: "not_deletable" }
    const plan = planPrune(JSON.parse(row.data), request)
    if (plan.status !== "planned") return plan
    const update = db.prepare("UPDATE session_message SET data=json_set(data,'$.content',json(?)) WHERE session_id=? AND id=? AND data=?")
      .run(JSON.stringify(plan.content), request.sessionID, request.messageID, row.data)
    if (update.changes !== 1) return { status: "blocked", reason: "conflict" }
    const result: PruneResult = { status: "pruned", messageID: request.messageID, revision: revision(plan.content), removedCount: request.indexes.length }
    if (key) {
      const now = Date.now()
      // A receipt contains hashes/counts/IDs only, not deleted tool payloads.
      db.prepare("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?)")
        .run(key, JSON.stringify(result), now, now)
    }
    db.exec("COMMIT")
    return result
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK")
  }
}
