import type { DatabaseSync } from "node:sqlite"
import { rejectAuthority } from "../../missions/authority-protocol"
import { storageDirectory } from "../session-pruning/storage-path"

/** Metadata-only authority CAS, not session deletion or admission. Existing
 * events and a running native Session are legitimate; neither invalidates the
 * enrolled project's human Pause/Stop. Effects retain their own call-entry gate. */
export function validateRecurrenceMetadataFence(db: DatabaseSync, input: {
  sessionID: string; directory: string; projectID: string; workspaceID?: string
  challengeKey: string; nonce: string
}): true {
  if (!db.isTransaction || db.prepare("PRAGMA database_list").all().length !== 1
    || db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").get()
    || db.prepare("SELECT value FROM kv WHERE key=?").get(input.challengeKey)?.value !== JSON.stringify(input.nonce)) {
    rejectAuthority("policy-unqualified")
  }
  const session = db.prepare("SELECT directory,project_id,workspace_id,time_suspended,time_compacting,revert FROM session_v2 WHERE id=?").get(input.sessionID)
  if (!session || session.directory !== storageDirectory(input.directory) || session.project_id !== input.projectID
    || session.workspace_id !== (input.workspaceID ?? null)
    || session.time_suspended !== null || session.time_compacting !== null || session.revert !== null) {
    rejectAuthority("policy-unqualified")
  }
  return true
}
