export const MESSAGE_HISTORY_TOP_THRESHOLD_PX = 320
export const MESSAGE_HISTORY_ANCHOR_PAGE_LIMIT = 50
export const MESSAGE_HISTORY_TRAVERSAL_PAGE_LIMIT = 1000

export function getMessageWindowPageKey(window?: {
  kind?: string
  resumeCursor?: string
  newerCursors?: Array<string | null>
}): string {
  return `${window?.kind ?? "latest"}:${window?.resumeCursor ?? ""}:${window?.newerCursors?.join("\0") ?? ""}`
}

export function createSearchLocatorAuthority() {
  let current: { id: string; generation: number } | null = null
  let generation = 0
  return {
    claim(id: string) {
      if (current?.id === id) return null
      current = { id, generation: ++generation }
      return current
    },
    isCurrent(token: { id: string; generation: number }) {
      return current?.id === token.id && current.generation === token.generation
    },
    reset(expected?: { id: string; generation: number }) {
      if (expected && (current?.id !== expected.id || current.generation !== expected.generation)) return
      current = null
    },
  }
}

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
  getCursor?: () => string | undefined
  maxPages?: number
}): Promise<"found" | "exhausted" | "cancelled"> {
  if (!options.isCurrent()) return "cancelled"
  if (options.hasAnchor()) return "found"

  const maxPages = Number.isFinite(options.maxPages)
    ? Math.max(1, Math.floor(options.maxPages!))
    : MESSAGE_HISTORY_ANCHOR_PAGE_LIMIT
  for (let page = 0; page < maxPages; page += 1) {
    if (!options.isCurrent()) return "cancelled"
    if (!options.hasMore()) return "exhausted"
    const cursor = options.getCursor?.()
    await options.loadMore()
    if (!options.isCurrent()) return "cancelled"
    if (options.hasAnchor()) return "found"
    if (options.hasMore() && options.getCursor && options.getCursor() === cursor) {
      throw new Error("Message history cursor did not advance")
    }
  }

  if (options.hasMore()) throw new Error("Message history anchor page limit reached")
  return "exhausted"
}

export async function loadCompleteMessageHistory<T>(options: {
  getPageKey: () => string
  isCurrent: () => boolean
  isLatest: () => boolean
  loadOldest: () => Promise<void>
  loadNewer: () => Promise<void>
  visit: () => T[]
  maxPages?: number
}): Promise<T[] | null> {
  const seenCursors = new Set<string>()
  const results: T[] = []
  const maxPages = Number.isFinite(options.maxPages)
    ? Math.max(1, Math.floor(options.maxPages!))
    : MESSAGE_HISTORY_TRAVERSAL_PAGE_LIMIT
  if (!options.isCurrent()) return null
  await options.loadOldest()
  for (let page = 0; page < maxPages; page += 1) {
    if (!options.isCurrent()) return null
    const cursor = options.getPageKey()
    if (seenCursors.has(cursor)) throw new Error("Message history cursor did not advance")
    seenCursors.add(cursor)
    results.push(...options.visit())
    if (options.isLatest()) return results
    await options.loadNewer()
  }
  if (!options.isCurrent()) return null
  throw new Error("Message history traversal page limit reached")
}

export async function loadMessageHistoryPage(options: {
  getCursor: () => string | undefined
  loadMore: () => Promise<void>
}): Promise<boolean> {
  const cursor = options.getCursor()
  await options.loadMore()
  return options.getCursor() !== cursor
}

export function hasMessageSearchAuthority(query: string, searchedQuery: string): boolean {
  return query.trim().length > 0 && searchedQuery.trim() === query.trim()
}

export function reconcileResidentSearchMatches<T extends { messageId: string }>(options: {
  previous: T[]
  currentResidentIds: readonly string[]
  currentMatches: T[]
}): T[] {
  const residentIds = new Set(options.currentResidentIds)
  const replacements = new Map<string, T[]>()
  for (const match of options.currentMatches) {
    const matches = replacements.get(match.messageId)
    if (matches) matches.push(match)
    else replacements.set(match.messageId, [match])
  }

  const replaced = new Set<string>()
  const result: T[] = []
  for (const match of options.previous) {
    if (!residentIds.has(match.messageId)) {
      result.push(match)
      continue
    }
    if (replaced.has(match.messageId)) continue
    replaced.add(match.messageId)
    result.push(...(replacements.get(match.messageId) ?? []))
  }

  for (let residentIndex = 0; residentIndex < options.currentResidentIds.length; residentIndex += 1) {
    const messageId = options.currentResidentIds[residentIndex]
    if (replaced.has(messageId)) continue
    const matches = replacements.get(messageId)
    if (!matches?.length) continue
    const previousResidentIds = new Set(options.currentResidentIds.slice(0, residentIndex))
    const nextResidentIds = new Set(options.currentResidentIds.slice(residentIndex + 1))
    let previousIndex = -1
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (!previousResidentIds.has(result[index].messageId)) continue
      previousIndex = index
      break
    }
    const nextIndex = result.findIndex((match) => nextResidentIds.has(match.messageId))
    const insertion = previousIndex >= 0
      ? previousIndex + 1
      : nextIndex >= 0
        ? nextIndex
        : result.findIndex((match) => match.messageId > messageId)
    result.splice(insertion < 0 ? result.length : insertion, 0, ...matches)
  }
  return result
}

export function shouldLoadOlderMessages(options: {
  active: boolean
  failed: boolean
  hasMore: boolean
  loading: boolean
  scrollTop: number
}): boolean {
  return options.active
    && !options.failed
    && options.hasMore
    && !options.loading
    && options.scrollTop <= MESSAGE_HISTORY_TOP_THRESHOLD_PX
}
