import { createSignal } from "solid-js"
import { MAX_LAYOUT_VALUE_LENGTH, readClientLayoutValue, writeClientLayoutValue, removeClientLayoutValue } from "./client-state"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"

export interface MissionReaderTarget {
  /** For `playbook`, the playbook id, read without any Mission. */
  missionId: string
  kind: "overview" | "task" | "report" | "change" | "recurrence" | "playbook"
  itemId?: string
  /** `playbook` only: the task-session policy whose coordinator contract is shown. */
  taskMode?: "native" | "independent"
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

// Compact stable keys keep a mission's toggled sections within the native layout
// entry budget. Store identities/preferences only, never report contents.
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
      if (r && typeof r.missionId === "string" && ["overview", "task", "report", "change", "recurrence", "playbook"].includes(r.kind)
        && (r.itemId === undefined || typeof r.itemId === "string")
        && (r.recurrence === undefined || ["instanceId", "projectID", "scheduleID", "passageID"].every(key => typeof r.recurrence?.[key] === "string"))
        && (r.kind !== "recurrence" || typeof r.instanceId === "string" && typeof r.projectID === "string")
        && (r.kind !== "playbook" || Object.prototype.hasOwnProperty.call(missionProfileRoles, r.missionId) && r.recurrence === undefined
          && (r.taskMode === undefined || r.taskMode === "native" || r.taskMode === "independent"))) value.reader = r
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
// "+key," per toggled section within one layout value.
const SAVED_DISCLOSURES = Math.floor((MAX_LAYOUT_VALUE_LENGTH + 1) / 13)
export function setMissionDisclosureOpen(missionId: string, id: string, open: boolean): void {
  const values = disclosureState(missionId)
  // Newest last: this window keeps every toggle, and a mission with more toggled
  // sections than one value holds persists the latest.
  values.delete(key(id))
  values.set(key(id), open)
  writeClientLayoutValue(missionKey(missionId), [...values].slice(-SAVED_DISCLOSURES).map(([id, open]) => `${open ? "+" : "-"}${id}`).join(","))
  setVersion(v => v + 1)
}

// Completed Missions this window has shown, per project (compact keys), under their
// own key and signal: recording one must not wake readers of the project view.
// Absent until the first list read, which counts the missions already completed as seen.
// A watermark on the project's finish numbers (`finishSequence`, durable and growing with
// every finish whatever deletions, reloads and clocks do) covers every completion up to
// the oldest unseen one; the seen ones finished after it are listed. Any number of
// completions fits: only that list takes room, and when it outgrows the layout value the
// watermark rises over the oldest unseen completions, which then count as seen; a shown
// completion never reads as unseen again, and a new finish is always above the watermark.
interface FinishedSeen { watermark: number; seen: ReadonlySet<string> }
export interface MissionCompletion { id: string; finishSequence?: number }
const [seenVersion, setSeenVersion] = createSignal(0)
const finishedSeen = new Map<string, FinishedSeen | undefined>()
function seenKey(scope: string) { return `mission-seen-${key(scope)}` }
// 24-bit ids, concatenated after "<watermark in base 36>:". A collision only shows
// another completion as already seen.
const SEEN_ID_LENGTH = 4
const SEEN_FORMAT = /^([0-9a-z]{1,10}):((?:[a-zA-Z0-9_-]{4})*)$/
const SEEN_ROOM = Math.floor((MAX_LAYOUT_VALUE_LENGTH - 11) / SEEN_ID_LENGTH)
const seenId = (missionId: string) => key(missionId).slice(0, SEEN_ID_LENGTH)
function readFinishedSeen(scope: string): FinishedSeen | undefined {
  seenVersion()
  const storageKey = seenKey(scope)
  if (!finishedSeen.has(storageKey)) {
    const stored = SEEN_FORMAT.exec(readClientLayoutValue(storageKey) ?? "")
    finishedSeen.set(storageKey, stored ? { watermark: parseInt(stored[1], 36), seen: new Set(stored[2].match(/.{4}/g)) } : undefined)
  }
  return finishedSeen.get(storageKey)
}

// A completion without its finish number never asks for attention.
const seenIn = (record: FinishedSeen, completion: MissionCompletion) => completion.finishSequence === undefined
  || completion.finishSequence <= record.watermark || record.seen.has(seenId(completion.id))

/** Whether this window has shown the completed Mission; true before the first list read. */
export function missionFinishedSeen(scope: string, completion: MissionCompletion): boolean {
  const record = readFinishedSeen(scope)
  return !record || seenIn(record, completion)
}

/** Records the shown completed Missions as seen, keeping only those still listed. The
 * first call (no record yet) also takes every listed completed Mission as seen. */
export function markMissionsFinishedSeen(scope: string, shownIds: readonly string[], completed: readonly MissionCompletion[]): void {
  const previous = readFinishedSeen(scope), shown = new Set(shownIds)
  const listed = completed.flatMap(item => item.finishSequence === undefined ? [] : [{ id: item.id, finishSequence: item.finishSequence }])
    .sort((left, right) => left.finishSequence - right.finishSequence)
  const isSeen = (item: { id: string; finishSequence: number }) => !previous || shown.has(item.id) || seenIn(previous, item)
  const oldestUnseen = listed.find(item => !isSeen(item))
  // Just below the oldest unseen completion, else at the newest one; never lower.
  let watermark = Math.max(previous?.watermark ?? 0, oldestUnseen ? oldestUnseen.finishSequence - 1 : listed.at(-1)?.finishSequence ?? 0)
  let above = listed.filter(item => item.finishSequence > watermark && isSeen(item))
  if (above.length > SEEN_ROOM) {
    watermark = above[above.length - SEEN_ROOM - 1].finishSequence
    above = above.filter(item => item.finishSequence > watermark)
  }
  const next: FinishedSeen = { watermark, seen: new Set(above.map(item => seenId(item.id))) }
  if (previous && previous.watermark === next.watermark && previous.seen.size === next.seen.size
    && [...next.seen].every(id => previous.seen.has(id))) return
  finishedSeen.set(seenKey(scope), next)
  writeClientLayoutValue(seenKey(scope), `${watermark.toString(36)}:${[...next.seen].join("")}`)
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
