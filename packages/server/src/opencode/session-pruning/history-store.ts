import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { z } from "zod"
import { storageDirectory } from "./storage-path"
import { previewContent } from "./planner"
import type { HistoryQuery, HistoryNativePage, HistoryHit } from "./history-contract"

export interface HistoryScope { directory: string; workspaceID?: string; sessionID?: string; projectID?: string }
const cursorSchema = z.object({
  after: z.number().int().nonnegative(), through: z.number().int().nonnegative(), binding: z.string(),
}).strict()
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

function excerpt(text: string, query: string): string | undefined {
  const index = text.toLowerCase().indexOf(query)
  if (index < 0) return undefined
  const start = Math.max(0, index - 80)
  return text.slice(start, start + 320)
}

// Edit-style tools keep their diff in metadata rather than the text content:
// `metadata.diff` in OpenCode 1.x and `metadata.files[].patch` in 2.x.
function diffTexts(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return []
  const { diff, files } = metadata as { diff?: unknown; files?: unknown }
  return [diff, ...(Array.isArray(files) ? files.map((file: { patch?: unknown } | null) => file?.patch) : [])].filter((text): text is string => typeof text === "string")
}

function findHit(content: unknown, query: string, includeTechnical: boolean): Pick<HistoryHit, "partIndex" | "kind" | "excerpt"> | undefined {
  if (!Array.isArray(content)) return
  for (let partIndex = 0; partIndex < content.length; partIndex++) {
    const part = content[partIndex]
    if (!part || typeof part !== "object") continue
    const kind = part.type
    if (kind !== "text" && (!includeTechnical || (kind !== "tool" && kind !== "reasoning"))) continue
    // Search readable content and tool arguments/output, not attachments or
    // opaque provider continuation state. No regexp supplied by the caller.
    const texts: string[] = kind === "tool"
      ? [part.tool, part.name, JSON.stringify(part.input ?? part.state?.input), part.state?.error, ...(Array.isArray(part.state?.content)
        ? part.state.content.filter((p: any) => p.type === "text").map((p: any) => p.text) : []), ...diffTexts(part.state?.metadata)]
      : [part.text]
    for (const text of texts) {
      if (typeof text !== "string") continue
      const match = excerpt(text, query)
      if (match !== undefined) return { partIndex, kind, excerpt: match }
    }
  }
}

// Each call examines at most 32 messages, materializes one bounded message at a
// time and yields to the native event loop. No index/triggers in OpenCode's DB.
// The rowid horizon prevents an active generation from extending a traversal.
export async function queryHistoryPage(db: DatabaseSync, scope: HistoryScope, input: HistoryQuery, signal: AbortSignal): Promise<HistoryNativePage> {
  const binding = createHash("sha256").update(JSON.stringify([scope, input.query, input.includeTechnical, input.purpose])).digest("hex")
  const directory = storageDirectory(scope.directory)
  const prefix = directory.endsWith("/") ? directory : `${directory}/`
  const where = (scope.sessionID ? "s.directory = ?" : "(s.directory = ? OR substr(s.directory,1,length(?)) = ?)") + " AND s.workspace_id IS ?"
    + (scope.sessionID ? " AND s.id = ? AND s.project_id = ?" : " AND s.project_id IN (?, 'global')")
  const params = [directory, ...(!scope.sessionID ? [prefix, prefix] : []), scope.workspaceID ?? null,
    ...(scope.sessionID ? [scope.sessionID, scope.projectID!] : [scope.projectID ?? "global"])]
  const cursor = input.cursor ? cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString())) : {
    after: 0,
    through: Number(db.prepare(`SELECT coalesce(max(m.rowid),0) AS maximum FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE ${where}`).get(...params)?.maximum ?? 0),
    binding,
  }
  if (cursor.binding !== binding || cursor.after > cursor.through) throw new Error("Invalid history cursor")
  const result: HistoryNativePage = { status: "page", scanned: 0, tools: 0, reasoning: 0, skipped: 0, hits: [], candidates: [], cursor: null, sessions: [] }
  const rows = db.prepare(`SELECT m.rowid AS position,m.id,m.session_id,m.type,s.directory,s.workspace_id,
    CASE WHEN length(CAST(m.data AS BLOB)) <= ? THEN m.data ELSE NULL END AS data
    FROM session_message m JOIN session_v2 s ON s.id=m.session_id
    WHERE ${where} AND m.rowid > ? AND m.rowid <= ? ORDER BY m.rowid LIMIT 32`)
  let after = cursor.after
  const started = performance.now()
  for (const row of rows.iterate(MAX_MESSAGE_BYTES, ...params, cursor.after, cursor.through)) {
    signal.throwIfAborted()
    after = Number(row.position)
    result.scanned++
    let owner = result.sessions.find(owner => owner.sessionID === row.session_id)
    if (!owner) {
      owner = { sessionID: String(row.session_id), directory: String(row.directory),
        ...(typeof row.workspace_id === "string" ? { workspaceID: row.workspace_id } : {}),
        scanned: 0, tools: 0, reasoning: 0, skipped: 0 }
      result.sessions.push(owner)
    }
    owner.scanned++
    const previousSkipped = result.skipped
    try {
      if (typeof row.data !== "string") throw new Error("Oversized history message")
      const data = JSON.parse(row.data)
      if (!data || typeof data !== "object") throw new Error("Unsupported history content")
      if (row.type === "assistant" && !Array.isArray(data.content)) throw new Error("Unsupported assistant content")
      const content = Array.isArray(data.content) ? data.content : [data.text, data.summary, data.command, data.output?.output]
        .filter((text): text is string => typeof text === "string").map(text => ({ type: "text", text }))
      const tools = content.filter((p: any) => p?.type === "tool").length
      const reasoning = content.filter((p: any) => p?.type === "reasoning").length
      result.tools += tools
      result.reasoning += reasoning
      owner.tools += tools
      owner.reasoning += reasoning
      if (input.purpose === "prune" && row.type === "assistant" && tools + reasoning) {
        const preview = previewContent(data)
        if (preview.status === "preview") result.candidates.push({ messageID: String(row.id), revision: preview.revision, toolCount: tools, reasoningCount: reasoning })
        else result.skipped++
      }
      if (input.purpose === "search" && input.query.trim()) {
        const hit = findHit(content, input.query.trim().toLowerCase(), input.includeTechnical)
        if (hit) result.hits.push({ sessionID: String(row.session_id), messageID: String(row.id), role: String(row.type), ...hit })
      }
    } catch { result.skipped++ }
    owner.skipped += result.skipped - previousSkipped
    await yieldTurn(undefined, { signal })
    if (performance.now() - started >= 40) break
  }
  // Empty pages complete the scan too, including deletions since the first page.
  if (result.scanned && after < cursor.through) {
    result.cursor = Buffer.from(JSON.stringify({ ...cursor, after })).toString("base64url")
  }
  return result
}
