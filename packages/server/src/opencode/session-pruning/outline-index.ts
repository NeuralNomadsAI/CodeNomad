import { createHash } from "node:crypto"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import type { HistoryScope } from "./history-store"
import type { OutlineCheckpoint, OutlineEntry, OutlineResult } from "./navigation-contract"
import { ownedSession } from "./navigation-scope"

// Checkpoint boundaries survive deletion: removing an early row must not shift
// every later chunk. Only changed chunks need technical-part JSON projection.
export async function readSessionOutline(db: DatabaseSync, scope: HistoryScope,
  cursor: { after: number; through: number } | undefined, signal: AbortSignal, startAfter = -1,
  known: OutlineCheckpoint[] = []): Promise<OutlineResult> {
  signal.throwIfAborted()
  if (known.some((item, index) => item.through <= item.after || (index && item.after !== known[index - 1].through))) {
    return { status: "blocked", reason: "conflict" }
  }
  db.exec("BEGIN")
  try {
    const boundary = ownedSession(db, scope)
    const where = "session_id=?" + (boundary ? " AND id < ?" : "")
    const params: SQLInputValue[] = [scope.sessionID!, ...(boundary ? [boundary] : [])]
    const maximum = Number(db.prepare(`SELECT coalesce(max(seq),0) AS value FROM session_message WHERE ${where}`).get(...params)?.value)
    const through = cursor?.through ?? Math.max(maximum, known.at(-1)?.through ?? 0)
    const total = Number(db.prepare(`SELECT count(*) AS value FROM session_message WHERE ${where} AND seq<=?`).get(...params, through)?.value)
    let after = cursor?.after ?? startAfter
    const headers = db.prepare(`SELECT id,type,seq,time_updated,length(CAST(data AS BLOB)) AS bytes
      FROM session_message WHERE ${where} AND seq>? AND seq<=? ORDER BY seq LIMIT 512`)
    const project = db.prepare(`SELECT id,type,seq,
      CASE WHEN type='assistant' THEN (SELECT count(*) FROM json_each(data,'$.content') WHERE json_extract(value,'$.type')='tool') ELSE 0 END AS tools,
      CASE WHEN type='assistant' THEN coalesce((SELECT substr(CASE
          WHEN json_type(value,'$.name')='text' THEN json_extract(value,'$.name')
          WHEN json_type(value,'$.tool')='text' THEN json_extract(value,'$.tool') END,1,256)
        FROM json_each(data,'$.content') WHERE json_extract(value,'$.type')='tool'
        AND (json_type(value,'$.name')='text' OR json_type(value,'$.tool')='text') LIMIT 1),'') ELSE '' END AS tool_name,
      CASE WHEN type='assistant' THEN (SELECT count(*) FROM json_each(data,'$.content') WHERE json_extract(value,'$.type')='reasoning') ELSE 0 END AS reasoning
      FROM session_message WHERE ${where} AND seq>? AND seq<=? ORDER BY seq LIMIT 512`)
    const entries: OutlineEntry[] = [], checkpoints: Array<OutlineCheckpoint & { changed: boolean }> = []
    let examined = 0
    do {
      signal.throwIfAborted()
      const previous = known.find(item => item.after === after)
      // Grow the last range to 512 rows before creating another checkpoint.
      // Otherwise one append per refresh eventually exhausts the manifest budget.
      const end = Math.min(previous && previous !== known.at(-1) ? previous.through : through, through)
      const rows = headers.all(...params, after, end)
      // If a cached range gained >512 rows, split and rebuild it instead of
      // declaring the unseen suffix unchanged.
      const last = rows.at(-1)
      const chunkEnd = rows.length === 512 ? Number(last!.seq) : end
      const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex")
      const changed = previous?.through !== chunkEnd || previous.digest !== digest
        // The live tail is cheap and may change twice within a millisecond.
        || chunkEnd >= maximum
      if (changed) {
        for (const row of project.iterate(...params, after, chunkEnd)) {
          const tools = Number(row.tools)
          entries.push({ id: String(row.id), seq: Number(row.seq), type: row.type as OutlineEntry["type"],
            tools, reasoning: Number(row.reasoning),
            ...(tools ? { toolName: typeof row.tool_name === "string" ? row.tool_name : "" } : {}) })
          if (entries.length % 128 === 0) await yieldTurn(undefined, { signal })
        }
      }
      checkpoints.push({ after, through: chunkEnd, digest, changed })
      after = chunkEnd
      examined += rows.length
      await yieldTurn(undefined, { signal })
    // Old ranges shrink after deletions. Reserve a whole block before reading
    // another; the page budget is not necessarily a multiple of 512 anymore.
    } while (after < through && examined <= 16384 - 512 && checkpoints.length < 512)
    return { status: "outline", entries, checkpoints, total, cursor: after < through ? { after, through } : null }
  } finally { db.exec("ROLLBACK") }
}
