import type { DatabaseSync } from "node:sqlite"

// OpenCode's optional media storage (`experimental.media_blob`) stores inline
// user files and tool `data:` files as `media:<sha256>` refs into a `blob`
// table, and records which rows keep each blob alive in `blob_ref`. Native
// message reads restore the inline forms (core `session/blob.ts`). These
// helpers mirror that projection for CodeNomad's direct readers, qualified by
// the stored rows themselves: a row naming no ref is returned untouched, so
// databases without the tables are unaffected.

const REF = /^media:([0-9a-f]{64})$/
const BATCH = 500

const refHash = (uri: unknown) => typeof uri === "string" ? REF.exec(uri)?.[1] : undefined
const isFileRef = (file: any) => !!file && typeof file === "object" && typeof file.mime === "string" && refHash(file.uri) !== undefined
const isToolFileRef = (item: any) => item?.type === "file" && typeof item.mime === "string"
  && (item.name === undefined || typeof item.name === "string") && refHash(item.uri) !== undefined
const settledTool = (part: any) => part?.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")
  && Array.isArray(part.state.content)
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4

/** The blob native reads inline for a tool part's content item, when it is a media ref. */
export const toolMediaHash = (part: any, item: any) => settledTool(part) && isToolFileRef(item) ? refHash(item.uri) : undefined

/** The hydrated URI native reads give a tool file whose blob holds `bytes`. */
export const mediaDataUri = (mime: string, base64: string) => `data:${mime};base64,${base64}`
export const mediaDataUriLength = (mime: string, bytes: number) => `data:${mime};base64,`.length + base64Length(bytes)

const unavailable = (mime: string, name?: unknown) =>
  `[media unavailable: ${typeof name === "string" ? `${name} (${mime})` : mime}]`

/** The refs native hydration resolves in a stored message: user files, else settled tool file content. */
export function mediaHashes(data: any): Set<string> {
  const hashes = new Set<string>()
  if (!data || typeof data !== "object") return hashes
  if (Array.isArray(data.files)) for (const file of data.files) if (isFileRef(file)) hashes.add(refHash(file.uri)!)
  if (Array.isArray(data.content)) for (const part of data.content) {
    if (settledTool(part)) for (const item of part.state.content) if (isToolFileRef(item)) hashes.add(refHash(item.uri)!)
  }
  return hashes
}

const tables = new WeakMap<DatabaseSync, { blob: boolean; ref: boolean }>()
function storage(db: DatabaseSync) {
  let known = tables.get(db)
  if (!known) {
    const columns = (table: string) => new Set(db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map(row => String(row.name)))
    const blob = columns("blob"), ref = columns("blob_ref")
    known = { blob: ["hash", "data"].every(name => blob.has(name)),
      ref: ["session_id", "message_id", "hash"].every(name => ref.has(name)) }
    tables.set(db, known)
  }
  return known
}

function select<T>(db: DatabaseSync, column: string, hashes: Iterable<string>, read: (row: Record<string, unknown>) => T) {
  const all = [...hashes], found = new Map<string, T>()
  for (let offset = 0; offset < all.length; offset += BATCH) {
    const batch = all.slice(offset, offset + BATCH)
    const rows = db.prepare(`SELECT hash, ${column} AS value FROM blob WHERE hash IN (${batch.map(() => "?").join(",")})`).all(...batch)
    for (const row of rows) found.set(String(row.hash), read(row))
  }
  return found
}

/** Stored byte length of each named blob that exists, or undefined when refs cannot be resolved. */
export function mediaBlobSizes(db: DatabaseSync, hashes: Iterable<string>): Map<string, number> | undefined {
  if (!storage(db).blob) return undefined
  return select(db, "length(data)", hashes, row => Number(row.value))
}

/** One blob's bytes as base64 when it exists and is at most `limit` bytes. */
export function mediaBlobBase64(db: DatabaseSync, hash: string, limit: number): string | undefined {
  if (!storage(db).blob) return undefined
  const row = db.prepare("SELECT CASE WHEN length(data)<=? THEN data END AS data FROM blob WHERE hash=?").get(limit, hash)
  return row?.data instanceof Uint8Array ? Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength).toString("base64") : undefined
}

export type MediaProjection = { status: "ok"; data: any; bytes: number } | { status: "limit" } | { status: "unsupported" }

