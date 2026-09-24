import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { ownedSession } from "./navigation-scope"
import type { HistoryScope } from "./history-store"
import { navigationWindowResultSchema, type NavigationTarget, type NavigationWindowResult } from "./navigation-contract"
export { readSessionOutline } from "./outline-index"

const PAGE_SIZE = 200
const MESSAGE_BYTES = 16 * 1024 * 1024
const WINDOW_BYTES = 24 * 1024 * 1024
const YIELD_EVERY = 16

export async function readNavigationWindow(db: DatabaseSync, scope: HistoryScope, target: NavigationTarget, signal: AbortSignal): Promise<NavigationWindowResult> {
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
    const select = (clause: string, args: SQLInputValue[], ascending: boolean, count: number) => db.prepare(
      `SELECT id,type,seq,length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE ${where} ${clause} ORDER BY seq ${ascending ? "ASC" : "DESC"} LIMIT ?`,
    ).all(...params, ...args, count)
    const rows = target.kind === "around"
      ? [...select("AND seq < ?", [sequence!], false, 80).reverse(), ...select("AND seq >= ?", [sequence!], true, 120)]
      : target.kind === "latest" ? select("", [], false, PAGE_SIZE).reverse()
        : target.kind === "oldest" ? select("", [], true, PAGE_SIZE)
          : target.kind === "before"
            ? [...select("AND seq < ?", [sequence!], false, 184).reverse(), ...select("AND seq >= ?", [sequence!], true, 16)]
            : [...select("AND seq <= ?", [sequence!], false, 16).reverse(), ...select("AND seq > ?", [sequence!], true, 184)]
    if (rows.some(row => Number(row.bytes) > MESSAGE_BYTES) || rows.reduce((n, row) => n + Number(row.bytes), 0) > WINDOW_BYTES) {
      return { status: "blocked", reason: "unsupported_storage" }
    }
    const messages = []
    const read = db.prepare("SELECT data FROM session_message WHERE session_id=? AND id=?")
    for (const row of rows) {
      signal.throwIfAborted()
      const stored = read.get(scope.sessionID!, row.id)
      if (typeof stored?.data !== "string") return { status: "blocked", reason: "conflict" }
      messages.push({ ...JSON.parse(stored.data), id: row.id, type: row.type })
      if (messages.length % YIELD_EVERY === 0) await yieldTurn(undefined, { signal })
    }
    const first = rows[0], last = rows.at(-1)
    const older = first && db.prepare(`SELECT 1 FROM session_message WHERE ${where} AND seq < ? LIMIT 1`).get(...params, first.seq)
    const newer = last && db.prepare(`SELECT 1 FROM session_message WHERE ${where} AND seq > ? LIMIT 1`).get(...params, last.seq)
    return navigationWindowResultSchema.parse({ status: "window", messages,
      older: older ? { kind: "before", messageID: first!.id } : null,
      newer: newer ? { kind: "after", messageID: last!.id } : null,
      resume: target,
      latest: !newer,
    })
  } finally { db.exec("ROLLBACK") }
}
