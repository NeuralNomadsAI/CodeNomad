import type { DatabaseSync } from "node:sqlite"
import { storageDirectory } from "./storage-path"

// This is an internal storage contract, NOT a public OpenCode lock API.
// Extending this set requires rerunning the native concurrency/payload tests.
export const AUDITED_RUNTIME = "0.0.0-beta-19419"
export const PRUNING_PLUGIN_ID = "codenomad-session-pruning"
export const storageKey = (key: string) => `plugin:${Array.from(PRUNING_PLUGIN_ID)
  .map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`

export interface StorageIdentity {
  version: string
  // A fresh ctx.storage challenge proves this connection reaches the daemon's
  // current DB, not a same-session snapshot or an accidentally configured file.
  key: string
  nonce: string
  directory: string
  projectID: string
  workspaceID?: string
}

export function validateClaimFence(db: DatabaseSync, sessionID: string, identity: StorageIdentity) {
  if (!db.isTransaction) throw new Error("Claim fence requires an acquired write transaction")
  if (identity.version !== AUDITED_RUNTIME) return "unsupported_storage" as const
  if (db.prepare("PRAGMA database_list").all().length !== 1) return "unsupported_storage" as const
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").get()) return "unsupported_storage" as const
  const marker = db.prepare("SELECT value FROM kv WHERE key=?").get(identity.key)
  if (marker?.value !== JSON.stringify(identity.nonce)) return "unsupported_storage" as const
  const session = db.prepare("SELECT directory,project_id,workspace_id,time_suspended,time_compacting,revert FROM session_v2 WHERE id=?").get(sessionID)
  if (!session || session.directory !== storageDirectory(identity.directory)
    || session.project_id !== identity.projectID || session.workspace_id !== (identity.workspaceID ?? null)) return "not_deletable" as const
  // Native execution must COMMIT its claim before it can enter the runner.
  // BEGIN IMMEDIATE excludes that commit until our synchronous transaction ends.
  // If it committed first, we observe its non-null claim and refuse the write.
  // Never set/release the claim ourselves: it also drives crash recovery.
  if (session.time_suspended !== null || session.time_compacting !== null || session.revert !== null) return "maintenance_required" as const
  const sequence = db.prepare("SELECT owner_id FROM event_sequence WHERE aggregate_id=?").get(sessionID)
  if (!sequence || sequence.owner_id !== null
    || db.prepare("SELECT 1 FROM event WHERE aggregate_id=? LIMIT 1").get(sessionID)) return "unsupported_storage" as const
  return undefined
}
