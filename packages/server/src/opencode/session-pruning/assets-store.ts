import { createHash } from "node:crypto"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { z } from "zod"
import { ownedSession } from "./navigation-scope"
import type { HistoryScope } from "./history-store"
import { isEmbeddedAsset, type AssetTarget, type AssetsResult, type AssetReadResult } from "./assets-contract"

const MESSAGE_LIMIT = 16 * 1024 * 1024
const cursorSchema = z.object({ binding: z.string().length(64), through: z.number().int().min(0),
  sequence: z.number().int().min(0), offset: z.number().int().min(0).max(100000) }).strict()
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
function files(data: Record<string, any>) {
  const entries: Array<{ part: number; index: number; tool: string; file: Record<string, any> }> = []
  const parts = Array.isArray(data.content) ? data.content : []
  if (parts.length > 100000) throw new Error("Asset limit")
  for (let part = 0; part < Math.min(parts.length, 100001); part++) {
    const tool = parts[part]
    if (tool?.type !== "tool" || !Array.isArray(tool.state?.content)) continue
    if (tool.state.content.length > 100000) throw new Error("Asset limit")
    for (let index = 0; index < Math.min(tool.state.content.length, 100001); index++) {
      const file = tool.state.content[index]
      if (file?.type === "file" && typeof file.uri === "string" && typeof file.mime === "string"
        && /^[\w.+-]+\/[\w.+-]+$/.test(file.mime) && file.mime.length <= 128) {
        entries.push({ part, index, tool: String(tool.name ?? tool.tool ?? "").slice(0, 256), file })
        if (entries.length === 100000) throw new Error("Asset limit")
      }
    }
  }
  return entries
}
export async function listSessionAssets(db: DatabaseSync, scope: HistoryScope, cursor: string | undefined, signal: AbortSignal): Promise<AssetsResult> {
  signal.throwIfAborted(); db.exec("BEGIN")
  try {
    const boundary = ownedSession(db, scope)
    const binding = hash(JSON.stringify([scope, boundary]))
    const previous = cursor ? cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString())) : undefined
    if (previous && previous.binding !== binding) return { status: "blocked", reason: "conflict" }
    const where = "session_id=? AND type='assistant'" + (boundary ? " AND id < ?" : "")
    const params: SQLInputValue[] = [scope.sessionID!, ...(boundary ? [boundary] : [])]
    const maximum = Number(db.prepare(`SELECT coalesce(max(seq),0) AS value FROM session_message WHERE ${where}`).get(...params)?.value)
    const through = previous?.through ?? maximum
    const rows = db.prepare(`SELECT id,seq,length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE ${where}
      AND seq<=? AND seq<=? ORDER BY seq DESC LIMIT 32`).all(...params, through, previous?.sequence ?? through)
    const read = db.prepare("SELECT data FROM session_message WHERE session_id=? AND id=?")
    const entries: Extract<AssetsResult, { status: "page" }>["entries"] = []
    let examined = 0
    for (const row of rows) {
      signal.throwIfAborted()
      const sequence = Number(row.seq), bytes = Number(row.bytes)
      if (bytes > MESSAGE_LIMIT) return { status: "blocked", reason: "limit" }
      // Bound aggregate parsing too, without skipping an unexamined message.
      if (examined && examined + bytes > 32 * 1024 * 1024) return page(sequence, 0)
      examined += bytes
      const data = read.get(scope.sessionID!, row.id)?.data
      const assets = typeof data === "string" ? files(JSON.parse(data)) : []
      const offset = sequence === previous?.sequence ? previous.offset : 0
      for (let index = offset; index < assets.length; index++) {
        const asset = assets[index]
        if (entries.length === 64) return page(sequence, index)
        entries.push({ target: { messageID: String(row.id), part: asset.part, index: asset.index, digest: hash(asset.file.uri) },
          name: typeof asset.file.name === "string" ? asset.file.name.slice(0, 256) : `${asset.tool} · ${asset.index + 1}`,
          tool: asset.tool, mime: asset.file.mime, available: isEmbeddedAsset({ mime: asset.file.mime, uri: asset.file.uri }) })
      }
      await yieldTurn(undefined, { signal })
    }
    const last = rows.at(-1)
    const older = last && db.prepare(`SELECT seq FROM session_message WHERE ${where} AND seq<? ORDER BY seq DESC LIMIT 1`).get(...params, last.seq)
    return older ? page(Number(older.seq), 0) : { status: "page", entries, cursor: null }
    function page(sequence: number, offset: number): AssetsResult {
      return { status: "page", entries, cursor: Buffer.from(JSON.stringify({ binding, through, sequence, offset })).toString("base64url") }
    }
  } finally { db.exec("ROLLBACK") }
}
export async function readSessionAsset(db: DatabaseSync, scope: HistoryScope, target: AssetTarget, signal: AbortSignal): Promise<AssetReadResult> {
  signal.throwIfAborted(); db.exec("BEGIN")
  try {
    const boundary = ownedSession(db, scope)
    const row = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM session_message
      WHERE session_id=? AND type='assistant' AND id=? ${boundary ? "AND id < ?" : ""}`).get(MESSAGE_LIMIT, scope.sessionID!, target.messageID, ...(boundary ? [boundary] : []))
    if (typeof row?.data !== "string") return { status: "blocked", reason: "missing" }
    const data = JSON.parse(row.data), tool = data.content?.[target.part]
    const file = tool?.type === "tool" ? tool.state?.content?.[target.index] : undefined
    if (file?.type !== "file" || typeof file.uri !== "string" || typeof file.mime !== "string"
      || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime) || file.mime.length > 128 || hash(file.uri) !== target.digest || !isEmbeddedAsset(file)) {
      return { status: "blocked", reason: "unavailable" }
    }
    return { status: "asset", uri: file.uri, mime: file.mime }
  } finally { db.exec("ROLLBACK") }
}
