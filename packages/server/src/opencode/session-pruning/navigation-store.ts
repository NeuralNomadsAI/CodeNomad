import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { ownedSession } from "./navigation-scope"
import { projectStoredMedia } from "./media-blob"
import { messageStorage } from "./message-storage"
import type { HistoryScope } from "./history-store"
import { navigationWindowResultSchema, type NavigationTarget, type NavigationWindowResult } from "./navigation-contract"
import { projectStoredUserFiles, USER_WINDOW_INPUT } from "./user-files"
import { USER_FILES_REFERENCE } from "./user-file-contract"
export { readSessionOutline } from "./outline-index"

const PAGE_SIZE = 200
const MESSAGE_BYTES = 16 * 1024 * 1024
const WINDOW_BYTES = 24 * 1024 * 1024
const YIELD_EVERY = 16

export async function readNavigationWindow(db: DatabaseSync, scope: HistoryScope, target: NavigationTarget, signal: AbortSignal, referenceFiles = false): Promise<NavigationWindowResult> {
  signal.throwIfAborted()
  db.exec("BEGIN")
  try {
    const boundary = ownedSession(db, scope)
    const where = "session_id=?" + (boundary ? " AND id < ?" : "")
    const params: SQLInputValue[] = [scope.sessionID!, ...(boundary ? [boundary] : [])]
    let sequence: number | undefined
    if ("messageID" in target) {
      const anchor = db.prepare(`SELECT seq FROM session_message WHERE ${where} AND id=?`).get(...params, target.messageID)
      if (!anchor) return { status: "blocked", reason: "anchor_missing" }
      sequence = Number(anchor.seq)
    }
    const storage = messageStorage(db)
    const select = (clause: string, args: SQLInputValue[], ascending: boolean, count: number) => db.prepare(
      `SELECT id,type,seq,${storage.bytes()} AS bytes FROM ${storage.table} WHERE ${where} ${clause} ORDER BY seq ${ascending ? "ASC" : "DESC"} LIMIT ?`,
    ).all(...params, ...args, count)
    let rows = target.kind === "around"
      ? [...select("AND seq < ?", [sequence!], false, 80).reverse(), ...select("AND seq >= ?", [sequence!], true, 120)]
      : target.kind === "latest" ? select("", [], false, PAGE_SIZE).reverse()
        : target.kind === "oldest" ? select("", [], true, PAGE_SIZE)
          : target.kind === "before"
            ? [...select("AND seq < ?", [sequence!], false, 184).reverse(), ...select("AND seq >= ?", [sequence!], true, 16)]
            : [...select("AND seq <= ?", [sequence!], false, 16).reverse(), ...select("AND seq > ?", [sequence!], true, 184)]
    if (referenceFiles) {
      let budget = USER_WINDOW_INPUT
      const take = (candidates: typeof rows) => {
        const kept = []
        for (const row of candidates) {
          const bytes = Number(row.bytes)
          if (bytes > budget) break
          budget -= bytes
          kept.push(row)
        }
        return kept
      }
      const cut = sequence === undefined ? -1 : rows.findIndex(row => Number(row.seq) === sequence)
      let kept
      if (target.kind === "latest") kept = take(rows.slice().reverse()).reverse()
      else if (target.kind === "oldest") kept = take(rows)
      else if (cut < 0) return { status: "blocked", reason: "conflict" }
      else if (target.kind === "before") {
        const earlier = take(rows.slice(0, cut).reverse())
        kept = [...earlier.reverse(), ...take(rows.slice(cut))]
        if (cut > 0 && !earlier.length) return { status: "blocked", reason: "unsupported_storage" }
      } else if (target.kind === "after") {
        const later = take(rows.slice(cut + 1))
        kept = [...take(rows.slice(0, cut + 1).reverse()).reverse(), ...later]
        if (cut + 1 < rows.length && !later.length) return { status: "blocked", reason: "unsupported_storage" }
      } else {
        const later = take(rows.slice(cut))
        if (!later.length) return { status: "blocked", reason: "unsupported_storage" }
        kept = [...take(rows.slice(0, cut).reverse()).reverse(), ...later]
      }
      if (!kept.length && rows.length) return { status: "blocked", reason: "unsupported_storage" }
      rows = kept
    }
    const ordinary = referenceFiles ? rows.filter(row => row.type !== "user") : rows
    if (ordinary.some(row => Number(row.bytes) > MESSAGE_BYTES) || ordinary.reduce((n, row) => n + Number(row.bytes), 0) > WINDOW_BYTES) {
      return { status: "blocked", reason: "unsupported_storage" }
    }
    const messages = []
    const read = db.prepare(`SELECT data FROM ${storage.table} WHERE session_id=? AND id=?`)
    let windowBytes = 0
    for (const row of rows) {
      signal.throwIfAborted()
      let data: Record<string, unknown>
      let minimumBytes = 0
      if (referenceFiles && row.type === "user") {
        const projection = projectStoredUserFiles(db, scope.sessionID!, String(row.id), MESSAGE_BYTES, signal)
        if (!projection) return { status: "blocked", reason: "unsupported_storage" }
        data = projection
      } else {
        const stored = read.get(scope.sessionID!, row.id)
        if (typeof stored?.data !== "string") return { status: "blocked", reason: "conflict" }
        const projection = projectStoredMedia(db, JSON.parse(stored.data), Number(row.bytes), MESSAGE_BYTES)
        if (projection.status !== "ok") return { status: "blocked", reason: "unsupported_storage" }
        data = projection.data
        minimumBytes = projection.bytes
      }
      const message = { ...data, id: row.id, type: row.type }
      const bytes = referenceFiles ? Math.max(minimumBytes, Buffer.byteLength(JSON.stringify(message))) : minimumBytes
      if (bytes > MESSAGE_BYTES || (windowBytes += bytes) > WINDOW_BYTES) return { status: "blocked", reason: "unsupported_storage" }
      messages.push(message)
      if (messages.length % YIELD_EVERY === 0) await yieldTurn(undefined, { signal })
    }
    const first = rows[0], last = rows.at(-1)
    const older = first && db.prepare(`SELECT 1 FROM session_message WHERE ${where} AND seq < ? LIMIT 1`).get(...params, first.seq)
    const newer = last && db.prepare(`SELECT 1 FROM session_message WHERE ${where} AND seq > ? LIMIT 1`).get(...params, last.seq)
    const result = navigationWindowResultSchema.parse({ status: "window", messages,
      older: older ? { kind: "before", messageID: first!.id } : null,
      newer: newer ? { kind: "after", messageID: last!.id } : null,
      resume: target,
      latest: !newer,
      ...(referenceFiles ? { userFiles: USER_FILES_REFERENCE } : {}),
    })
    return referenceFiles && Buffer.byteLength(JSON.stringify({ output: result })) > WINDOW_BYTES
      ? { status: "blocked", reason: "unsupported_storage" } : result
  } finally { db.exec("ROLLBACK") }
}
