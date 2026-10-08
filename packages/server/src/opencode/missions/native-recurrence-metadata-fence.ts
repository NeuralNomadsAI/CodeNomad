import type { DatabaseSync } from "node:sqlite"
import { rejectAuthority } from "../../missions/authority-protocol"
/** A schedule belongs to the current native Location, not to a disposable
 * Session. The nonce is rechecked inside the native IMMEDIATE transaction. */
export function validateRecurrenceMetadataFence(db: DatabaseSync, input: {
  challengeKey: string; nonce: string
}): true {
  if (!db.isTransaction || db.prepare("PRAGMA database_list").all().length !== 1
    || db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").get()
    || db.prepare("SELECT value FROM kv WHERE key=?").get(input.challengeKey)?.value !== JSON.stringify(input.nonce)) {
    rejectAuthority("policy-unqualified")
  }
  return true
}
