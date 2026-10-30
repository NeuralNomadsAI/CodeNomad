import type { DatabaseSync } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { ownedSession } from "./navigation-scope"
import type { HistoryScope } from "./history-store"
import type { AssetReadResult, AssetTarget } from "./assets-contract"
import { assetBytes, cursorSchema, hash, listed, MESSAGE_LIMIT, storedAsset } from "./assets-store"
import { GALLERY_RESPONSE_LIMIT, type GalleryEntry, type GenerationTarget, type ImageReferenceResult, type ImagesResult } from "./assets-gallery-contract"
import { after, annotate, coverage, generationState, interval, isGalleryFile, key, labelOf, promptFields, relativeInside, resolveName,
  sameFile, visible, writes, type Coverage, type Part } from "./assets-gallery-proof"

// The image gallery (dev-docs/SESSION_PRUNING_RPC.md#image-gallery): image `read` parts and
// `image_generate` calls of one session, recomputed from the transcript on every request.
const WINDOW_MESSAGES = 32, WINDOW_BYTES = 32 * 1024 * 1024, PAGE_ENTRIES = 64

function owned(db: DatabaseSync, scope: HistoryScope) {
  const boundary = ownedSession(db, scope)
  const session = db.prepare("SELECT parent_id,metadata FROM session_v2 WHERE id=?").get(scope.sessionID!)
  let metadata: any
  try { metadata = typeof session?.metadata === "string" ? JSON.parse(session.metadata) : undefined } catch { metadata = undefined }
  return { boundary, images: session?.parent_id == null && metadata?.["codenomad.companion"] === "images" }
}
/** Snapshot: the highest visible assistant or synthetic `seq`. */
const throughOf = (db: DatabaseSync, sessionID: string, boundary: string | undefined) => Number(db.prepare(`SELECT coalesce(max(seq),0) AS value
  FROM session_message WHERE session_id=? AND type IN ('assistant','synthetic')${visible(boundary)}`).get(sessionID, ...after(boundary))?.value)
const operationTime = (part: Part) => Number.isFinite(part.time?.ran) ? part.time.ran as number : Number.isFinite(part.time?.created) ? part.time.created as number : null
const generationDigest = (part: Part, job: unknown) => hash(`${String(part.id ?? "")}\u0000${typeof job === "string" ? job : ""}`)

