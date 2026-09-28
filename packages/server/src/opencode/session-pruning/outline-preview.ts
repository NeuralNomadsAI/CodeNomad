import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import type { HistoryScope } from "./history-store"
import type { OutlinePreviewResult } from "./navigation-contract"
import { ownedSession } from "./navigation-scope"

/** Demand-only excerpts, independent of index geometry and transcript windows. */
export async function readOutlinePreviews(db: DatabaseSync, scope: HistoryScope, ids: string[], signal: AbortSignal): Promise<OutlinePreviewResult> {
  signal.throwIfAborted()
  const boundary = ownedSession(db, scope)
  const params: SQLInputValue[] = [scope.sessionID!, ...(boundary ? [boundary] : [])]
  const read = db.prepare(`SELECT id, CASE WHEN length(CAST(data AS BLOB))<=16777216 THEN data END AS data
    FROM session_message WHERE session_id=? ${boundary ? "AND id < ?" : ""} AND id=?`)
  const entries: Array<{ id: string; text: string; tools: string }> = []
  for (const id of [...new Set(ids)].slice(0, 12)) {
    signal.throwIfAborted()
    const row = read.get(...params, id)
    if (!row) continue
    const data = typeof row.data === "string" ? JSON.parse(row.data) : {}
    let text = "", tools = ""
    const append = (current: string, value: unknown) => typeof value === "string" && current.length < 4096
      ? (current + (current ? "\n\n" : "") + value.slice(0, 4096 - current.length)).slice(0, 4096) : current
    for (const key of ["text", "summary", "command"]) text = append(text, data[key])
    for (const part of Array.isArray(data.content) ? data.content : []) {
      if (part.type === "text" && !part.synthetic && !part.ignored) text = append(text, part.text)
      if (part.type === "tool") {
        tools = append(tools, typeof part.name === "string" ? `**${part.name.replace(/[\\*`_]/g, "")}**` : "")
        tools = append(tools, part.state?.title)
        tools = append(tools, typeof part.state?.output === "string" ? part.state.output : part.state?.output?.output)
        for (const block of Array.isArray(part.state?.content) ? part.state.content : []) {
          if (block.type === "text") tools = append(tools, block.text)
        }
      }
    }
    entries.push({ id, text, tools })
    await yieldTurn(undefined, { signal })
  }
  return { status: "previews", entries }
}
