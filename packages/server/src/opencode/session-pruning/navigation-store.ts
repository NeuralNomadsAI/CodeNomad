import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { storageDirectory } from "./storage-path"
import type { HistoryScope } from "./history-store"
import { navigationWindowResultSchema, type NavigationTarget, type NavigationWindowResult, type OutlineResult, type OutlineEntry } from "./navigation-contract"

const PAGE_SIZE = 200
const MESSAGE_BYTES = 16 * 1024 * 1024
const WINDOW_BYTES = 24 * 1024 * 1024

function ownedSession(db: DatabaseSync, scope: HistoryScope) {
  const session = db.prepare("SELECT revert FROM session_v2 WHERE id=? AND directory=? AND project_id=? AND workspace_id IS ?")
    .get(scope.sessionID!, storageDirectory(scope.directory), scope.projectID!, scope.workspaceID ?? null)
  if (!session) throw new Error("Session location changed")
  const revert = typeof session.revert === "string" ? JSON.parse(session.revert) : undefined
  // Use the same staged-undo visibility boundary as the transcript. Native
  // storage retains the tail until commit; navigation must not expose it.
  return typeof revert?.messageID === "string" ? revert.messageID as string : undefined
}

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
      if (!anchor) return { status: "blocked", reason: "conflict" }
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
      await yieldTurn(undefined, { signal })
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

export async function readSessionOutline(db: DatabaseSync, scope: HistoryScope, cursor: { after: number; through: number } | undefined, signal: AbortSignal): Promise<OutlineResult> {
  signal.throwIfAborted()
  const boundary = ownedSession(db, scope)
  const where = "session_id=?" + (boundary ? " AND id < ?" : "")
  const params: SQLInputValue[] = [scope.sessionID!, ...(boundary ? [boundary] : [])]
  const through = cursor?.through ?? Number(db.prepare(`SELECT coalesce(max(seq),0) AS value FROM session_message WHERE ${where}`).get(...params)?.value)
  const total = Number(db.prepare(`SELECT count(*) AS value FROM session_message WHERE ${where} AND seq<=?`).get(...params, through)?.value)
  const rows = db.prepare(`SELECT id,type,seq,CASE WHEN length(CAST(data AS BLOB))<=? THEN data ELSE NULL END AS data
    FROM session_message WHERE ${where} AND seq>? AND seq<=? ORDER BY seq LIMIT 256`)
  const entries: OutlineEntry[] = []
  let after = cursor?.after ?? -1
  const started = performance.now()
  for (const row of rows.iterate(MESSAGE_BYTES, ...params, after, through)) {
    signal.throwIfAborted()
    after = Number(row.seq)
    const data = typeof row.data === "string" ? JSON.parse(row.data) : {}
    const parts = Array.isArray(data.content) ? data.content : []
    const texts = parts.filter((part: any) => part.type === "text").map((part: any) => typeof part.text === "string" ? part.text : "")
    const text = typeof data.text === "string" ? data.text : typeof data.summary === "string" ? data.summary : typeof data.command === "string" ? data.command : texts.join("\n")
    entries.push({ id: String(row.id), seq: after, type: row.type as OutlineEntry["type"], preview: text.slice(0, 220), chars: text.length,
      tools: parts.filter((part: any) => part.type === "tool").length, reasoning: parts.filter((part: any) => part.type === "reasoning").length })
    await yieldTurn(undefined, { signal })
    if (performance.now() - started > 40) break
  }
  return { status: "outline", entries, total, cursor: entries.length && after < through ? { after, through } : null }
}
