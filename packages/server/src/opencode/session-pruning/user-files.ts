import type { DatabaseSync } from "node:sqlite"
import { readInlineUserFile, USER_FILE_BASE64, USER_FILE_BYTES, USER_FILE_COUNT, userFileDigest, userFileLabel } from "./user-file-reference"
import type { HistoryScope } from "./history-store"
import { ownedSession } from "./navigation-scope"

const USER_MESSAGE_INPUT = 44 * 1024 * 1024
export const USER_WINDOW_INPUT = 64 * 1024 * 1024
const MEDIA_REF = /^media:([0-9a-f]{64})$/

function userFiles(db: DatabaseSync, sessionID: string, messageID: string, index = -1) {
  // SQLite walks the array once. Each JS row contains only its own potentially large field.
  return db.prepare(`SELECT f.type AS kind, substr(json_extract(f.value,'$.name'),1,1024) AS name,
    substr(json_extract(f.value,'$.mime'),1,256) AS mime, substr(json_extract(f.value,'$.uri'),1,71) AS uri,
    substr(json_extract(f.value,'$.source.type'),1,16) AS source,
    length(json_extract(f.value,'$.data')) AS length,
    CASE WHEN length(json_extract(f.value,'$.data'))<=? THEN json_extract(f.value,'$.data') END AS inline
    FROM session_message m, json_each(
      CASE WHEN octet_length(m.data)<=? AND json_type(m.data,'$.files')='array' THEN m.data END,'$.files'
    ) f WHERE m.session_id=? AND m.id=? AND m.type='user' AND (?<0 OR f.key=?)`)
    .iterate(USER_FILE_BASE64, USER_MESSAGE_INPUT, sessionID, messageID, index, index)
}

function ownedBlob(db: DatabaseSync, sessionID: string, messageID: string, hash: string, load: boolean) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='blob_ref' AND type='table'").get()
    || !db.prepare("SELECT 1 FROM sqlite_schema WHERE name='blob' AND type='table'").get()) return
  return db.prepare(`SELECT length(b.data) AS size,
    CASE WHEN ? AND length(b.data)<=? THEN b.data END AS data
    FROM blob b JOIN blob_ref r ON r.hash=b.hash
    WHERE r.session_id=? AND r.message_id=? AND r.hash=? AND typeof(b.data)='blob'`)
    .get(Number(load), USER_FILE_BYTES, sessionID, messageID, hash)
}

export function projectStoredUserFiles(db: DatabaseSync, sessionID: string, messageID: string, budget: number, signal: AbortSignal) {
  const row = db.prepare(`SELECT content, typeof(content) AS kind, files FROM (
    SELECT CASE WHEN octet_length(json_remove(data,'$.files'))<=? THEN json_remove(data,'$.files') END AS content,
      CASE WHEN json_type(data,'$.files') IS NULL THEN 0 WHEN json_type(data,'$.files')='array' THEN json_array_length(data,'$.files') ELSE -1 END AS files
    FROM session_message WHERE session_id=? AND id=? AND type='user' AND octet_length(data)<=?)`)
    .get(budget, sessionID, messageID, USER_MESSAGE_INPUT)
  if (!row || row.kind !== "text" || typeof row.content !== "string"
    || typeof row.files !== "number" || row.files < 0 || row.files > USER_FILE_COUNT) return
  const data = JSON.parse(row.content)
  if (row.files === 0) return data
  const files = []
  for (const file of userFiles(db, sessionID, messageID)) {
    signal.throwIfAborted()
    if (file.kind !== "object") return
    const hash = typeof file.uri === "string" ? MEDIA_REF.exec(file.uri)?.[1] : undefined
    const blob = hash && ownedBlob(db, sessionID, messageID, hash, false)
    const inline = hash || file.source === "uri" ? undefined : readInlineUserFile(file.inline)
    files.push(userFileLabel(file, blob && Number(blob.size) <= USER_FILE_BYTES ? hash
      : Buffer.isBuffer(inline) ? userFileDigest(inline) : undefined))
  }
  if (files.length === row.files) return { ...data, files }
}

export function readStoredUserFile(db: DatabaseSync, scope: HistoryScope, target: {
  messageID: string; fileIndex: number; sha256: string; confirm?: true
}, signal: AbortSignal) {
  const sessionID = scope.sessionID!, { messageID, fileIndex, sha256 } = target
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { status: "missing" } as const
  signal.throwIfAborted()
  db.exec("BEGIN")
  try {
    const undo = ownedSession(db, scope)
    if (undo && messageID >= undo) return { status: "missing" } as const
    let file
    for (const value of userFiles(db, sessionID, messageID, fileIndex)) file = value
    if (file?.kind !== "object") return { status: "missing" } as const
    const hash = typeof file.uri === "string" ? MEDIA_REF.exec(file.uri)?.[1] : undefined
    let bytes: Uint8Array | undefined
    if (hash) {
      if (sha256 !== hash) return { status: "missing" } as const
      const blob = ownedBlob(db, sessionID, messageID, hash, true)
      if (blob && Number(blob.size) > USER_FILE_BYTES) return { status: "too_large" } as const
      if (blob?.data instanceof Uint8Array) bytes = blob.data
    } else if (file.source !== "uri") {
      const inline = readInlineUserFile(file.inline)
      if (inline === "too_large" || Number(file.length) > USER_FILE_BASE64) return { status: "too_large" } as const
      bytes = inline
    }
    signal.throwIfAborted()
    if (!bytes || userFileDigest(bytes) !== sha256) return { status: "missing" } as const
    if (target.confirm) return { status: "current" } as const
    return { status: "file", data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") } as const
  } finally { db.exec("ROLLBACK") }
}
