import { createSignal } from "solid-js"
import { MAX_LAYOUT_VALUE_LENGTH, readClientLayoutValue, writeClientLayoutValue, removeClientLayoutValue } from "./client-state"
import { getTabViewState, updateTabViewState, type RestorableTabMissionView } from "./tab-view-state"
import { activateSessionSurface } from "./session-surface"

export interface MissionReaderTarget {
  /** For `playbook`, the playbook id, read without any Mission. */
  missionId: string
  kind: "overview" | "task" | "report" | "change" | "recurrence" | "playbook"
  itemId?: string
  /** `playbook` only: the task-session policy whose coordinator contract is shown. */
  taskMode?: "native" | "independent"
  /** Exact isolated passage scope; never a native session selector. */
  recurrence?: { instanceId: string; projectID: string; scheduleID: string; passageID: string; owner?: "daily" | "scheduled" }
  /** Recurrence readers do not inherit a selected one-shot Mission's authority. */
  instanceId?: string
  projectID?: string
  /** Configuration reader for a calendar-owned schedule without a current passage. */
  scheduleOwner?: "scheduled"
}
/** One selection at a time: a row (`selected`, a schedule) or, instead, one task of a
 * Mission or passage (`selectedTask`, its Mission id beside it). */
export interface MissionTaskSelectionKey { missionId: string; taskId: string }
/** `expanded`: the rows whose chevron shows their children, newest last (at most `MAX_EXPANDED`). */
type ProjectView = RestorableTabMissionView
export const MAX_EXPANDED = 30
const emptyView: ProjectView = {}

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
/** Presentation belongs to the tab occurrence; completion acknowledgements below belong to the project. */
export function missionProjectView(instanceId: string): ProjectView {
  return getTabViewState(instanceId).missions ?? emptyView
}
export function updateMissionProjectView(instanceId: string, patch: Partial<ProjectView>): void {
  const previous = missionProjectView(instanceId)
  const value = { ...previous, ...patch }
  if (previous.selected === value.selected && previous.selectedRecurrence === value.selectedRecurrence && previous.reader === value.reader
    && previous.selectedScheduled === value.selectedScheduled && previous.selectedTask === value.selectedTask && previous.expanded === value.expanded
    && previous.disclosures === value.disclosures) return
  updateTabViewState(instanceId, { missions: value })
  if ("reader" in patch) activateSessionSurface({ instanceId, sessionId: null },
    value.reader ? { kind: "mission", target: value.reader } : { kind: "conversation" })
}
export function missionDisclosureOpen(instanceId: string, missionId: string, id: string, defaultOpen = true): boolean {
  return missionProjectView(instanceId).disclosures?.[key(JSON.stringify([missionId, id]))] ?? defaultOpen
}
export function setMissionDisclosureOpen(instanceId: string, missionId: string, id: string, open: boolean): void {
  const disclosures = { ...missionProjectView(instanceId).disclosures }, section = key(JSON.stringify([missionId, id]))
  if (disclosures[section] === open) return
  delete disclosures[section]
  disclosures[section] = open
  updateMissionProjectView(instanceId, { disclosures })
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
interface FinishedSeen { watermark: number; seen: ReadonlySet<string>; partial?: true; legacy?: ReadonlySet<string> }
export interface MissionCompletion { id: string; finishSequence?: number }
const [seenVersion, setSeenVersion] = createSignal(0)
const finishedSeen = new Map<string, FinishedSeen | undefined>()
function seenKey(scope: string) { return `mission-seen-${key(scope)}` }
function legacySeenKey(scope: string) { return `mission-seen-positives-${key(scope)}` }
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
    const text = readClientLayoutValue(storageKey) ?? "", stored = SEEN_FORMAT.exec(text), partial = /^p([0-9a-z]{1,11}):([0-9a-z,]*)$/.exec(text)
    finishedSeen.set(storageKey, partial && Number.isSafeInteger(parseInt(partial[1], 36)) ? { watermark: parseInt(partial[1], 36), seen: new Set(partial[2].split(",").filter(Boolean)), partial: true,
      legacy: new Set((readClientLayoutValue(legacySeenKey(scope)) ?? "").match(/[a-zA-Z0-9_-]{4}/g)) }
      : stored ? { watermark: parseInt(stored[1], 36), seen: new Set(stored[2].match(/.{4}/g)) } : undefined)
  }
  return finishedSeen.get(storageKey)
}

// A completion without its finish number never asks for attention.
const seenIn = (record: FinishedSeen, completion: MissionCompletion) => completion.finishSequence === undefined
  || completion.finishSequence <= record.watermark || record.seen.has(record.partial ? completion.finishSequence.toString(36) : seenId(completion.id))
  || record.legacy?.has(seenId(completion.id)) === true

/** Whether this window has shown the completed Mission; true before the first list read. */
export function missionFinishedSeen(scope: string, completion: MissionCompletion): boolean {
  const record = readFinishedSeen(scope)
  return !record || seenIn(record, completion)
}

/** Seed once before partial discovery. A durable counter includes deleted finishes
 * and gaps; later pages and refreshes never advance this initial boundary. */
