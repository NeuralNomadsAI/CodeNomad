import type {
  RestorableSessionState,
  RestorableTabState,
  RestorableWorkspaceTabState,
} from "./client-state-codec"
import { normalizeWorkspacePath } from "./app-session-reconciliation"

export type PreservedTabState =
  | { mode: "whole"; tab: RestorableTabState }
  | { mode: "workspace-state"; tab: RestorableWorkspaceTabState }

export interface RestorableSessionPreservation {
  sourceTabs: readonly RestorableTabState[]
  preservedTabs: readonly (PreservedTabState | null)[]
  restoredTabIds: readonly (string | null)[]
  restoredWorkspaceSourceIndexes: ReadonlyMap<string, number>
  removedWholeTabIndexes: ReadonlySet<number>
}

export interface RestorableWorkspaceRuntimeAuthority {
  drafts?: ReadonlySet<string>
  attachments?: ReadonlySet<string>
  scrollSnapshots?: ReadonlySet<string>
  idleMarkers?: ReadonlySet<string>
  generationRecovery?: ReadonlySet<string>
  sessionStatuses?: ReadonlySet<string>
  sessionExpansion?: ReadonlySet<string>
  deletedSessions?: ReadonlySet<string>
  sessionSelection?: boolean
}

export interface RestoredWorkspaceMapping {
  sourceIndex: number
  runtimeTabId: string
}

export function createRestorableSessionPreservation(
  snapshot: RestorableSessionState,
): RestorableSessionPreservation {
  return {
    sourceTabs: snapshot.tabs,
    preservedTabs: snapshot.tabs.map((tab) => ({ mode: "whole", tab })),
    restoredTabIds: snapshot.tabs.map(() => null),
    restoredWorkspaceSourceIndexes: new Map(),
    removedWholeTabIndexes: new Set(),
  }
}

export function mapRestoredWorkspace(
  preservation: RestorableSessionPreservation,
  sourceIndex: number,
  runtimeTabId: string,
): RestorableSessionPreservation {
  return mapRestoredWorkspaces(preservation, [{ sourceIndex, runtimeTabId }])
}

export function mapRestoredWorkspaces(
  preservation: RestorableSessionPreservation,
  mappings: readonly RestoredWorkspaceMapping[],
): RestorableSessionPreservation {
  const restoredWorkspaceSourceIndexes = new Map(preservation.restoredWorkspaceSourceIndexes)
  let changed = false
  for (const { sourceIndex, runtimeTabId } of mappings) {
    if (!runtimeTabId || preservation.sourceTabs[sourceIndex]?.kind !== "workspace") continue
    for (const [mappedRuntimeTabId, mappedSourceIndex] of restoredWorkspaceSourceIndexes) {
      if (mappedRuntimeTabId === runtimeTabId || mappedSourceIndex === sourceIndex) {
        restoredWorkspaceSourceIndexes.delete(mappedRuntimeTabId)
      }
    }
    restoredWorkspaceSourceIndexes.set(runtimeTabId, sourceIndex)
    changed = true
  }
  return changed ? { ...preservation, restoredWorkspaceSourceIndexes } : preservation
}

export function unmapRestoredWorkspace(
  preservation: RestorableSessionPreservation,
  runtimeTabId: string,
): RestorableSessionPreservation {
  const restoredTabIndex = preservation.restoredTabIds.findIndex((tabId) => tabId === runtimeTabId)
  if (!preservation.restoredWorkspaceSourceIndexes.has(runtimeTabId) && restoredTabIndex < 0) return preservation
  const restoredWorkspaceSourceIndexes = new Map(preservation.restoredWorkspaceSourceIndexes)
  restoredWorkspaceSourceIndexes.delete(runtimeTabId)
  const restoredTabIds = [...preservation.restoredTabIds]
  if (restoredTabIndex >= 0) restoredTabIds[restoredTabIndex] = null
  return { ...preservation, restoredTabIds, restoredWorkspaceSourceIndexes }
}