/** One page: `windowMessages` only narrows the window for tests that compare page sizes. */
export async function listGalleryImages(db: DatabaseSync, scope: HistoryScope, cursor: string | undefined, prompts: boolean, signal: AbortSignal,
  windowMessages = WINDOW_MESSAGES): Promise<ImagesResult> {
  signal.throwIfAborted(); db.exec("BEGIN")
  try {
    const { boundary, images } = owned(db, scope), sessionID = scope.sessionID!
    const binding = hash(JSON.stringify(["images", scope, boundary]))
    const previous = cursor ? cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString())) : undefined
    if (previous && previous.binding !== binding) return { status: "blocked", reason: "conflict" }
    const through = previous?.through ?? throughOf(db, sessionID, boundary)
    const where = "session_id=? AND type='assistant'" + visible(boundary), params = [sessionID, ...after(boundary)]
    const rows = db.prepare(`SELECT id,seq,length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE ${where}
      AND seq<=? AND seq<=? ORDER BY seq DESC LIMIT ?`).all(...params, through, previous?.sequence ?? through, Math.min(windowMessages, WINDOW_MESSAGES))
    const read = db.prepare("SELECT data FROM session_message WHERE session_id=? AND id=?")
    const preloaded = new Map<string, any>(), window: Array<{ id: string; seq: number; data: any; items: Array<{ part: number; index?: number }> }> = []
    let examined = 0, next: { sequence: number; offset: number } | undefined
    for (const row of rows) {
      signal.throwIfAborted()
      const seq = Number(row.seq), bytes = Number(row.bytes)
      if (bytes > MESSAGE_LIMIT) return { status: "blocked", reason: "limit" }
      // A row the byte budget refuses is the continuation; every admitted row is emitted first.
      if (examined && examined + bytes > WINDOW_BYTES) { next = { sequence: seq, offset: 0 }; break }
      examined += bytes
      const data = JSON.parse(String(read.get(sessionID, row.id)?.data))
      const files = listed(db, data)
      if (!files) return { status: "blocked", reason: "unsupported_storage" }
      preloaded.set(String(row.id), data)
      const calls: Array<{ part: number; index?: number }> = (Array.isArray(data.content) ? data.content as Part[] : [])
        .flatMap((part, index) => part?.type === "tool" && part.name === "image_generate" ? [{ part: index }] : [])
      const items = [...calls, ...files.filter(file => isGalleryFile(data.content[file.part], file.file)).map(file => ({ part: file.part, index: file.index }))]
        .sort((a, b) => a.part - b.part || (a.index ?? -1) - (b.index ?? -1))
      window.push({ id: String(row.id), seq, data, items })
      await yieldTurn(undefined, { signal })
    }
    const cov = coverage(db, sessionID, boundary, window[0]?.seq ?? 0, through, preloaded, window.length)
    const entries: GalleryEntry[] = []
    let size = 256
    emit: for (const { id, seq, data, items } of window) {
      const offset = seq === previous?.sequence ? previous.offset : 0
      for (let n = offset; n < items.length; n++) {
        if (entries.length === PAGE_ENTRIES) { next = { sequence: seq, offset: n }; break emit }
        const entry = describe(id, seq, data.content[items[n].part], items[n])
        const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
        if (size + bytes > GALLERY_RESPONSE_LIMIT) { next = { sequence: seq, offset: n }; break emit }
        entries.push(entry); size += bytes
      }
    }
    if (!next) {
      const last = rows.at(-1)
      const older = last && db.prepare(`SELECT seq FROM session_message WHERE ${where} AND seq<? ORDER BY seq DESC LIMIT 1`).get(...params, last.seq)
      if (older) next = { sequence: Number(older.seq), offset: 0 }
    }
    return { status: "page", entries, cursor: next ? Buffer.from(JSON.stringify({ binding, through, ...next })).toString("base64url") : null }

    function describe(messageID: string, seq: number, part: Part, item: { part: number; index?: number }): GalleryEntry {
      const series = key(messageID), time = operationTime(part)
      if (item.index === undefined) {
        const state = generationState(cov, part)
        return { kind: "generation", target: { messageID, part: item.part, digest: generationDigest(part, part.state?.metadata?.jobID) }, series, time,
          key: state.job ? key(sessionID, state.job) : key(sessionID, messageID, String(item.part)), tool: state.tool, outcome: state.outcome,
          ...(prompts && images ? promptFields(part) : {}) }
      }
      const file = part.state.content[item.index], resolved = resolveName(scope.directory, file.name)
      const annotation = annotate(cov, scope.directory, sessionID, seq, part, resolved)
      const inside = relativeInside(scope.directory, resolved)
      const base = { kind: "image" as const, target: { messageID, part: item.part, index: item.index, digest: hash(file.uri) }, series, time,
        label: inside ? labelOf(resolved!) : null, mime: String(file.mime) }
      if (annotation.origin === "unverifiable") return { ...base, origin: "unverifiable" }
      const { call, ...proven } = annotation
      return { ...base, ...proven, ...(prompts && images ? promptFields(call) : {}) }
    }
  } finally { db.exec("ROLLBACK") }
}

/** The gallery image a target names: `assetRead`'s bytes behind the gallery membership check of the same bounded read. */
export async function readGalleryImage(db: DatabaseSync, scope: HistoryScope, target: AssetTarget, signal: AbortSignal): Promise<AssetReadResult> {
  signal.throwIfAborted(); db.exec("BEGIN")
  try {
    const found = storedAsset(db, scope.sessionID!, ownedSession(db, scope), target)
    if (found.status !== "file") return { status: "blocked", reason: found.status }
    if (!isGalleryFile(found.tool, found.file)) return { status: "blocked", reason: "not-gallery" }
    return assetBytes(db, found.tool, found.file)
  } finally { db.exec("ROLLBACK") }
}

