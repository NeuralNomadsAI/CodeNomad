const NON_SESSION_IDS = new Set(["info", "__no_session_draft__"])

export function getRestoredSessionIds(groups: Iterable<string>[]): string[] {
  const ids = new Set<string>()
  for (const group of groups) {
    for (const id of group) {
      if (id && !NON_SESSION_IDS.has(id)) ids.add(id)
    }
  }
  return [...ids]
}