export function seedMissionFinishedSeen(scope: string, finishHighWater: number, folderScope?: string, discovered: readonly MissionCompletion[] = []): void {
  const previous = readFinishedSeen(scope) ?? (folderScope === undefined ? undefined : readFinishedSeen(folderScope))
  if (!Number.isSafeInteger(finishHighWater) || finishHighWater < 0) throw new Error("Invalid finish high-water")
  const watermark = previous?.watermark ?? finishHighWater
  const legacy = new Set(previous?.partial ? previous.legacy : previous?.seen), seen = new Set(previous?.partial ? previous.seen : [])
  for (const row of discovered) if (row.finishSequence !== undefined && legacy.has(seenId(row.id))) {
    if (row.finishSequence > watermark) seen.add(row.finishSequence.toString(36))
  }
  if (previous?.partial && readFinishedSeen(scope) === previous && seen.size === previous.seen.size && legacy.size === (previous.legacy?.size ?? 0)) return
  savePartialSeen(scope, { watermark, seen, legacy, partial: true })
  setSeenVersion(value => value + 1)
}

function savePartialSeen(scope: string, record: FinishedSeen): void {
  finishedSeen.set(seenKey(scope), record)
  let saved = `p${record.watermark.toString(36)}:`
  for (const sequence of [...record.seen].sort((a, b) => parseInt(b, 36) - parseInt(a, 36))) {
    if (saved.length + sequence.length + 1 > MAX_LAYOUT_VALUE_LENGTH) break
    saved += `${sequence},`
  }
  // Bounded legacy hashes also cover colliding, still-undiscovered IDs.
  if (record.legacy?.size) writeClientLayoutValue(legacySeenKey(scope), [...record.legacy].join(""))
  else removeClientLayoutValue(legacySeenKey(scope))
  writeClientLayoutValue(seenKey(scope), saved)
}

/** Records the shown completed Missions as seen, keeping only those still listed. The
 * first call (no record yet) also takes every listed completed Mission as seen. */
export function markMissionsFinishedSeen(scope: string, shownIds: readonly string[], completed: readonly MissionCompletion[], partial = false): void {
  const previous = readFinishedSeen(scope), shown = new Set(shownIds)
  if (partial) {
    if (!previous?.partial) return // an initial durable boundary is required before partial observations
    const seen = new Set(previous.seen)
    for (const item of completed) if (shown.has(item.id) && item.finishSequence !== undefined && item.finishSequence > previous.watermark) seen.add(item.finishSequence.toString(36))
    if (seen.size === previous.seen.size) return
    // Keep every explicit view in this window. Persistence exhaustion forgets only
    // positive seen evidence; it never advances over an unseen/unloaded completion.
    savePartialSeen(scope, { ...previous, seen })
    setSeenVersion(value => value + 1)
    return
  }
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

export function forgetMissionView(instanceId: string, missionId: string): void {
  const view = missionProjectView(instanceId)
  updateMissionProjectView(instanceId, {
    selected: view.selected === missionId ? undefined : view.selected,
    selectedTask: view.selectedTask?.missionId === missionId ? undefined : view.selectedTask,
    reader: view.reader?.missionId === missionId ? undefined : view.reader,
  })
}

export type ScheduleOwner = "daily" | "scheduled"
const [scheduleSeenVersion, setScheduleSeenVersion] = createSignal(0)
const scheduleSeen = new Map<string, ReadonlySet<string>>()
function scheduleSeenKey(scope: string, owner: ScheduleOwner, id: string) {
  return `mission-passage-seen-${key(JSON.stringify([scope, owner, id]))}`
}
function readScheduleSeen(scope: string, owner: ScheduleOwner, id: string): ReadonlySet<string> | undefined {
  scheduleSeenVersion()
  const storageKey = scheduleSeenKey(scope, owner, id)
  if (!scheduleSeen.has(storageKey)) {
    try {
      const value: unknown = JSON.parse(readClientLayoutValue(storageKey) ?? "null")
      if (Array.isArray(value) && value.every(item => typeof item === "string" && item.length <= 240))
        scheduleSeen.set(storageKey, new Set(value))
    } catch { /* A missing positive acknowledgement leaves new results unread. */ }
  }
  return scheduleSeen.get(storageKey)
}
function saveScheduleSeen(scope: string, owner: ScheduleOwner, id: string, values: ReadonlySet<string>): void {
  const storageKey = scheduleSeenKey(scope, owner, id)
  scheduleSeen.set(storageKey, values)
  const saved: string[] = []
  for (const value of [...values].reverse()) {
    if (JSON.stringify([...saved, value]).length > MAX_LAYOUT_VALUE_LENGTH) break
    saved.unshift(value)
  }
  writeClientLayoutValue(storageKey, JSON.stringify(saved))
  setScheduleSeenVersion(value => value + 1)
}
/** As for one-time Missions, the first loaded historical success starts seen.
 * Each schedule seeds independently because the unified inventory is paged. */
export function seedScheduleSuccessSeen(scope: string, owner: ScheduleOwner, id: string, passageID?: string): void {
  if (readScheduleSeen(scope, owner, id)) return
  saveScheduleSeen(scope, owner, id, new Set(passageID ? [passageID] : []))
}
export function scheduleSuccessSeen(scope: string, owner: ScheduleOwner, id: string, passageID: string): boolean {
  return readScheduleSeen(scope, owner, id)?.has(passageID) ?? true
}
/** Capture the displayed passage before invoking this, including for late callbacks.
 * Retain exact positive identities: acknowledging A can never acknowledge B. */
export function markScheduleSuccessSeen(scope: string, owner: ScheduleOwner, id: string, passageID: string): void {
  const previous = readScheduleSeen(scope, owner, id) ?? new Set<string>()
  if (!previous.has(passageID)) saveScheduleSeen(scope, owner, id, new Set([...previous, passageID]))
}
