import { createSignal } from "solid-js"
import { readClientLayoutValue, writeClientLayoutValue, removeClientLayoutValue } from "./client-state"

export interface MissionReaderTarget {
  missionId: string
  kind: "overview" | "task" | "report" | "change" | "recurrence"
  itemId?: string
  /** Exact isolated passage scope; never a native session selector. */
  recurrence?: { instanceId: string; projectID: string; scheduleID: string; passageID: string }
  /** Recurrence readers do not inherit a selected one-shot Mission's authority. */
  instanceId?: string
  projectID?: string
}
/** `listExpanded`: the picker's inline list, opened and closed only by its chevron.
 * `tasksCollapsed`: the selected Mission's task tree, expanded unless collapsed. */
interface ProjectView { selected?: string; selectedRecurrence?: string; reader?: MissionReaderTarget; listExpanded?: boolean; tasksCollapsed?: boolean }
const [version, setVersion] = createSignal(0)
const projects = new Map<string, ProjectView>()
const disclosures = new Map<string, Map<string, boolean>>()

// Compact stable keys keep a full mission (96 tasks + reports) within the native
// layout entry budget. Store identities/preferences only, never report contents.
function key(value: string): string {
  let a = 2166136261, b = 5381
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619)
    b = Math.imul(b, 33) ^ value.charCodeAt(i)
  }
  return btoa(String.fromCharCode(a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255,
    b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
function projectKey(scope: string) { return `mission-project-${key(scope)}` }
function missionKey(id: string) { return `mission-disclosures-${key(id)}` }

export function missionProjectView(scope: string): ProjectView {
  version()
  const storageKey = projectKey(scope)
  if (!projects.has(storageKey)) {
    let value: ProjectView = {}
    try {
      const stored = JSON.parse(readClientLayoutValue(storageKey) ?? "{}")
      if (typeof stored.selected === "string") value.selected = stored.selected
      if (typeof stored.selectedRecurrence === "string") value.selectedRecurrence = stored.selectedRecurrence
      if (stored.listExpanded === true) value.listExpanded = true
      if (stored.tasksCollapsed === true) value.tasksCollapsed = true
      const r = stored.reader
      if (r && typeof r.missionId === "string" && ["overview", "task", "report", "change", "recurrence"].includes(r.kind)
        && (r.itemId === undefined || typeof r.itemId === "string")
        && (r.recurrence === undefined || ["instanceId", "projectID", "scheduleID", "passageID"].every(key => typeof r.recurrence?.[key] === "string"))
        && (r.kind !== "recurrence" || typeof r.instanceId === "string" && typeof r.projectID === "string")) value.reader = r
    } catch { /* Ignore malformed saved layout. */ }
    projects.set(storageKey, value)
  }
  return projects.get(storageKey)!
}
export function updateMissionProjectView(scope: string, patch: Partial<ProjectView>): void {
  const previous = missionProjectView(scope)
  const value = { ...previous, ...patch }
  if (previous.selected === value.selected && previous.selectedRecurrence === value.selectedRecurrence && previous.reader === value.reader
    && previous.listExpanded === value.listExpanded && previous.tasksCollapsed === value.tasksCollapsed) return
  projects.set(projectKey(scope), value)
  writeClientLayoutValue(projectKey(scope), JSON.stringify(value))
  setVersion(v => v + 1)
}
function disclosureState(missionId: string): Map<string, boolean> {
  version()
  const storageKey = missionKey(missionId)
  if (!disclosures.has(storageKey)) {
    const entries = (readClientLayoutValue(storageKey) ?? "").split(",")
      .filter(value => /^[+-][a-zA-Z0-9_-]{11}$/.test(value))
      .map(value => [value.slice(1), value[0] === "+"] as const)
    disclosures.set(storageKey, new Map(entries))
  }
  return disclosures.get(storageKey)!
}
export function missionDisclosureOpen(missionId: string, id: string, defaultOpen = true): boolean {
  return disclosureState(missionId).get(key(id)) ?? defaultOpen
}
export function setMissionDisclosureOpen(missionId: string, id: string, open: boolean): void {
  const values = disclosureState(missionId)
  values.set(key(id), open)
  writeClientLayoutValue(missionKey(missionId), [...values].map(([id, open]) => `${open ? "+" : "-"}${id}`).join(","))
  setVersion(v => v + 1)
}

// Completed Missions this window has shown, per project (compact keys), under their
// own key and signal: recording one must not wake readers of the project view.
// Absent until the first list read, which counts the missions already completed as seen.
const [seenVersion, setSeenVersion] = createSignal(0)
const finishedSeen = new Map<string, readonly string[] | undefined>()
function seenKey(scope: string) { return `mission-seen-${key(scope)}` }
function readFinishedSeen(scope: string): readonly string[] | undefined {
  seenVersion()
  const storageKey = seenKey(scope)
  if (!finishedSeen.has(storageKey)) {
    let value: string[] | undefined
    try {
      const stored = JSON.parse(readClientLayoutValue(storageKey) ?? "null")
      if (Array.isArray(stored) && stored.every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id))) value = stored
    } catch { /* Ignore malformed saved layout. */ }
    finishedSeen.set(storageKey, value)
  }
  return finishedSeen.get(storageKey)
}

/** Whether this window has shown the completed Mission; true before the first list read. */
export function missionFinishedSeen(scope: string, missionId: string): boolean {
  const seen = readFinishedSeen(scope)
  return !seen || seen.includes(key(missionId))
}

/** Records completed Missions as seen, keeping only those still listed. The first
 * call (no record yet) also takes every listed completed Mission as seen. */
export function markMissionsFinishedSeen(scope: string, seenIds: readonly string[], completedIds: readonly string[]): void {
  const previous = readFinishedSeen(scope)
  const listed = new Set(completedIds.map(key))
  const next = new Set((previous ?? [...listed]).filter(id => listed.has(id)))
  for (const id of seenIds) if (listed.has(key(id))) next.add(key(id))
  if (previous && previous.length === next.size && previous.every(id => next.has(id))) return
  finishedSeen.set(seenKey(scope), [...next])
  writeClientLayoutValue(seenKey(scope), JSON.stringify([...next]))
  setSeenVersion(value => value + 1)
}

export function forgetMissionView(scope: string, missionId: string): void {
  disclosures.delete(missionKey(missionId))
  removeClientLayoutValue(missionKey(missionId))
  const view = missionProjectView(scope)
  updateMissionProjectView(scope, {
    selected: view.selected === missionId ? undefined : view.selected,
    reader: view.reader?.missionId === missionId ? undefined : view.reader,
  })
  setVersion(v => v + 1)
}
