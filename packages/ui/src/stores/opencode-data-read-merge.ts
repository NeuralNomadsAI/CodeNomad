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

/** Text-bearing parts without part identity: a stream only ever appends within
 * a fragment, and the native persists a fragment's text only when its
 * full-text ending commits — as the accumulated value or as the provider's
 * completed-item replacement, which may be shorter, prefixed or empty. A
 * fetched part holding no text on a row whose step is open on both sides is
 * therefore a fragment whose ending has not committed yet: older than the
 * deltas the live row already displays, and never authoritative. Any
 * committed final carries a value or the row's completion, and keeps full
 * page authority. */
function isUnpersistedOpenFragment(
  row: SessionMessageInfo,
  fetched: SessionMessageInfo,
  live: unknown,
  fetchedPart: unknown,
): boolean {
  if ((row as unknown as { time?: { completed?: unknown } }).time?.completed !== undefined) return false
  if ((fetched as unknown as { time?: { completed?: unknown } }).time?.completed !== undefined) return false
  if (typeof live !== "string" || live === "") return false
  if (typeof (fetchedPart as { text?: unknown })?.text !== "string") return false
  const endedReasoning = (fetchedPart as { time?: { completed?: unknown } }).time?.completed
  return (fetchedPart as { text?: unknown }).text === "" && endedReasoning === undefined
}

/** An open row keeps the text and reasoning its stream already displayed when
 * the fetched page still holds those fragments empty; every other field of the
 * fetched row stays authoritative, and text part shapes that do not pair up
 * keep full page authority. */
function mergeOpenFragmentRow(row: SessionMessageInfo, fetched: SessionMessageInfo): SessionMessageInfo {
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
    if (live === undefined || !isUnpersistedOpenFragment(row, fetched, (live as { text?: unknown }).text, part)) return part
    replaced = true
    return live
  })
  if (!replaced || cursor !== streamed.length) return fetched
  log.warn("Kept a message's streamed text over a fetched page holding its uncommitted fragment empty", { messageId: row.id })
  return { ...(fetched as object), content: mergedContent } as SessionMessageInfo
}

/** Merges a fetched page (newest first) with the live rows: the page is the
 * base, a live row that is new or changed since `since` keeps its live version
 * (with unchanged identified parts from the page), an open row keeps the text
 * of fragments the page still holds uncommitted, and live rows created during
 * the fetch and absent from the page ride along newest-first. */
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
    if (snapshot === serializeRowForDiff(row)) return mergeOpenFragmentRow(row, message)
    return mergeChangedRow(row, message, snapshot)
  })
  const created = live.filter((message) => !pageIds.has(message.id) && !since.has(message.id)).reverse()
  return [...created, ...merged]
}
