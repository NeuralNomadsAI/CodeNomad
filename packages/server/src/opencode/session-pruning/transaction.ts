import type { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { pruneAllRequestSchema, pruneRequestSchema, pruneResultSchema, type PruneRequest, type PruneResult } from "./contract"
import { planPrune, previewContent, revision } from "./planner"
import { canonicalContent } from "./revision"
import { canReleaseMedia, projectStoredMedia, releaseDroppedMedia } from "./media-blob"

const MESSAGE_LIMIT = 16 * 1024 * 1024
type BlockReason = Extract<PruneResult, { status: "blocked" }>["reason"]

// Internal kernel. No async callback or network work is allowed while the
// SQLite write lock is held. Production callers must supply the claim fence.
export function pruneTransaction(
  db: DatabaseSync, input: PruneRequest | Omit<PruneRequest, "indexes">, authorize: () => BlockReason | undefined,
  receiptPrefix?: string, allTechnical = false,
): PruneResult {
  const selected = allTechnical ? undefined : pruneRequestSchema.parse(input)
  const request = selected ?? pruneAllRequestSchema.parse(input)
  if (db.isTransaction) return { status: "blocked", reason: "maintenance_required" }
  db.exec("BEGIN IMMEDIATE")
  try {
    const blocked = authorize()
    if (blocked) return { status: "blocked", reason: blocked }
    const key = receiptPrefix && receiptPrefix + createHash("sha256")
      .update(canonicalContent(selected
        ? { ...request, indexes: [...selected.indexes].sort((a, b) => a - b) }
        : { ...request, allTechnical: true })).digest("hex")
    if (key) {
      const receipt = db.prepare("SELECT value FROM kv WHERE key=?").get(key)
      if (typeof receipt?.value === "string") {
        const result = pruneResultSchema.parse(JSON.parse(receipt.value))
        if (result.status !== "pruned" || result.messageID !== request.messageID) return { status: "blocked", reason: "unsupported_storage" }
        return result
      }
    }
    const row = db.prepare(`SELECT type, data, length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE session_id=? AND id=?
      AND length(CAST(data AS BLOB)) <= ?`).get(request.sessionID, request.messageID, MESSAGE_LIMIT)
    if (!row || row.type !== "assistant" || typeof row.data !== "string") return { status: "blocked", reason: "not_deletable" }
    const data = JSON.parse(row.data)
    // Compare what the caller hashed from native reads; the same budget bounds the native form.
    const projection = projectStoredMedia(db, data, Number(row.bytes), MESSAGE_LIMIT)
    if (projection.status === "limit") return { status: "blocked", reason: "not_deletable" }
    if (projection.status === "unsupported" || !canReleaseMedia(db, data)) return { status: "blocked", reason: "unsupported_storage" }
    const preview = previewContent(projection.data)
    if (preview.status !== "preview") return preview
    const indexes = selected?.indexes ?? preview.parts.map(part => part.index)
    if (!indexes.length) return { status: "blocked", reason: "not_deletable" }
    const plan = planPrune(data, { ...request, indexes }, projection.data)
    if (plan.status !== "planned") return plan
    const update = db.prepare("UPDATE session_message SET data=json_set(data,'$.content',json(?)) WHERE session_id=? AND id=? AND data=?")
      .run(JSON.stringify(plan.content), request.sessionID, request.messageID, row.data)
    if (update.changes !== 1) return { status: "blocked", reason: "conflict" }
    releaseDroppedMedia(db, request.sessionID, request.messageID, data, { ...data, content: plan.content })
    const result: PruneResult = { status: "pruned", messageID: request.messageID, revision: revision(plan.projected), removedCount: indexes.length }
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
