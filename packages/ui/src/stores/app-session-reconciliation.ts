import { backendIdOf, backendScoped, LOCAL_BACKEND_ID } from "../lib/backend-identity"
import type { BackendId } from "../lib/backend-transport"
import { normalizeWorkspacePath } from "../../../server/src/workspaces/workspace-path-key"

export { normalizeWorkspacePath }

export type ReconcileTabDescriptor = { kind: string; folderPath?: string; occurrence?: number; backendId?: BackendId; workspaceId?: string; serverId?: string }
type LiveWorkspaceDescriptor = { id: string; folderPath: string; status?: string; backendId?: BackendId; serverId?: string }
export function matchesRestoredServer(tab: { backendId?: BackendId; serverId?: string }, serverId?: string): boolean {
  return backendIdOf(tab) === LOCAL_BACKEND_ID || !!tab.serverId && tab.serverId === serverId
}

export function mayCreateRestoredWorkspace(remote: boolean, web: boolean, explicitlyOpened: boolean): boolean {
  return explicitlyOpened || (!remote && !web)
}
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
/** One project of one backend: the normalized folder, prefixed by the backend id unless local. */
export function workspaceIdentity(folderPath: string, backendId?: BackendId): string {
  return backendScoped(backendId, normalizeWorkspacePath(folderPath))
}
export function workspaceInstallationKey(folder: string, backendId?: BackendId, serverId?: string): string {
  return JSON.stringify([workspaceIdentity(folder, backendId), serverId])
}
export function getUnavailableWorkspaceIds(
  localIds: Iterable<string>,
  remoteIds: ReadonlySet<string>,
  isProtected: (id: string) => boolean,
): string[] {
  return [...localIds].filter((id) => !remoteIds.has(id) && !isProtected(id))
}

/** One record per folder reaches the instance store: the record already
 * instantiated, else the first (oldest) the backend reports. Duplicate records
 * of a folder stay inert until the backend closes them. */
export function uniqueFolderWorkspaces<T extends { id: string; path: string }>(
  workspaces: readonly T[],
  hasInstance: (id: string) => boolean,
): T[] {
  const groups = new Map<string, T[]>()
  for (const workspace of workspaces) {
    const key = normalizeWorkspacePath(workspace.path)
    groups.set(key, [...(groups.get(key) ?? []), workspace])
  }
  const keep = new Set<string>()
  for (const group of groups.values()) {
    keep.add((group.find((workspace) => hasInstance(workspace.id)) ?? group[0]!).id)
  }
  return workspaces.filter((workspace) => keep.has(workspace.id))
}

/** Local instances of duplicate folder records that hold no tab; the tab-bound
 * (or first) instance of each folder stays. */
export function redundantDuplicateFolderInstances(
  instances: Iterable<{ id: string; folder: string }>,
  hasTab: (id: string) => boolean,
): string[] {
  const groups = new Map<string, Array<{ id: string; hasTab: boolean }>>()
  for (const instance of instances) {
    const key = normalizeWorkspacePath(instance.folder)
    groups.set(key, [...(groups.get(key) ?? []), { id: instance.id, hasTab: hasTab(instance.id) }])
  }
  const redundant: string[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const keep = group.find((instance) => instance.hasTab) ?? group[0]!
    for (const instance of group) {
      if (instance.id !== keep.id && !instance.hasTab) redundant.push(instance.id)
    }
  }
  return redundant
}
export function reconcileWorkspaceTabs(
  tabs: readonly ReconcileTabDescriptor[],
  liveWorkspaces: readonly LiveWorkspaceDescriptor[],
) {
  const liveByPath = new Map<string, LiveWorkspaceDescriptor[]>()
  for (const workspace of liveWorkspaces) {
    if (workspace.status === "stopped" || workspace.status === "error") continue
    const path = workspaceInstallationKey(workspace.folderPath, workspace.backendId, workspace.serverId)
    liveByPath.set(path, [...(liveByPath.get(path) ?? []), workspace])
  }
  const nextOccurrences = new Map<string, number>()
  // A saved record that still exists for the same folder wins: occurrences shift
  // when another client closes a sibling record of that folder.
  const byId = new Map<number, string>()
  for (const [tabIndex, tab] of tabs.entries()) {
    if (tab.kind !== "workspace" || typeof tab.folderPath !== "string" || !tab.workspaceId) continue
    const path = workspaceInstallationKey(tab.folderPath, tab.backendId, tab.serverId)
    if (liveByPath.get(path)?.some(workspace => workspace.id === tab.workspaceId && matchesRestoredServer(tab, workspace.serverId))
      && ![...byId.values()].includes(tab.workspaceId)) {
      byId.set(tabIndex, tab.workspaceId)
    }
  }
  const claimed = new Set<string>(byId.values())
  return tabs.flatMap((tab, tabIndex) => {
    if (tab.kind !== "workspace" || typeof tab.folderPath !== "string") return []
    const path = workspaceInstallationKey(tab.folderPath, tab.backendId, tab.serverId)
    const inferred = nextOccurrences.get(path) ?? 0
    const occurrence = Number.isInteger(tab.occurrence) && Number(tab.occurrence) >= 0 ? Number(tab.occurrence) : inferred
    nextOccurrences.set(path, Math.max(inferred, occurrence) + 1)
    const savedId = byId.get(tabIndex)
    if (savedId) return [{ tabIndex, descriptor: { kind: "workspace" as const, folderPath: tab.folderPath, occurrence, ...(tab.backendId ? { backendId: tab.backendId } : {}) }, existingWorkspaceId: savedId }]
    const workspace = liveByPath.get(path)?.[occurrence]
    const existingWorkspaceId = workspace && matchesRestoredServer(tab, workspace.serverId) && !claimed.has(workspace.id) ? workspace.id : null
    if (existingWorkspaceId) claimed.add(existingWorkspaceId)
    return [{
      tabIndex,
      descriptor: { kind: "workspace" as const, folderPath: tab.folderPath, occurrence, ...(tab.backendId ? { backendId: tab.backendId } : {}) },
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
