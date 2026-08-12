export type ReconcileTabDescriptor = { kind: string; folderPath?: string; occurrence?: number; lineageId?: string }
type LiveWorkspaceDescriptor = { id: string; folderPath: string; status?: string; lineageId?: string }
export type SessionDescriptor = { id: string; parentId?: string | null }
export interface RestoredSessionReferences {
  activeParentSessionId?: string
  activeSessionId?: string
  draftSessionIds: readonly string[]
  attachmentSessionIds?: readonly string[]
  scrollSessionIds: readonly string[]
  idleMarkerSessionIds?: readonly string[]
  generationRecoverySessionIds?: readonly string[]
  expandedSessionIds?: readonly string[]
}
export function normalizeWorkspacePath(folderPath: string): string {
  const windowsLike = /^(?:[A-Za-z]:[/\\]|[/\\]{2})/.test(folderPath)
  const normalized = windowsLike ? folderPath.replace(/\\/g, "/").toLowerCase() : folderPath
  return normalized === "/" || /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "")
}
export function getUnavailableWorkspaceIds(
  localIds: Iterable<string>,
  remoteIds: ReadonlySet<string>,
  isProtected: (id: string) => boolean,
): string[] {
  return [...localIds].filter((id) => !remoteIds.has(id) && !isProtected(id))
}
export function reconcileWorkspaceTabs(
  tabs: readonly ReconcileTabDescriptor[],
  liveWorkspaces: readonly LiveWorkspaceDescriptor[],
) {
  const liveByPath = new Map<string, LiveWorkspaceDescriptor[]>()
  const liveByLineage = new Map<string, LiveWorkspaceDescriptor>()
  for (const workspace of liveWorkspaces) {
    if (workspace.status === "stopped" || workspace.status === "error") continue
    const path = normalizeWorkspacePath(workspace.folderPath)
    liveByPath.set(path, [...(liveByPath.get(path) ?? []), workspace])
    if (workspace.lineageId) liveByLineage.set(workspace.lineageId, workspace)
  }
  const nextOccurrences = new Map<string, number>()
  const claimed = new Set<string>()
  return tabs.flatMap((tab, tabIndex) => {
    if (tab.kind !== "workspace" || typeof tab.folderPath !== "string") return []
    const path = normalizeWorkspacePath(tab.folderPath)
    const inferred = nextOccurrences.get(path) ?? 0
    const occurrence = Number.isInteger(tab.occurrence) && Number(tab.occurrence) >= 0 ? Number(tab.occurrence) : inferred
    nextOccurrences.set(path, Math.max(inferred, occurrence) + 1)
    const workspace = tab.lineageId ? liveByLineage.get(tab.lineageId) : liveByPath.get(path)?.[occurrence]
    const existingWorkspaceId = workspace && !claimed.has(workspace.id) ? workspace.id : null
    if (existingWorkspaceId) claimed.add(existingWorkspaceId)
    return [{
      tabIndex,
      descriptor: {
        kind: "workspace" as const, folderPath: tab.folderPath, occurrence,
        ...(tab.lineageId ? { lineageId: tab.lineageId } : {}),
      },
      existingWorkspaceId,
    }]
  })
}
export function resolveRestoredSessionSelection(
  availableSessions: readonly SessionDescriptor[],
  requestedParentSessionId: string | null | undefined,
  requestedActiveSessionId: string | null | undefined,
) {
  const sessions = new Map(availableSessions.map((session) => [session.id, session]))
  const rootId = (sessionId: string | null | undefined): string | null => {
    let current = sessionId ? sessions.get(sessionId) : undefined
    const seen = new Set<string>()
    while (current?.parentId) {
      if (seen.has(current.id)) return null
      seen.add(current.id)
      current = sessions.get(current.parentId)
    }
    return current?.id ?? null
  }
  const parentSessionId = rootId(requestedParentSessionId)
  if (requestedActiveSessionId === "info") return { parentSessionId, activeSessionId: "info" }
  const active = requestedActiveSessionId ? sessions.get(requestedActiveSessionId) : undefined
  const activeParentId = rootId(active?.id)
  if (active && activeParentId && (!parentSessionId || parentSessionId === activeParentId)) {
    return { parentSessionId: activeParentId, activeSessionId: active.id }
  }
  return parentSessionId ? { parentSessionId, activeSessionId: parentSessionId } : null
}
export function getUnavailableRestoredSessionIds(
  availableSessions: readonly SessionDescriptor[],
  references: RestoredSessionReferences,
  allowedNonSessionIds: readonly string[] = [],
): Set<string> {
  const available = new Set(availableSessions.map(({ id }) => id))
  const allowed = new Set(allowedNonSessionIds)
  const referenced = [
    references.activeParentSessionId,
    references.activeSessionId === "info" ? undefined : references.activeSessionId,
    ...references.draftSessionIds,
    ...(references.attachmentSessionIds ?? []),
    ...references.scrollSessionIds,
    ...(references.idleMarkerSessionIds ?? []),
    ...(references.generationRecoverySessionIds ?? []),
    ...(references.expandedSessionIds ?? []),
  ]
  return new Set(referenced.filter((id): id is string => Boolean(id) && !available.has(id!) && !allowed.has(id!)))
}
export function resolveRestoredActiveTabId(
  restoredTabIds: readonly (string | null | undefined)[],
  requestedActiveTabIndex: number,
): string | null {
  const requested = Number.isInteger(requestedActiveTabIndex) && requestedActiveTabIndex >= 0
    ? restoredTabIds[requestedActiveTabIndex]
    : null
  return requested || restoredTabIds.find((id): id is string => Boolean(id)) || null
}
export function shouldRestoreSessionState(isPrimary: boolean, restoreEnabled: boolean, snapshot: unknown): boolean {
  return Boolean(isPrimary && restoreEnabled && snapshot)
}
