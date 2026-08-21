export const MESSAGE_HISTORY_TOP_THRESHOLD_PX = 320
export const MESSAGE_HISTORY_ANCHOR_PAGE_LIMIT = 50

export function isMessageHistoryRestoreCurrent<T>(
  active: boolean,
  capturedList: T,
  currentList: T | null,
  generationCurrent: boolean,
): boolean {
  return active && capturedList === currentList && generationCurrent
}

export async function loadPagesUntilAnchor(options: {
  hasAnchor: () => boolean
  hasMore: () => boolean
  isCurrent: () => boolean
  loadMore: () => Promise<void>
  maxPages?: number
}): Promise<"found" | "exhausted" | "cancelled" | "limit"> {
  if (!options.isCurrent()) return "cancelled"
  if (options.hasAnchor()) return "found"

  const maxPages = options.maxPages ?? MESSAGE_HISTORY_ANCHOR_PAGE_LIMIT
  for (let page = 0; page < maxPages; page += 1) {
    if (!options.isCurrent()) return "cancelled"
    if (!options.hasMore()) return "exhausted"
    await options.loadMore()
    if (!options.isCurrent()) return "cancelled"
    if (options.hasAnchor()) return "found"
  }

  return options.hasMore() ? "limit" : "exhausted"
}

export async function loadCompleteMessageHistory<T>(options: {
  getCursor: () => string | undefined
  isCurrent: () => boolean
  loadMore: () => Promise<void>
  complete: () => T
}): Promise<T | null> {
  const seenCursors = new Set<string>()
  while (options.isCurrent()) {
    const cursor = options.getCursor()
    if (!cursor) return options.complete()
    if (seenCursors.has(cursor)) return null
    seenCursors.add(cursor)
    await options.loadMore()
  }
  return null
}

export async function loadMessageHistoryPage(options: {
  getCursor: () => string | undefined
  getMessageCount: () => number
  loadMore: () => Promise<void>
}): Promise<boolean> {
  const cursor = options.getCursor()
  const messageCount = options.getMessageCount()
  await options.loadMore()
  return options.getCursor() !== cursor && options.getMessageCount() !== messageCount
}

export function hasMessageSearchAuthority(query: string, searchedQuery: string): boolean {
  return query.trim().length > 0 && searchedQuery.trim() === query.trim()
}

export function shouldLoadOlderMessages(options: {
  active: boolean
  failed: boolean
  hasMore: boolean
  loading: boolean
  messageCount: number
  scrollTop: number
}): boolean {
  return options.active
    && !options.failed
    && options.hasMore
    && !options.loading
    && options.messageCount > 0
    && options.scrollTop <= MESSAGE_HISTORY_TOP_THRESHOLD_PX
}
