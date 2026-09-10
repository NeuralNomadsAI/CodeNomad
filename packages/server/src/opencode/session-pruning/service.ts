import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { AUDITED_RUNTIME, storageKey, validateClaimFence } from "./claim-fence"
import { pruneTransaction } from "./transaction"
import { pruneRequestSchema, type PruneResult } from "./contract"

// Only the explicitly enabled, version-gated plugin calls this service.
// No database access is exposed through CodeNomad's HTTP broker.
export async function pruneBoundMessage(
  ctx: Plugin.Context, input: unknown, signal: AbortSignal,
): Promise<PruneResult> {
  const request = pruneRequestSchema.parse(input)
  if (ctx.app.version !== AUDITED_RUNTIME) return { status: "blocked", reason: "unsupported_storage" }
  const configured = ctx.options.databasePath
  if (typeof configured !== "string" || !path.isAbsolute(configured)
    || (process.platform === "win32" && configured.replaceAll("/", "\\").startsWith("\\\\"))) {
    return { status: "blocked", reason: "unsupported_storage" }
  }
  const session = await ctx.session.get({ sessionID: request.sessionID })
  if (session.location.directory !== ctx.location.directory || session.projectID !== ctx.location.project.id
    || session.location.workspaceID !== ctx.location.workspaceID) return { status: "blocked", reason: "not_deletable" }
  const filename = await realpath(configured)
  const { DatabaseSync } = await import("node:sqlite")
  const key = `pruning/binding/${randomUUID()}`
  const nonce = randomUUID()
  signal.throwIfAborted()
  await ctx.storage.set(key, nonce)
  try {
    signal.throwIfAborted()
    const db = new DatabaseSync(filename)
    try {
      // A blocking busy timeout could deadlock Core's async transaction on the
      // same event loop. Return busy immediately; don't interrupt native work.
      db.exec("PRAGMA busy_timeout=0")
      try {
        return pruneTransaction(db, request, () => validateClaimFence(db, request.sessionID, {
          version: ctx.app.version, key: storageKey(key), nonce,
          directory: session.location.directory, projectID: session.projectID,
          workspaceID: session.location.workspaceID,
        }), storageKey("pruning/receipt/"))
      } catch (error) {
        const code = (error as { errcode?: number; code?: string }).errcode
        return { status: "blocked", reason: code === 5 || code === 6 || (error as { code?: string }).code === "SQLITE_BUSY"
          ? "maintenance_required" : "unsupported_storage" }
      }
    } finally { db.close() }
  } finally {
    // Cleanup failure must not turn a committed prune into a failed response.
    await ctx.storage.remove(key).catch(() => {})
  }
}
