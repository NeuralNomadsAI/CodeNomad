import type { SessionMessageInfo } from "@opencode/client"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

/** A session's live rows, serialized when a read starts. */
export type OpenCodeRowSnapshot = Map<string, string>

/** SDK step boundaries stamp the root `time.completed` onto adjacent rows
 * without changing their content: such a row still takes the fetched
 * (terminal) version. */
function serializeRowForDiff(row: SessionMessageInfo): string {
  const record = row as unknown as { time?: { completed?: unknown } }
  return JSON.stringify({ ...(row as object), time: record.time === undefined ? undefined : { ...record.time, completed: undefined } })
}

export function snapshotRows(live: readonly SessionMessageInfo[]): OpenCodeRowSnapshot {
  const snapshot: OpenCodeRowSnapshot = new Map()
  for (const message of live) snapshot.set(message.id, serializeRowForDiff(message))
  return snapshot
}

type ContentRow = { content?: unknown }

const partId = (part: unknown): string | undefined => {
  const id = (part as { id?: unknown } | null)?.id
  return typeof id === "string" ? id : undefined
}

/** A live row changed since its snapshot keeps its live version, except that
 * each identified content part (a tool call, for example) left unchanged since
 * the snapshot takes the page's version: progress on one part never shadows
 * authority for a sibling part. */
function mergeChangedRow(row: SessionMessageInfo, fetched: SessionMessageInfo, snapshot: string | undefined): SessionMessageInfo {
  const content = (row as ContentRow).content
  const fetchedContent = (fetched as ContentRow).content
  const before = snapshot === undefined ? undefined : (JSON.parse(snapshot) as ContentRow).content
  if (!Array.isArray(content) || !Array.isArray(fetchedContent) || !Array.isArray(before)) return row
  const beforeById = new Map(before.flatMap((part) => partId(part) === undefined ? [] : [[partId(part)!, JSON.stringify(part)]]))
  const fetchedById = new Map(fetchedContent.flatMap((part) => partId(part) === undefined ? [] : [[partId(part)!, part]]))
  let replaced = false
  const parts = content.map((part) => {
    const id = partId(part)
    if (id === undefined || !fetchedById.has(id) || beforeById.get(id) !== JSON.stringify(part)) return part
    replaced = true
    return fetchedById.get(id)
  })
  return replaced ? { ...(row as object), content: parts } as SessionMessageInfo : row
}

/** Text-bearing parts without part identity: a stream only ever appends to
 * them, and the native persists either the empty part (before its full-text
 * ending commits) or the ended value. A fetched copy therefore cannot be a
 * legitimately newer value when it is strictly shorter than the live text and
 * prefixed by it — that shape is the stream state the live row already
 * superseded, whatever route the page took. */
function isSupersededStreamText(live: unknown, fetched: unknown): boolean {
  if (typeof live !== "string" || typeof fetched !== "string" || fetched.length >= live.length) return false
  return live.startsWith(fetched)
}

/** A row keeps its streamed text and reasoning when the fetched page still
 * holds their superseded prefixes; every other field of the fetched row stays
 * authoritative. Text part shapes that do not pair up keep full page
 * authority. */
function mergeStreamTextRow(row: SessionMessageInfo, fetched: SessionMessageInfo): SessionMessageInfo {
  const content = (row as ContentRow).content
  const fetchedContent = (fetched as ContentRow).content
  if (!Array.isArray(content) || !Array.isArray(fetchedContent)) return fetched
  const streamed: unknown[] = content.filter((part) => {
    const type = (part as { type?: unknown } | null)?.type
    return type === "text" || type === "reasoning"
  })
  let cursor = 0
  let replaced = false
  const mergedContent = fetchedContent.map((part) => {
    const type = (part as { type?: unknown } | null)?.type
    if (type !== "text" && type !== "reasoning") return part
    const live = streamed[cursor]
    cursor += 1
    if (live === undefined || !isSupersededStreamText((live as { text?: unknown }).text, (part as { text?: unknown }).text)) return part
    replaced = true
    return live
  })
  if (!replaced || cursor !== streamed.length) return fetched
  log.warn("Kept a message's streamed text over a fetched page holding its superseded prefix", { messageId: row.id })
  return { ...(fetched as object), content: mergedContent } as SessionMessageInfo
}

/** Merges a fetched page (newest first) with the live rows: the page is the
 * base, a live row that is new or changed since `since` keeps its live version
 * (with unchanged identified parts from the page), a row keeps the streamed
 * text the page would rewind, and live rows created during the fetch and
 * absent from the page ride along newest-first. */
export function mergePageWithSnapshot(
  live: readonly SessionMessageInfo[],
  page: readonly SessionMessageInfo[],
  since: OpenCodeRowSnapshot,
): SessionMessageInfo[] {
  const liveById = new Map(live.map((message) => [message.id, message]))
  const pageIds = new Set(page.map((message) => message.id))
  const merged = page.map((message) => {
    const row = liveById.get(message.id)
    if (row === undefined) return message
    const snapshot = since.get(row.id)
    if (snapshot === serializeRowForDiff(row)) return mergeStreamTextRow(row, message)
    return mergeChangedRow(row, message, snapshot)
  })
  const created = live.filter((message) => !pageIds.has(message.id) && !since.has(message.id)).reverse()
  return [...created, ...merged]
}
