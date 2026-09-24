export interface ParsedSessionFilterQuery {
  sanitizedQuery: string
  pinnedFilter?: boolean
}

export function parseSessionFilterQuery(rawQuery: string): ParsedSessionFilterQuery {
  let pinnedFilter: boolean | undefined
  const remainingTokens = rawQuery.trim().split(/\s+/).filter((token) => {
    const lower = token.toLowerCase()
    if (lower === "is:pinned") {
      pinnedFilter = true
      return false
    }
    if (lower === "is:unpinned") {
      pinnedFilter = false
      return false
    }
    return true
  })

  return {
    sanitizedQuery: remainingTokens.join(" "),
    pinnedFilter,
  }
}