/**
 * A prefill reference: the target's file path relative to the location when its
 * generation is proven and no later write of that file appears up to the snapshot.
 */
export async function galleryImageReference(db: DatabaseSync, scope: HistoryScope, target: AssetTarget | GenerationTarget, signal: AbortSignal): Promise<ImageReferenceResult> {
  signal.throwIfAborted(); db.exec("BEGIN")
  try {
    const { boundary } = owned(db, scope), sessionID = scope.sessionID!
    const through = throughOf(db, sessionID, boundary)
    let seq: number, file: string | undefined, start: number, pending: (later: Coverage) => boolean = () => false
    if ("index" in target) {
      const found = storedAsset(db, sessionID, boundary, target)
      if (found.status !== "file") return refused(found.status === "unavailable" ? "changed" : found.status === "limit" ? "unverifiable" : "missing")
      if (!isGalleryFile(found.tool, found.file)) return refused("not-gallery")
      if (!present(found.tool, found.file)) return refused("missing")
      seq = found.seq; file = resolveName(scope.directory, found.file.name)
      const cov = coverage(db, sessionID, boundary, seq, through, new Map([[target.messageID, found.data]]), 1)
      const span = interval(found.tool)
      if (annotate(cov, scope.directory, sessionID, seq, found.tool, file).origin !== "proven" || !span) return refused("unverifiable")
      start = span.start
    } else {
      const row = db.prepare(`SELECT seq,length(CAST(data AS BLOB)) AS bytes,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM session_message
        WHERE session_id=? AND type='assistant' AND id=?${visible(boundary)}`).get(MESSAGE_LIMIT, sessionID, target.messageID, ...after(boundary))
      if (!row) return refused("missing")
      if (typeof row.data !== "string") return refused("unverifiable")
      const data = JSON.parse(row.data), part = data.content?.[target.part]
      if (part?.type !== "tool" || part.name !== "image_generate" || generationDigest(part, part.state?.metadata?.jobID) !== target.digest) return refused("changed")
      seq = Number(row.seq)
      const cov = coverage(db, sessionID, boundary, seq, through, new Map([[target.messageID, data]]), 1), state = generationState(cov, part)
      if (state.outcome !== "completed" || !state.notice?.file) return refused("unverifiable")
      file = state.notice.file; start = state.notice.time
      // Another call to the same file started before our notice, still without its own notice or completion time, may write it later.
      const floor = cov.floorFor(seq), own = part, written = file
      pending = later => [...cov.calls.filter(call => call.seq >= floor && call.seq < seq), ...later.calls.filter(call => call.seq >= seq)]
        .some(call => !(call.seq === seq && call.part.id === own.id) && writes(call.part, written) && Number(call.part.time?.ran) < start
          && (!Number.isFinite(call.part.time?.completed)
            || ![...cov.notices, ...later.notices].some(notice => notice.job === call.part.state?.metadata?.jobID)))
    }
    const relative = relativeInside(scope.directory, file)
    if (!relative) return refused("outside")
    // No later write: the newest assistant rows down to the item (32 messages, 32 MiB) and the notices of that range.
    const later = coverage(db, sessionID, boundary, through, through, new Map(), 0)
    if (!(later.floor <= seq) || later.capped || later.undecoded.some(row => !(row.time < start)) || pending(later)) return refused("unverifiable")
    if (later.calls.some(call => call.seq >= seq && writes(call.part, file!) && !(Number(call.part.time?.ran) < start))
      || later.notices.some(notice => sameFile(notice.file, file!) && notice.time > start)) return refused("changed")
    return { status: "path", path: process.platform === "win32" ? relative.replaceAll("\\", "/") : relative }
  } finally { db.exec("ROLLBACK") }

  function refused(reason: Extract<ImageReferenceResult, { status: "refused" }>["reason"]): ImageReferenceResult {
    return { status: "refused", reason }
  }
  function present(tool: Part, file: Part) { return listed(db, { content: [{ ...tool, state: { ...tool.state, content: [file] } }] })?.length === 1 }
}