// Native replacements: a user file's `uri` becomes base64 `data`, a tool file's
// `uri` a data URI; a missing blob gives the unavailable placeholder instead.
function inlineFile(file: any, base64?: string) {
  const { uri: _, ...rest } = file
  return base64 === undefined
    ? { ...rest, data: Buffer.from(unavailable(file.mime, file.name)).toString("base64"), mime: "text/plain" }
    : { ...rest, data: base64 }
}
const inlineToolItem = (item: any, base64?: string) => base64 === undefined
  ? { type: "text", text: unavailable(item.mime, item.name) } : { ...item, uri: mediaDataUri(item.mime, base64) }
const serialized = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/**
 * The stored message as native reads return it: each ref inlined from its blob,
 * or the native unavailable placeholder when the blob is gone. `bytes` is the
 * projected JSON size of every message, with or without refs: the larger of
 * `storedBytes` and the reserialized message, plus each replacement's net
 * serialized change, computed from blob lengths and checked against `limit` (as is
 * `storedBytes` itself) before any blob bytes are loaded.
 */
export function projectStoredMedia(db: DatabaseSync, data: any, storedBytes: number, limit: number): MediaProjection {
  if (storedBytes > limit) return { status: "limit" }
  // Every returned message is reserialized: stored text may be shorter (e.g. `1e20`).
  let bytes = Math.max(storedBytes, serialized(data))
  const hashes = mediaHashes(data)
  if (!hashes.size) return bytes <= limit ? { status: "ok", data, bytes } : { status: "limit" }
  const sizes = mediaBlobSizes(db, hashes)
  if (!sizes) return { status: "unsupported" }
  const files = Array.isArray(data.files) && data.files.some(isFileRef)
  // An empty payload serializes the replacement without its base64, whose length the blob size gives.
  const change = (original: unknown, replace: (base64?: string) => unknown, hash: string) => {
    const size = sizes.get(hash)
    bytes += (size === undefined ? serialized(replace()) : serialized(replace("")) + base64Length(size)) - serialized(original)
  }
  if (files) {
    for (const file of data.files) if (isFileRef(file)) change(file, base64 => inlineFile(file, base64), refHash(file.uri)!)
  } else for (const part of data.content) {
    if (settledTool(part)) for (const item of part.state.content) {
      if (isToolFileRef(item)) change(item, base64 => inlineToolItem(item, base64), refHash(item.uri)!)
    }
  }
  if (bytes > limit) return { status: "limit" }
  const blobs = select(db, "data", [...hashes].filter(hash => sizes.has(hash)), row => {
    const value = row.value as Uint8Array
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")
  })
  if (files) {
    return { status: "ok", bytes, data: { ...data, files: data.files.map((file: any) =>
      isFileRef(file) ? inlineFile(file, blobs.get(refHash(file.uri)!)) : file) } }
  }
  return { status: "ok", bytes, data: { ...data, content: data.content.map((part: any) => {
    if (!settledTool(part) || !part.state.content.some(isToolFileRef)) return part
    return { ...part, state: { ...part.state, content: part.state.content.map((item: any) =>
      isToolFileRef(item) ? inlineToolItem(item, blobs.get(refHash(item.uri)!)) : item) } }
  }) } }
}

/** Whether refs this rewrite drops can be released like native content updates release them. */
export function canReleaseMedia(db: DatabaseSync, before: any) {
  return !mediaHashes(before).size || (storage(db).blob && storage(db).ref)
}

/**
 * Inside the caller's write transaction, after a message's stored content is
 * rewritten: releases the refs to the blobs it no longer names, then deletes
 * those no ref keeps alive, as native `syncRefs` does. Only hashes named
 * before the rewrite and absent from its stored text are released.
 */
export function releaseDroppedMedia(db: DatabaseSync, sessionID: string, messageID: string, before: any, after: any) {
  const named = JSON.stringify(after)
  const dropped = [...mediaHashes(before)].filter(hash => !named.includes(`media:${hash}`))
  if (!dropped.length) return
  const release = db.prepare("DELETE FROM blob_ref WHERE session_id=? AND message_id=? AND hash=?")
  const collect = db.prepare("DELETE FROM blob WHERE hash=? AND NOT EXISTS (SELECT 1 FROM blob_ref WHERE hash=?)")
  for (const hash of dropped) {
    release.run(sessionID, messageID, hash)
    collect.run(hash, hash)
  }
}