function findWorkspaceSourceIndex(
  preservation: RestorableSessionPreservation,
  workspace: { runtimeTabId: string; folder: string; occurrence: number },
): number | undefined {
  const mappedSourceIndex = preservation.restoredWorkspaceSourceIndexes.get(workspace.runtimeTabId)
  if (mappedSourceIndex !== undefined) return mappedSourceIndex

  const runtimeIndex = preservation.restoredTabIds.findIndex((tabId) => tabId === workspace.runtimeTabId)
  if (runtimeIndex >= 0) return runtimeIndex

  const sourceOccurrences = resolveWorkspaceOccurrences(preservation.sourceTabs)
  const folder = normalizeWorkspacePath(workspace.folder)
  const identityIndex = preservation.sourceTabs.findIndex((tab, index) =>
    tab.kind === "workspace"
      && normalizeWorkspacePath(tab.folder) === folder
      && sourceOccurrences[index] === workspace.occurrence,
  )
  return identityIndex >= 0 ? identityIndex : undefined
}

export function markPreservedWorkspaceRemoved(
  preservation: RestorableSessionPreservation,
  workspace: { runtimeTabId: string; folder: string; occurrence: number },
): RestorableSessionPreservation {
  const sourceIndex = findWorkspaceSourceIndex(preservation, workspace)
  const nextPreservation = unmapRestoredWorkspace(preservation, workspace.runtimeTabId)
  if (sourceIndex === undefined || nextPreservation.preservedTabs[sourceIndex]?.mode !== "whole") {
    return nextPreservation
  }
  const removedWholeTabIndexes = new Set(nextPreservation.removedWholeTabIndexes)
  removedWholeTabIndexes.add(sourceIndex)
  return { ...nextPreservation, removedWholeTabIndexes }
}

export function markPreservedWorkspaceReopened(
  preservation: RestorableSessionPreservation,
  workspace: { runtimeTabId: string; folder: string; occurrence: number },
): RestorableSessionPreservation {
  const sourceIndex = findWorkspaceSourceIndex(preservation, workspace)
  const nextPreservation = unmapRestoredWorkspace(preservation, workspace.runtimeTabId)
  if (sourceIndex === undefined || !nextPreservation.removedWholeTabIndexes.has(sourceIndex)) {
    return nextPreservation
  }
  const removedWholeTabIndexes = new Set(nextPreservation.removedWholeTabIndexes)
  removedWholeTabIndexes.delete(sourceIndex)
  return { ...nextPreservation, removedWholeTabIndexes }
}

export function markRestoredTab(
  preservation: RestorableSessionPreservation,
  tabIndex: number,
  unavailableSessionIds: ReadonlySet<string> = new Set(),
  restoredTabId: string | null = null,
): RestorableSessionPreservation {
  const source = preservation.sourceTabs[tabIndex]
  if (!source) return preservation

  let nextEntry: PreservedTabState | null = null
  if (source.kind === "workspace" && unavailableSessionIds.size > 0) {
    const drafts = Object.fromEntries(
      Object.entries(source.drafts).filter(([sessionId]) => unavailableSessionIds.has(sessionId)),
    )
    const attachments = Object.fromEntries(
      Object.entries(source.attachments).filter(([sessionId]) => unavailableSessionIds.has(sessionId)),
    )
    const scrollSnapshots = Object.fromEntries(
      Object.entries(source.scrollSnapshots).filter(([sessionId]) => unavailableSessionIds.has(sessionId)),
    )
    const unseenIdleSince = Object.fromEntries(
      Object.entries(source.unseenIdleSince).filter(([sessionId]) => unavailableSessionIds.has(sessionId)),
    )
    const generationRecovery = Object.fromEntries(
      Object.entries(source.generationRecovery).filter(([sessionId]) => unavailableSessionIds.has(sessionId)),
    )
    const sessionStatuses = Object.fromEntries(
      Object.entries(source.sessionStatuses).filter(([sessionId]) => unavailableSessionIds.has(sessionId)),
    )
    const expandedSessionIds = source.expandedSessionIds.filter((sessionId) => unavailableSessionIds.has(sessionId))
    const tab: RestorableWorkspaceTabState = {
      kind: "workspace",
      folder: source.folder,
      drafts,
      attachments,
      scrollSnapshots,
      unseenIdleSince,
      generationRecovery,
      sessionStatuses,
      expandedSessionIds,
    }
    if (source.occurrence !== undefined) tab.occurrence = source.occurrence
    if (unavailableSessionIds.has(source.activeParentSessionId ?? "")) {
      tab.activeParentSessionId = source.activeParentSessionId
    }
    if (unavailableSessionIds.has(source.activeSessionId ?? "")) {
      tab.activeSessionId = source.activeSessionId
    }
    nextEntry = { mode: "workspace-state", tab }
  }

  const preservedTabs = [...preservation.preservedTabs]
  const restoredTabIds = [...preservation.restoredTabIds]
  preservedTabs[tabIndex] = nextEntry
  restoredTabIds[tabIndex] = restoredTabId
  const nextPreservation = { ...preservation, preservedTabs, restoredTabIds }
  return source.kind === "workspace" && restoredTabId
    ? mapRestoredWorkspace(nextPreservation, tabIndex, restoredTabId)
    : nextPreservation
}

