export type SessionPaginationState = {
  ids: string[]
  hasMore: boolean
  nextCursor?: string
}

export function getDefaultSessionPaginationState(): SessionPaginationState {
  return { ids: [], hasMore: true, nextCursor: undefined }
}

export function applySessionPage(
  current: SessionPaginationState | undefined,
  ids: string[],
  hasMore: boolean,
  reset = false,
  nextCursor?: string,
): SessionPaginationState {
  const previous = current ?? getDefaultSessionPaginationState()
  const nextIds = reset ? ids : Array.from(new Set([...previous.ids, ...ids]))
  return {
    ids: nextIds,
    hasMore,
    nextCursor,
  }
}
