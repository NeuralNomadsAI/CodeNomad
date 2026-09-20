import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { historyQuerySchema, pruneBatchSchema, type HistoryNativeResult } from "./history-contract"
import { queryHistoryPage, type HistoryScope } from "./history-store"
import { pruningDatabasePath } from "./database-path"
import { storageKey } from "./claim-fence"
import { readLocationRef, sameLocation } from "./location"
import { pruneBoundMessage } from "./service"
import type { PruneResult } from "./contract"

export async function queryBoundHistory(ctx: Plugin.Context, value: unknown, signal: AbortSignal): Promise<HistoryNativeResult> {
  const input = historyQuerySchema.parse(value)
  const scope: HistoryScope = readLocationRef(ctx.location)
  scope.projectID = ctx.location.project.id
  if (input.sessionID) {
    const session = await ctx.session.get({ sessionID: input.sessionID })
    if (!sameLocation(readLocationRef(session.location), scope)) return { status: "blocked", reason: "not_deletable" }
    scope.sessionID = session.id
    scope.projectID = session.projectID
  }
  const configured = pruningDatabasePath(ctx.options.databasePath, ctx.app.channel)
  if (typeof configured !== "string" || !path.isAbsolute(configured) || (process.platform === "win32" && configured.replaceAll("/", "\\").startsWith("\\\\"))) {
    return { status: "blocked", reason: "unsupported_storage" }
  }
  const key = `history/binding/${randomUUID()}`
  const nonce = randomUUID()
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
      return await queryHistoryPage(db, scope, input, signal)
    } finally { db.close() }
  } catch (error) {
    signal.throwIfAborted()
    return { status: "blocked", reason: "unsupported_storage" }
  } finally { await ctx.storage.remove(key).catch(() => {}) }
}

export async function pruneBoundBatch(ctx: Plugin.Context, value: unknown, signal: AbortSignal,
  notify: (sessionID: string, result: Extract<PruneResult, { status: "pruned" }>) => Promise<void>) {
  const input = pruneBatchSchema.parse(value)
  const results: Array<{ messageID: string; result: PruneResult }> = []
  for (const candidate of input.candidates) {
    signal.throwIfAborted()
    let result: PruneResult
    try {
      result = await pruneBoundMessage(ctx, { sessionID: input.sessionID, messageID: candidate.messageID,
        revision: candidate.revision }, signal, true)
    } catch { result = { status: "blocked", reason: "unavailable" } }
    if (result.status === "pruned") await notify(input.sessionID, result).catch(() => {})
    results.push({ messageID: candidate.messageID, result })
  }
  return { results }
}
