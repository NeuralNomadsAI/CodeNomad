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
 * the snapshot takes the page's version, and a part only the page holds (by ID,
 * or a text/reasoning fragment by kind and ordinal unless the stream created
 * the row during the fetch) joins the row beside its page neighbours: progress
 * on one part never shadows authority for a sibling part, nor hides one the
 * live row missed. Live fragments stay aligned to native ordinals because
 * misaligned fragment events never reduce. */
function mergeChangedRow(row: SessionMessageInfo, fetched: SessionMessageInfo, snapshot: string | undefined): SessionMessageInfo {
  const content = (row as ContentRow).content
  const fetchedContent = (fetched as ContentRow).content
  const before = snapshot === undefined ? undefined : (JSON.parse(snapshot) as ContentRow).content
  if (!Array.isArray(content) || !Array.isArray(fetchedContent)) return row
  const beforeById = new Map((Array.isArray(before) ? before : []).flatMap((part) => partId(part) === undefined ? [] : [[partId(part)!, JSON.stringify(part)]]))
  const fetchedById = new Map(fetchedContent.flatMap((part) => partId(part) === undefined ? [] : [[partId(part)!, part]]))
  let replaced = false
  const parts = content.map((part) => {
    const id = partId(part)
    if (id === undefined || !fetchedById.has(id) || beforeById.get(id) !== JSON.stringify(part)) return part
    replaced = true
    return fetchedById.get(id)
  })
  // Anonymous fragments pair up by kind and ordinal, so a recovered part keeps
  // its side of the text and reasoning between its page neighbours.
  const fetchedKeys = partKeys(fetchedContent)
  const keys = partKeys(parts)
  const held = new Set(keys)
  fetchedContent.forEach((part, index) => {
    // A row the stream created during the fetch keeps its live fragments.
    if (held.has(fetchedKeys[index]) || (partId(part) === undefined && !Array.isArray(before))) return
    // After the nearest preceding page part the row holds, else before the
    // nearest following one, else at the end.
    const anchorAfter = fetchedKeys.slice(0, index).reverse().find((key) => held.has(key))
    const anchorBefore = fetchedKeys.slice(index + 1).find((key) => held.has(key))
    const position = anchorAfter !== undefined ? keys.indexOf(anchorAfter) + 1
      : anchorBefore !== undefined ? keys.indexOf(anchorBefore) : parts.length
    parts.splice(position, 0, part)
    keys.splice(position, 0, fetchedKeys[index])
    held.add(fetchedKeys[index])
    replaced = true
  })
  return replaced ? { ...(row as object), content: parts } as SessionMessageInfo : row
}

/** A content key per part: its ID, else its kind and ordinal among parts of that kind. */
function partKeys(content: readonly unknown[]): string[] {
  const ordinals = new Map<string, number>()
  return content.map((part) => {
    const id = partId(part)
    if (id !== undefined) return `id:${id}`
    const type = String((part as { type?: unknown } | null)?.type)
    const ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return `${type}:${ordinal}`
  })
}

/** Text-bearing parts without part identity: a stream only ever appends within
 * a fragment, and the native persists a fragment's text only when its
 * full-text ending commits — as the accumulated value or as the provider's
 * completed-item replacement, which may be shorter, prefixed or empty. An
 * ending commits before the next part is appended, in a separate step. A
 * committed text ending stamps the provider's `native` metadata onto the
 * stored part while an uncommitted text fragment has none; reasoning persists
 * `native` when it starts and marks its ending with `time.completed`. A
 * fetched part holding no text is therefore older than the deltas the live
 * row already displays only when it is the row's last fetched part, not ended
 * (text without native metadata, reasoning without `time.completed`), on a
 * step that is open on both sides. Committed finals — any value, an ended
 * marker, anywhere but last, or beside the row's completion — keep full page
 * authority. */
function isUnpersistedOpenFragment(
  row: SessionMessageInfo,
  fetched: SessionMessageInfo,
  live: unknown,
  fetchedPart: unknown,
  isLastFetchedPart: boolean,
): boolean {
  if (!isLastFetchedPart) return false
  if ((row as unknown as { time?: { completed?: unknown } }).time?.completed !== undefined) return false
  if ((fetched as unknown as { time?: { completed?: unknown } }).time?.completed !== undefined) return false
  if (typeof live !== "string" || live === "") return false
  if (typeof (fetchedPart as { text?: unknown })?.text !== "string") return false
  const part = fetchedPart as { type?: unknown; native?: unknown }
  if (part.type === "text" && part.native !== undefined && part.native !== null) return false
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
  const mergedContent = fetchedContent.map((part, index) => {
    const type = (part as { type?: unknown } | null)?.type
    if (type !== "text" && type !== "reasoning") return part
    const live = streamed[cursor]
    cursor += 1
    if (live === undefined || !isUnpersistedOpenFragment(row, fetched, (live as { text?: unknown }).text, part, index === fetchedContent.length - 1)) return part
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