function resolveWorkspaceOccurrences(tabs: readonly RestorableTabState[]): Array<number | undefined> {
  const workspaceOccurrences = new Map<string, number>()
  return tabs.map((tab) => {
    if (tab.kind !== "workspace") return undefined

    const path = normalizeWorkspacePath(tab.folder)
    const inferredOccurrence = workspaceOccurrences.get(path) ?? 0
    const occurrence = tab.occurrence ?? inferredOccurrence
    workspaceOccurrences.set(path, Math.max(inferredOccurrence, occurrence) + 1)
    return occurrence
  })
}

function buildTabIdentities(
  tabs: readonly RestorableTabState[],
  workspaceOccurrences: readonly (number | undefined)[],
): string[] {
  const sidecarOccurrences = new Map<string, number>()
  return tabs.map((tab, index) => {
    if (tab.kind === "sidecar") {
      const occurrence = sidecarOccurrences.get(tab.sidecarId) ?? 0
      sidecarOccurrences.set(tab.sidecarId, occurrence + 1)
      return `sidecar:${tab.sidecarId}:${occurrence}`
    }

    const path = normalizeWorkspacePath(tab.folder)
    return `workspace:${path}:${workspaceOccurrences[index]}`
  })
}

function mergeWorkspaceState(
  current: RestorableWorkspaceTabState,
  preserved: RestorableWorkspaceTabState,
  authority: RestorableWorkspaceRuntimeAuthority = {},
): RestorableWorkspaceTabState {
  const mergeRecords = <T>(
    currentRecord: Record<string, T>,
    preservedRecord: Record<string, T>,
    authoritativeIds: ReadonlySet<string> | undefined,
  ): Record<string, T> => {
    const fallback = { ...preservedRecord }
    for (const sessionId of authoritativeIds ?? []) delete fallback[sessionId]
    for (const sessionId of authority.deletedSessions ?? []) delete fallback[sessionId]
    return { ...fallback, ...currentRecord }
  }
  const result: RestorableWorkspaceTabState = {
    ...current,
    drafts: mergeRecords(current.drafts, preserved.drafts, authority.drafts),
    attachments: mergeRecords(current.attachments, preserved.attachments, authority.attachments),
    scrollSnapshots: mergeRecords(current.scrollSnapshots, preserved.scrollSnapshots, authority.scrollSnapshots),
    unseenIdleSince: mergeRecords(current.unseenIdleSince, preserved.unseenIdleSince, authority.idleMarkers),
    generationRecovery: mergeRecords(
      current.generationRecovery,
      preserved.generationRecovery,
      authority.generationRecovery,
    ),
    sessionStatuses: mergeRecords(current.sessionStatuses, preserved.sessionStatuses, authority.sessionStatuses),
    expandedSessionIds: [
      ...new Set([
        ...current.expandedSessionIds,
        ...preserved.expandedSessionIds.filter((sessionId) => !authority.sessionExpansion?.has(sessionId)),
      ].filter((sessionId) => !authority.deletedSessions?.has(sessionId))),
    ],
  }
  if (!authority.sessionSelection && !current.activeParentSessionId && !current.activeSessionId) {
    if (preserved.activeParentSessionId && !authority.deletedSessions?.has(preserved.activeParentSessionId)) {
      result.activeParentSessionId = preserved.activeParentSessionId
    }
    if (preserved.activeSessionId && !authority.deletedSessions?.has(preserved.activeSessionId)) {
      result.activeSessionId = preserved.activeSessionId
    }
  }
  return result
}

