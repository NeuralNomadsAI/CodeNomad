import type { DatabaseSync } from "node:sqlite"
import type { Plugin } from "@opencode/plugin"
import { withHistoryDatabase } from "./history-database"
import { storageDirectory } from "./storage-path"
import type { HistoryScope } from "./history-store"
import type { ImagesConversationInput, ImagesConversationResult } from "./assets-gallery-contract"

// The location's Images conversation (dev-docs/SESSION_PRUNING_RPC.md#images-conversation):
// the newest unarchived root session marked `codenomad.companion: images`.
export const CONVERSATION_SCAN = 20000
export const COMPANION_METADATA = { "codenomad.companion": "images" } as const
type Create = (input: { title?: string; agent?: string; model?: ImagesConversationInput["model"]; metadata: typeof COMPANION_METADATA }) => Promise<{ id: string }>

/** Authoritative lookup with `ownedSession`'s location predicate, over at most 20,000 root sessions. */
export function lookupImagesConversation(db: DatabaseSync, scope: HistoryScope): ImagesConversationResult {
  db.exec("BEGIN")
  try {
    const roots = db.prepare(`SELECT id,CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$."codenomad.companion"') END AS mark
      FROM session_v2 WHERE directory=? AND project_id=? AND workspace_id IS ? AND parent_id IS NULL AND time_archived IS NULL
      ORDER BY time_created DESC, id DESC LIMIT ?`).all(storageDirectory(scope.directory), scope.projectID!, scope.workspaceID ?? null, CONVERSATION_SCAN + 1)
    const found = roots.slice(0, CONVERSATION_SCAN).find(row => row.mark === "images")
    if (found) return { status: "found", sessionID: String(found.id), created: false }
    return { status: roots.length > CONVERSATION_SCAN ? "unknown" : "absent" }
  } finally { db.exec("ROLLBACK") }
}

// One process-wide lock per database, project, storage directory and workspace, shared by every copy of this module.
const locksKey = Symbol.for("codenomad.session-pruning.images-conversation.v1")
const locks: Map<string, Promise<void>> = ((globalThis as any)[locksKey] ??= new Map())
async function exclusive<T>(key: string, run: () => Promise<T>) {
  const previous = locks.get(key)
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = (previous ?? Promise.resolve()).then(() => current)
  locks.set(key, queued)
  await previous
  try { return await run() } finally {
    release()
    if (locks.get(key) === queued) locks.delete(key)
  }
}

/** The RPC handler: storage that cannot be read leaves the conversation `unknown`, and nothing is created. */
export async function imagesConversationRpc(ctx: Plugin.Context, input: ImagesConversationInput, signal: AbortSignal): Promise<ImagesConversationResult> {
  signal.throwIfAborted()
  const result = await withHistoryDatabase(ctx, undefined, signal,
    (db, scope) => imagesConversation(db, scope, input, session => ctx.session.create(session as never) as Promise<{ id: string }>, signal))
  if (result.status !== "blocked") return result
  signal.throwIfAborted()
  return { status: "unknown" }
}

/** `lookup` reads; `open` creates under the lock only when the lookup is complete and absent; `new` always creates. */
export async function imagesConversation(db: DatabaseSync, scope: HistoryScope, input: ImagesConversationInput, create: Create, signal: AbortSignal): Promise<ImagesConversationResult> {
  signal.throwIfAborted()
  if (input.mode === "lookup") return lookupImagesConversation(db, scope)
  const file = String(db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file ?? "")
  const key = JSON.stringify([file, scope.projectID, storageDirectory(scope.directory), scope.workspaceID ?? null])
  return exclusive(key, async () => {
    signal.throwIfAborted()
    if (input.mode === "open") {
      const found = lookupImagesConversation(db, scope)
      if (found.status !== "absent") return found
    }
    const session = await create({ ...(input.title ? { title: input.title } : {}), ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}), metadata: COMPANION_METADATA })
    return { status: "found", sessionID: String(session.id), created: true }
  })
}
