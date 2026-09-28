import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { Plugin } from "@opencode/plugin"
import type { HistoryScope } from "./history-store"
import { pruningDatabasePath } from "./database-path"
import { storageKey } from "./claim-fence"
import { readLocationRef, sameLocation } from "./location"

type Blocked = { status: "blocked"; reason: "not_deletable" | "unsupported_storage" }
export async function withHistoryDatabase<T>(ctx: Plugin.Context, sessionID: string | undefined, signal: AbortSignal,
  read: (db: DatabaseSync, scope: HistoryScope) => Promise<T>): Promise<T | Blocked> {
  const scope: HistoryScope = { ...readLocationRef(ctx.location), projectID: ctx.location.project.id }
  if (sessionID) {
    const session = await ctx.session.get({ sessionID })
    if (!sameLocation(readLocationRef(session.location), scope)) return { status: "blocked", reason: "not_deletable" }
    scope.sessionID = session.id
    scope.projectID = session.projectID
  }
  const configured = pruningDatabasePath(ctx.options.databasePath, ctx.app.channel)
  if (typeof configured !== "string" || !path.isAbsolute(configured) || (process.platform === "win32" && configured.replaceAll("/", "\\").startsWith("\\\\"))) {
    return { status: "blocked", reason: "unsupported_storage" }
  }
  const key = `history/binding/${randomUUID()}`, nonce = randomUUID()
  signal.throwIfAborted()
  await ctx.storage.set(key, nonce)
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(await realpath(configured), { readOnly: true, timeout: 0 })
    try {
      db.exec("PRAGMA query_only=ON")
      if (db.prepare("SELECT value FROM kv WHERE key=?").get(storageKey(key))?.value !== JSON.stringify(nonce)) {
        return { status: "blocked", reason: "unsupported_storage" }
      }
      return await read(db, scope)
    } finally { db.close() }
  } catch {
    signal.throwIfAborted()
    return { status: "blocked", reason: "unsupported_storage" }
  } finally { await ctx.storage.remove(key).catch(() => {}) }
}
