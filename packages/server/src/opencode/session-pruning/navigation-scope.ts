import type { DatabaseSync } from "node:sqlite"
import { storageDirectory } from "./storage-path"
import type { HistoryScope } from "./history-store"

export function ownedSession(db: DatabaseSync, scope: HistoryScope) {
  const session = db.prepare("SELECT revert FROM session_v2 WHERE id=? AND directory=? AND project_id=? AND workspace_id IS ?")
    .get(scope.sessionID!, storageDirectory(scope.directory), scope.projectID!, scope.workspaceID ?? null)
  if (!session) throw new Error("Session location changed")
  const revert = typeof session.revert === "string" ? JSON.parse(session.revert) : undefined
  return typeof revert?.messageID === "string" ? revert.messageID as string : undefined
}
