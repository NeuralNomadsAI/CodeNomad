import type { SessionMessageInfo } from "@opencode/client"

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

/** Merges a fetched page (newest first) with the live rows: the page is the
 * base, a live row that is new or changed since `since` keeps its live version
 * (with unchanged identified parts from the page), and live rows created
 * during the fetch and absent from the page ride along newest-first. */
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
    return snapshot !== serializeRowForDiff(row) ? mergeChangedRow(row, message, snapshot) : message
  })
  const created = live.filter((message) => !pageIds.has(message.id) && !since.has(message.id)).reverse()
  return [...created, ...merged]
}
