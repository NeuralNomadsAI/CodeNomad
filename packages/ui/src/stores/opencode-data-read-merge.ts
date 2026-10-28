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

/** Merges a fetched page (newest first) with the live rows: the page is the
 * base, a live row that is new or changed since `since` keeps its live version,
 * and live rows created during the fetch and absent from the page ride along
 * newest-first. */
export function mergePageWithSnapshot(
  live: readonly SessionMessageInfo[],
  page: readonly SessionMessageInfo[],
  since: OpenCodeRowSnapshot,
): SessionMessageInfo[] {
  const liveById = new Map(live.map((message) => [message.id, message]))
  const pageIds = new Set(page.map((message) => message.id))
  const merged = page.map((message) => {
    const row = liveById.get(message.id)
    return row !== undefined && since.get(row.id) !== serializeRowForDiff(row) ? row : message
  })
  const created = live.filter((message) => !pageIds.has(message.id) && !since.has(message.id)).reverse()
  return [...created, ...merged]
}
