import type {
  RestorableSessionState,
  RestorableTabState,
  RestorableWorkspaceTabState,
} from "./client-state-codec"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
export interface RestoreTabResult {
  status: "pending" | "restored" | "removed"
  runtimeTabId?: string | null
  unavailableSessionIds?: ReadonlySet<string>
}
export interface RestorableSessionPreservation {
  sourceTabs: readonly RestorableTabState[]
  results: RestoreTabResult[]
}
export interface RestorableWorkspaceRuntimeAuthority {
  drafts?: ReadonlySet<string>
  attachments?: ReadonlySet<string>
  scrollSnapshots?: ReadonlySet<string>
  idleMarkers?: ReadonlySet<string>
  generationRecovery?: ReadonlySet<string>
  deletedSessions?: ReadonlySet<string>
  sessionSelection?: boolean
}
interface TabIdentity {
  key: string
  occurrence: number
  value: string
}
function mapTabIdentities(tabs: readonly RestorableTabState[]): TabIdentity[] {
  const nextOccurrences = new Map<string, number>()
  return tabs.map((tab) => {
    const key = tab.kind === "workspace"
      ? `workspace:${normalizeWorkspacePath(tab.folder)}`
      : `sidecar:${tab.sidecarId}`
    const inferred = nextOccurrences.get(key) ?? 0
    const occurrence = tab.kind === "workspace" ? tab.occurrence ?? inferred : inferred
    nextOccurrences.set(key, Math.max(inferred, occurrence) + 1)
    return { key, occurrence, value: `${key}:${occurrence}` }
  })
}
export function createRestorableSessionPreservation(
  snapshot: RestorableSessionState,
): RestorableSessionPreservation {
  return { sourceTabs: snapshot.tabs, results: snapshot.tabs.map(() => ({ status: "pending" })) }
}
export function recordRestoredTab(
  preservation: RestorableSessionPreservation,
  sourceIndex: number,
  runtimeTabId: string | null,
  unavailableSessionIds?: ReadonlySet<string>,
): void {
  if (!preservation.sourceTabs[sourceIndex]) return
  preservation.results[sourceIndex] = unavailableSessionIds
    ? { status: "restored", runtimeTabId, unavailableSessionIds }
    : { status: "pending", ...(runtimeTabId ? { runtimeTabId } : {}) }
}
function findWorkspaceSourceIndex(
  preservation: RestorableSessionPreservation,
  workspace: { runtimeTabId: string; folder: string; occurrence: number },
): number | undefined {
  const runtimeIndex = preservation.results.findIndex((result) => result.runtimeTabId === workspace.runtimeTabId)
  if (runtimeIndex >= 0) return runtimeIndex
  const identity = `workspace:${normalizeWorkspacePath(workspace.folder)}:${workspace.occurrence}`
  const index = mapTabIdentities(preservation.sourceTabs).findIndex((candidate) => candidate.value === identity)
  return index >= 0 ? index : undefined
}
export function markPreservedWorkspaceRemoved(
  preservation: RestorableSessionPreservation,
  workspace: { runtimeTabId: string; folder: string; occurrence: number },
): RestorableSessionPreservation {
  const index = findWorkspaceSourceIndex(preservation, workspace)
  if (index !== undefined && preservation.results[index]?.status === "pending") {
    preservation.results[index] = { status: "removed" }
  }
  return preservation
}
export function markPreservedWorkspaceReopened(
  preservation: RestorableSessionPreservation,
  workspace: { runtimeTabId: string; folder: string; occurrence: number },
): RestorableSessionPreservation {
  const index = findWorkspaceSourceIndex(preservation, workspace)
  if (index === undefined) return preservation
  const result = preservation.results[index]
  preservation.results[index] = result?.status === "removed"
    ? { status: "pending" }
    : { ...result, status: "pending", runtimeTabId: null }
  return preservation
}
function getPreservedTab(source: RestorableTabState, result: RestoreTabResult): RestorableTabState | null {
  const unavailable = result.unavailableSessionIds
  if (result.status === "pending" && !unavailable) return source
  if ((result.status !== "restored" && result.status !== "pending") || source.kind !== "workspace" || !unavailable?.size) return null
  const keep = <T>(record: Record<string, T>) => Object.fromEntries(
    Object.entries(record).filter(([id]) => unavailable.has(id)),
  )
  const tab: RestorableWorkspaceTabState = {
    kind: "workspace",
    folder: source.folder,
    drafts: keep(source.drafts),
    attachments: keep(source.attachments),
    scrollSnapshots: keep(source.scrollSnapshots),
    unseenIdleSince: keep(source.unseenIdleSince),
    generationRecovery: keep(source.generationRecovery),
  }
  if (source.occurrence !== undefined) tab.occurrence = source.occurrence
  if (source.activeParentSessionId && unavailable.has(source.activeParentSessionId)) {
    tab.activeParentSessionId = source.activeParentSessionId
  }
  if (source.activeSessionId && unavailable.has(source.activeSessionId)) tab.activeSessionId = source.activeSessionId
  return tab
}
function mergeWorkspaceState(
  current: RestorableWorkspaceTabState,
  preserved: RestorableWorkspaceTabState,
  authority: RestorableWorkspaceRuntimeAuthority = {},
): RestorableWorkspaceTabState {
  const mergeRecords = <T>(currentRecord: Record<string, T>, fallback: Record<string, T>, owned?: ReadonlySet<string>) => {
    const preservedRecord = { ...fallback }
    for (const id of [...(owned ?? []), ...(authority.deletedSessions ?? [])]) delete preservedRecord[id]
    return { ...preservedRecord, ...currentRecord }
  }
  const result: RestorableWorkspaceTabState = {
    ...current,
    drafts: mergeRecords(current.drafts, preserved.drafts, authority.drafts),
    attachments: mergeRecords(current.attachments, preserved.attachments, authority.attachments),
    scrollSnapshots: mergeRecords(current.scrollSnapshots, preserved.scrollSnapshots, authority.scrollSnapshots),
    unseenIdleSince: mergeRecords(current.unseenIdleSince, preserved.unseenIdleSince, authority.idleMarkers),
    generationRecovery: mergeRecords(current.generationRecovery, preserved.generationRecovery, authority.generationRecovery),
  }
  const restoreSelection = !authority.sessionSelection && !current.activeParentSessionId && !current.activeSessionId
  if (restoreSelection && preserved.activeParentSessionId && !authority.deletedSessions?.has(preserved.activeParentSessionId)) {
    result.activeParentSessionId = preserved.activeParentSessionId
  }
  if (restoreSelection && preserved.activeSessionId && !authority.deletedSessions?.has(preserved.activeSessionId)) {
    result.activeSessionId = preserved.activeSessionId
  }
  return result
}
function nearestInsertionSlot(sourceIndex: number, matches: readonly (number | undefined)[], fallback: number): number {
  for (let distance = 1; distance < matches.length; distance += 1) {
    const before = sourceIndex - distance
    const after = sourceIndex + distance
    if (before >= 0 && matches[before] !== undefined) return matches[before]! + 1
    if (after < matches.length && matches[after] !== undefined) return matches[after]!
  }
  return fallback
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
  const currentIdentities = mapTabIdentities(current.tabs)
  const sourceIdentities = mapTabIdentities(preservation.sourceTabs)
  const indexesByIdentity = new Map<string, number[]>()
  currentIdentities.forEach(({ value }, index) => {
    indexesByIdentity.set(value, [...(indexesByIdentity.get(value) ?? []), index])
  })
  const indexesByRuntimeId = new Map((options.currentTabIds ?? []).map((id, index) => [id, index]))
  const matches: Array<number | undefined> = preservation.sourceTabs.map(() => undefined)
  const claimed = new Set<number>()
  const claim = (sourceIndex: number, currentIndex: number | undefined) => {
    if (currentIndex === undefined || !current.tabs[currentIndex] || claimed.has(currentIndex)) return
    matches[sourceIndex] = currentIndex
    claimed.add(currentIndex)
  }
  preservation.results.forEach((result, index) => {
    if (result.runtimeTabId) claim(index, indexesByRuntimeId.get(result.runtimeTabId))
  })
  preservation.results.forEach((result, index) => {
    if (matches[index] !== undefined || (result.status !== "pending" && options.currentTabIds)) return
    claim(index, indexesByIdentity.get(sourceIdentities[index]!.value)?.find((candidate) => !claimed.has(candidate)))
  })
  const currentTabs = [...current.tabs]
  preservation.sourceTabs.forEach((source, index) => {
    const currentIndex = matches[index]
    const target = currentIndex === undefined ? undefined : currentTabs[currentIndex]
    const fallback = getPreservedTab(source, preservation.results[index]!)
    if (target?.kind === "workspace" && fallback?.kind === "workspace") {
      currentTabs[currentIndex!] = mergeWorkspaceState(target, fallback, options.currentTabAuthorities?.[currentIndex!])
    }
  })
  const insertions = new Map<number, RestorableTabState[]>()
  const usedOccurrences = new Map<string, Set<number>>()
  currentIdentities.forEach(({ key, occurrence }) => {
    const used = usedOccurrences.get(key) ?? new Set<number>()
    used.add(occurrence)
    usedOccurrences.set(key, used)
  })
  preservation.sourceTabs.forEach((source, index) => {
    if (matches[index] !== undefined || preservation.results[index]?.status !== "pending") return
    const slot = nearestInsertionSlot(index, matches, currentTabs.length)
    let tab = source
    if (source.kind === "workspace") {
      const { key, occurrence: sourceOccurrence } = sourceIdentities[index]!
      const used = usedOccurrences.get(key) ?? new Set<number>()
      let occurrence = sourceOccurrence
      while (used.has(occurrence)) occurrence += 1
      used.add(occurrence)
      usedOccurrences.set(key, used)
      tab = { ...source, occurrence }
    }
    insertions.set(slot, [...(insertions.get(slot) ?? []), tab])
  })
  const outputIndexes = new Map<number, number>()
  const tabs: RestorableTabState[] = []
  for (let slot = 0; slot <= currentTabs.length; slot += 1) {
    tabs.push(...(insertions.get(slot) ?? []))
    if (!currentTabs[slot]) continue
    outputIndexes.set(slot, tabs.length)
    tabs.push(currentTabs[slot]!)
  }
  return {
    tabs,
    activeTabIndex: outputIndexes.get(current.activeTabIndex) ?? (tabs.length ? 0 : -1),
  }
}