export function mergeRestorableSessionState(
  current: RestorableSessionState,
  preservation: RestorableSessionPreservation | null,
  options: {
    currentTabIds?: readonly string[]
    currentTabAuthorities?: readonly (RestorableWorkspaceRuntimeAuthority | undefined)[]
  } = {},
): RestorableSessionState {
  if (!preservation) return current

  const currentWorkspaceOccurrences = resolveWorkspaceOccurrences(current.tabs)
  const sourceWorkspaceOccurrences = resolveWorkspaceOccurrences(preservation.sourceTabs)
  const currentIdentities = buildTabIdentities(current.tabs, currentWorkspaceOccurrences)
  const sourceIdentities = buildTabIdentities(preservation.sourceTabs, sourceWorkspaceOccurrences)
  const currentIndexesByIdentity = new Map<string, number[]>()
  currentIdentities.forEach((identity, index) => {
    const indexes = currentIndexesByIdentity.get(identity) ?? []
    indexes.push(index)
    currentIndexesByIdentity.set(identity, indexes)
  })

  const currentIndexByRuntimeId = new Map(
    (options.currentTabIds ?? []).map((tabId, index) => [tabId, index]),
  )
  const sourceCurrentIndexes: Array<number | undefined> = preservation.sourceTabs.map(() => undefined)
  const claimedCurrentIndexes = new Set<number>()
  preservation.restoredTabIds.forEach((tabId, sourceIndex) => {
    const currentIndex = tabId ? currentIndexByRuntimeId.get(tabId) : undefined
    if (currentIndex === undefined || !current.tabs[currentIndex] || claimedCurrentIndexes.has(currentIndex)) return
    sourceCurrentIndexes[sourceIndex] = currentIndex
    claimedCurrentIndexes.add(currentIndex)
  })
  preservation.restoredWorkspaceSourceIndexes.forEach((sourceIndex, runtimeTabId) => {
    const currentIndex = currentIndexByRuntimeId.get(runtimeTabId)
    if (currentIndex === undefined || !current.tabs[currentIndex] || claimedCurrentIndexes.has(currentIndex)) return
    sourceCurrentIndexes[sourceIndex] = currentIndex
    claimedCurrentIndexes.add(currentIndex)
  })

  preservation.sourceTabs.forEach((_sourceTab, sourceIndex) => {
    if (sourceCurrentIndexes[sourceIndex] !== undefined) return
    const preserved = preservation.removedWholeTabIndexes.has(sourceIndex)
      ? null
      : preservation.preservedTabs[sourceIndex]
    const canMatchByIdentity = preserved?.mode === "whole" || options.currentTabIds === undefined
    if (!canMatchByIdentity) return

    const identityMatches = currentIndexesByIdentity.get(sourceIdentities[sourceIndex] ?? "")
    while (identityMatches?.length) {
      const candidate = identityMatches.shift()!
      if (claimedCurrentIndexes.has(candidate)) continue
      sourceCurrentIndexes[sourceIndex] = candidate
      claimedCurrentIndexes.add(candidate)
      break
    }
  })

  const currentTabs = [...current.tabs]
  preservation.sourceTabs.forEach((_sourceTab, sourceIndex) => {
    const currentIndex = sourceCurrentIndexes[sourceIndex]
    const preserved = preservation.removedWholeTabIndexes.has(sourceIndex)
      ? null
      : preservation.preservedTabs[sourceIndex]
    if (currentIndex === undefined || !preserved) return

    const currentTab = currentTabs[currentIndex]
    if (currentTab?.kind !== "workspace") return
    const authority = options.currentTabAuthorities?.[currentIndex]
    if (preserved.mode === "workspace-state") {
      currentTabs[currentIndex] = mergeWorkspaceState(currentTab, preserved.tab, authority)
    } else if (preserved.tab.kind === "workspace") {
      currentTabs[currentIndex] = mergeWorkspaceState(currentTab, preserved.tab, authority)
    }
  })

  const insertionsByCurrentSlot = new Map<number, RestorableTabState[]>()
  const usedWorkspaceOccurrences = new Map<string, Set<number>>()
  currentTabs.forEach((tab, index) => {
    if (tab.kind !== "workspace") return
    const path = normalizeWorkspacePath(tab.folder)
    const used = usedWorkspaceOccurrences.get(path) ?? new Set<number>()
    used.add(currentWorkspaceOccurrences[index]!)
    usedWorkspaceOccurrences.set(path, used)
  })
  preservation.sourceTabs.forEach((sourceTab, sourceIndex) => {
    const preserved = preservation.removedWholeTabIndexes.has(sourceIndex)
      ? null
      : preservation.preservedTabs[sourceIndex]
    if (sourceCurrentIndexes[sourceIndex] !== undefined || preserved?.mode !== "whole") return

    let nearestMappedSourceIndex: number | undefined
    for (let distance = 1; distance < preservation.sourceTabs.length; distance += 1) {
      const previousSourceIndex = sourceIndex - distance
      if (previousSourceIndex >= 0 && sourceCurrentIndexes[previousSourceIndex] !== undefined) {
        nearestMappedSourceIndex = previousSourceIndex
        break
      }
      const nextSourceIndex = sourceIndex + distance
      if (nextSourceIndex < preservation.sourceTabs.length && sourceCurrentIndexes[nextSourceIndex] !== undefined) {
        nearestMappedSourceIndex = nextSourceIndex
        break
      }
    }

    const nearestCurrentIndex = nearestMappedSourceIndex === undefined
      ? undefined
      : sourceCurrentIndexes[nearestMappedSourceIndex]
    const slot = nearestCurrentIndex === undefined
      ? currentTabs.length
      : nearestCurrentIndex + (nearestMappedSourceIndex! < sourceIndex ? 1 : 0)
    const insertions = insertionsByCurrentSlot.get(slot) ?? []
    let tab = sourceTab
    if (sourceTab.kind === "workspace") {
      const path = normalizeWorkspacePath(sourceTab.folder)
      const used = usedWorkspaceOccurrences.get(path) ?? new Set<number>()
      let occurrence = sourceWorkspaceOccurrences[sourceIndex] ?? 0
      if (used.has(occurrence)) {
        occurrence = 0
        while (used.has(occurrence)) occurrence += 1
      }
      used.add(occurrence)
      usedWorkspaceOccurrences.set(path, used)
      tab = { ...sourceTab, occurrence }
    }
    insertions.push(tab)
    insertionsByCurrentSlot.set(slot, insertions)
  })

  const currentOutputIndexes = new Map<number, number>()
  const tabs: RestorableTabState[] = []

  for (let slot = 0; slot <= currentTabs.length; slot += 1) {
    for (const insertion of insertionsByCurrentSlot.get(slot) ?? []) {
      tabs.push(insertion)
    }
    const currentTab = currentTabs[slot]
    if (!currentTab) continue
    currentOutputIndexes.set(slot, tabs.length)
    tabs.push(currentTab)
  }

  const currentActiveIndex = currentOutputIndexes.get(current.activeTabIndex)
  const activeTabIndex = currentActiveIndex ?? (tabs.length > 0 ? 0 : -1)
  return { tabs, activeTabIndex }
}
