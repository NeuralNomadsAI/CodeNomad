import { createHash } from "node:crypto"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { z } from "zod"
import { ownedSession } from "./navigation-scope"
import type { HistoryScope } from "./history-store"
import { ASSET_URI_LIMIT, isEmbeddedAsset, type AssetTarget, type AssetsResult, type AssetReadResult } from "./assets-contract"
import { mediaBlobBase64, mediaBlobSizes, mediaDataUri, mediaDataUriLength, toolMediaHash } from "./media-blob"

export const MESSAGE_LIMIT = 16 * 1024 * 1024
export const cursorSchema = z.object({ binding: z.string().length(64), through: z.number().int().min(0),
  sequence: z.number().int().min(0), offset: z.number().int().min(0).max(100000) }).strict()
export const hash = (value: string) => createHash("sha256").update(value).digest("hex")
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
// Media refs list as the files native reads inline, without loading their bytes;
// a ref whose blob is gone reads natively as text, so it lists nothing.
export function listed(db: DatabaseSync, data: Record<string, any>) {
  const assets = files(data), refs = assets.map(asset => toolMediaHash(data.content[asset.part], asset.file))
  const sizes = refs.some(Boolean) ? mediaBlobSizes(db, refs.filter((ref): ref is string => !!ref)) : new Map<string, number>()
  if (!sizes) return undefined
  return assets.flatMap((asset, n) => {
    const ref = refs[n], size = ref ? sizes.get(ref) : undefined
    if (!ref) return [{ ...asset, available: isEmbeddedAsset({ mime: asset.file.mime, uri: asset.file.uri }) }]
    return size === undefined ? [] : [{ ...asset, available: size > 0 && mediaDataUriLength(asset.file.mime, size) <= ASSET_URI_LIMIT }]
  })
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
      const assets = typeof data === "string" ? listed(db, JSON.parse(data)) : []
      if (!assets) return { status: "blocked", reason: "unsupported_storage" }
      const offset = sequence === previous?.sequence ? previous.offset : 0
      for (let index = offset; index < assets.length; index++) {
        const asset = assets[index]
        if (entries.length === 64) return page(sequence, index)
        entries.push({ target: { messageID: String(row.id), part: asset.part, index: asset.index, digest: hash(asset.file.uri) },
          name: typeof asset.file.name === "string" ? asset.file.name.slice(0, 256) : `${asset.tool} · ${asset.index + 1}`,
          tool: asset.tool, mime: asset.file.mime, available: asset.available })
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
    const found = storedAsset(db, scope.sessionID!, ownedSession(db, scope), target)
    return found.status === "file" ? assetBytes(db, found.tool, found.file)
      : { status: "blocked", reason: found.status === "limit" ? "missing" : found.status }
  } finally { db.exec("ROLLBACK") }
}
/** The digest-bound tool file a target names, inside the caller's read transaction; the size is checked before its JSON loads. */
export function storedAsset(db: DatabaseSync, sessionID: string, boundary: string | undefined, target: AssetTarget) {
  const row = db.prepare(`SELECT seq,length(CAST(data AS BLOB)) AS bytes,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM session_message
    WHERE session_id=? AND type='assistant' AND id=? ${boundary ? "AND id < ?" : ""}`).get(MESSAGE_LIMIT, sessionID, target.messageID, ...(boundary ? [boundary] : []))
  if (!row) return { status: "missing" } as const
  if (typeof row.data !== "string") return { status: Number(row.bytes) > MESSAGE_LIMIT ? "limit" : "missing" } as const
  const data = JSON.parse(row.data), tool = data.content?.[target.part]
  const file = tool?.type === "tool" ? tool.state?.content?.[target.index] : undefined
  if (file?.type !== "file" || typeof file.uri !== "string" || typeof file.mime !== "string"
    || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime) || file.mime.length > 128 || hash(file.uri) !== target.digest) {
    return { status: "unavailable" } as const
  }
  return { status: "file", seq: Number(row.seq), bytes: Number(row.bytes), data, tool, file } as const
}
/** A tool file as the data URI native reads return; a media ref reads inline from its blob. */
export function assetBytes(db: DatabaseSync, tool: any, file: { mime: string; uri: string }): AssetReadResult {
  const ref = toolMediaHash(tool, file)
  const inline = ref && mediaBlobBase64(db, ref, Math.floor((ASSET_URI_LIMIT - mediaDataUriLength(file.mime, 0)) / 4) * 3)
  const uri = ref ? inline && mediaDataUri(file.mime, inline) : file.uri
  if (!uri || !isEmbeddedAsset({ mime: file.mime, uri })) return { status: "blocked", reason: "unavailable" }
  return { status: "asset", uri, mime: file.mime }
}
