export interface SessionParentInfo {
  parentID?: string | null
  parentId?: string | null
}

type SessionParentLookup = (instanceId: string) => ReadonlyMap<string, SessionParentInfo> | undefined
let sessionParentLookup: SessionParentLookup | undefined

export function registerSessionParentLookup(lookup: SessionParentLookup | undefined): void {
  sessionParentLookup = lookup
}

export function knownSessionsForInstance(instanceId: string): ReadonlyMap<string, SessionParentInfo> | undefined {
  return sessionParentLookup?.(instanceId)
}

/** Extract session and optional parent session identifiers from a native event payload. */
export function eventSessionRefs(event: unknown): { sessionID?: string; parentID?: string } {
  if (!event || typeof event !== "object") return {}
  const data = (event as { data?: Record<string, unknown> }).data
  if (!data || typeof data !== "object") return {}
  const info = data.info && typeof data.info === "object" ? data.info as Record<string, unknown> : undefined
  const form = data.form && typeof data.form === "object" ? data.form as Record<string, unknown> : undefined
  const sessionID = typeof data.sessionID === "string" ? data.sessionID
    : typeof form?.sessionID === "string" ? form.sessionID
      : typeof info?.id === "string" ? info.id : undefined
  const parentID = typeof data.parentID === "string" ? data.parentID
    : typeof info?.parentID === "string" ? info.parentID : undefined
  return { sessionID, parentID }
}

function parentOf(session: SessionParentInfo): string | undefined {
  const parent = session.parentID ?? session.parentId
  return typeof parent === "string" && parent.length > 0 ? parent : undefined
}

/**
 * Returns true ONLY when the event carries a session whose known ancestry in
 * `sessionsMap` terminates at a loaded root session outside `relatedRoots`.
 * Missing session IDs or incomplete ancestry return false (conservative).
 */
export function isUnrelatedSessionEvent(
  event: unknown,
  relatedRoots: ReadonlySet<string>,
  sessionsMap?: ReadonlyMap<string, SessionParentInfo>,
): boolean {
  const { sessionID, parentID } = eventSessionRefs(event)
  if (!sessionID && !parentID) return false
  if (sessionID && relatedRoots.has(sessionID)) return false
  if (parentID && relatedRoots.has(parentID)) return false
  if (!sessionsMap) return false
  let current: string | undefined = sessionID && sessionsMap.has(sessionID) ? sessionID
    : parentID && sessionsMap.has(parentID) ? parentID : undefined
  if (!current) return false
  const visited = new Set<string>()
  while (current) {
    if (relatedRoots.has(current)) return false
    if (visited.has(current)) return false
    visited.add(current)
    const entry = sessionsMap.get(current)
    if (!entry) return false
    const parent = parentOf(entry)
    if (!parent) return true
    current = parent
  }
  return false
}
