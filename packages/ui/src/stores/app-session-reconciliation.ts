export interface WorkspaceTabDescriptor {
  kind: "workspace"
  folderPath: string
  occurrence: number
}

export interface LiveWorkspaceDescriptor {
  id: string
  folderPath: string
}

export interface WorkspaceTabMatch {
  tabIndex: number
  descriptor: WorkspaceTabDescriptor
  existingWorkspaceId: string | null
}

export interface ReconcileTabDescriptor {
  kind: string
  folderPath?: string
  occurrence?: number
}

export interface SessionDescriptor {
  id: string
  parentId?: string | null
}

export interface RestoredSessionSelection {
  parentSessionId: string | null
  activeSessionId: string
}

export interface RestoredSessionReferences {
  activeParentSessionId?: string
  activeSessionId?: string
  draftSessionIds: readonly string[]
  attachmentSessionIds?: readonly string[]
  scrollSessionIds: readonly string[]
}

function normalizeWorkspacePath(folderPath: string): string {
  const windowsLike = /^(?:[A-Za-z]:[/\\]|[/\\]{2})/.test(folderPath)
  const slashNormalized = windowsLike ? folderPath.replace(/\\/g, "/").toLowerCase() : folderPath
  if (slashNormalized === "/" || /^[a-z]:\/$/.test(slashNormalized)) return slashNormalized
  return slashNormalized.replace(/\/+$/, "")
}

function reconcileWorkspaceTabs(
  tabs: readonly ReconcileTabDescriptor[],
  liveWorkspaces: readonly LiveWorkspaceDescriptor[],
): WorkspaceTabMatch[] {
  const liveByPath = new Map<string, LiveWorkspaceDescriptor[]>()
  for (const workspace of liveWorkspaces) {
    const key = normalizeWorkspacePath(workspace.folderPath)
    const matches = liveByPath.get(key)
    if (matches) {
      matches.push(workspace)
    } else {
      liveByPath.set(key, [workspace])
    }
  }

  const result: WorkspaceTabMatch[] = []
  const inferredOccurrences = new Map<string, number>()
  const claimedWorkspaceIds = new Set<string>()
  tabs.forEach((tab, tabIndex) => {
    if (tab.kind !== "workspace" || typeof tab.folderPath !== "string") return
    const normalizedPath = normalizeWorkspacePath(tab.folderPath)
    const inferredOccurrence = inferredOccurrences.get(normalizedPath) ?? 0
    const occurrence = Number.isInteger(tab.occurrence) && Number(tab.occurrence) >= 0
      ? Number(tab.occurrence)
      : inferredOccurrence
    inferredOccurrences.set(normalizedPath, Math.max(inferredOccurrence, occurrence) + 1)
    const descriptor: WorkspaceTabDescriptor = {
      kind: "workspace",
      folderPath: tab.folderPath,
      occurrence,
    }
    const matches = liveByPath.get(normalizedPath) ?? []
    const existingWorkspace = matches[occurrence]
    const existingWorkspaceId = existingWorkspace && !claimedWorkspaceIds.has(existingWorkspace.id)
      ? existingWorkspace.id
      : null
    if (existingWorkspaceId) claimedWorkspaceIds.add(existingWorkspaceId)
    result.push({
      tabIndex,
      descriptor,
      existingWorkspaceId,
    })
  })
  return result
}

function resolveRestoredSessionSelection(
  availableSessions: readonly SessionDescriptor[],
  requestedParentSessionId: string | null | undefined,
  requestedActiveSessionId: string | null | undefined,
): RestoredSessionSelection | null {
  const sessionsById = new Map(availableSessions.map((session) => [session.id, session]))

  const resolveRootId = (sessionId: string | null | undefined): string | null => {
    if (!sessionId) return null
    let current = sessionsById.get(sessionId)
    if (!current) return null

    const seen = new Set<string>()
    while (current.parentId) {
      if (seen.has(current.id)) return null
      seen.add(current.id)
      const parent = sessionsById.get(current.parentId)
      if (!parent) return null
      current = parent
    }
    return current.id
  }

  const validRequestedParent = resolveRootId(requestedParentSessionId)

  if (requestedActiveSessionId === "info") {
    return { parentSessionId: validRequestedParent, activeSessionId: "info" }
  }

  const requestedActive = requestedActiveSessionId ? sessionsById.get(requestedActiveSessionId) : undefined
  if (requestedActive) {
    const validActiveParentId = resolveRootId(requestedActive.id)
    if (validActiveParentId) {
      if (!validRequestedParent || validRequestedParent === validActiveParentId) {
        return { parentSessionId: validActiveParentId, activeSessionId: requestedActive.id }
      }
    }
  }

  if (validRequestedParent) {
    return { parentSessionId: validRequestedParent, activeSessionId: validRequestedParent }
  }
  return null
}

function areRestoredSessionReferencesAvailable(
  availableSessions: readonly SessionDescriptor[],
  references: RestoredSessionReferences,
  allowedNonSessionIds: readonly string[] = [],
): boolean {
  return getUnavailableRestoredSessionIds(availableSessions, references, allowedNonSessionIds).size === 0
}

function getUnavailableRestoredSessionIds(
  availableSessions: readonly SessionDescriptor[],
  references: RestoredSessionReferences,
  allowedNonSessionIds: readonly string[] = [],
): Set<string> {
  const availableIds = new Set(availableSessions.map((session) => session.id))
  const allowedIds = new Set(allowedNonSessionIds)
  const requiredIds = [
    references.activeParentSessionId,
    references.activeSessionId === "info" ? undefined : references.activeSessionId,
    ...references.draftSessionIds,
    ...(references.attachmentSessionIds ?? []),
    ...references.scrollSessionIds,
  ]
  return new Set(
    requiredIds.filter((sessionId): sessionId is string =>
      Boolean(sessionId) && !availableIds.has(sessionId!) && !allowedIds.has(sessionId!),
    ),
  )
}

function resolveRestoredActiveTabId(
  restoredTabIds: readonly (string | null | undefined)[],
  requestedActiveTabIndex: number,
): string | null {
  if (Number.isInteger(requestedActiveTabIndex) && requestedActiveTabIndex >= 0) {
    const requested = restoredTabIds[requestedActiveTabIndex]
    if (requested) return requested
  }
  return restoredTabIds.find((tabId): tabId is string => Boolean(tabId)) ?? null
}

function shouldRestoreSessionState(
  isPrimary: boolean,
  restoreEnabled: boolean,
  snapshot: unknown,
): boolean {
  return isPrimary && restoreEnabled && Boolean(snapshot)
}

function shouldEnableSessionCapture(
  _snapshotExisted: boolean,
  _restoreCompleted: boolean,
): boolean {
  return true
}

export {
  areRestoredSessionReferencesAvailable,
  getUnavailableRestoredSessionIds,
  normalizeWorkspacePath,
  reconcileWorkspaceTabs,
  resolveRestoredActiveTabId,
  resolveRestoredSessionSelection,
  shouldEnableSessionCapture,
  shouldRestoreSessionState,
}
