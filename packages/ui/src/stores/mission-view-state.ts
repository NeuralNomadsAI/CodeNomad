import { createSignal } from "solid-js"
import { readClientLayoutValue, writeClientLayoutValue, removeClientLayoutValue } from "./client-state"

export interface MissionReaderTarget {
  missionId: string
  kind: "overview" | "task" | "report" | "change"
  itemId?: string
}
interface ProjectView { selected?: string; reader?: MissionReaderTarget }
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
      const r = stored.reader
      if (r && typeof r.missionId === "string" && ["overview", "task", "report", "change"].includes(r.kind)
        && (r.itemId === undefined || typeof r.itemId === "string")) value.reader = r
    } catch { /* Ignore malformed saved layout. */ }
    projects.set(storageKey, value)
  }
  return projects.get(storageKey)!
}
export function updateMissionProjectView(scope: string, patch: Partial<ProjectView>): void {
  const previous = missionProjectView(scope)
  const value = { ...previous, ...patch }
  if (previous.selected === value.selected && previous.reader === value.reader) return
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
