import { createSignal } from "solid-js"
import { MAX_LAYOUT_VALUE_LENGTH, readClientLayoutValue, writeClientLayoutValue } from "./client-state"

/** A finished task, by identity and its last change. */
export interface MissionSeenTask { id: string; updatedAt: number; status: string }

// Finished tasks this window has shown, like a session's Idle badge: a task finished
// after its Mission's watermark and not individually seen reads as unseen (green) until
// it is selected, its icon is clicked or swept, or its Mission is marked as read.
// Per project, the first server observation fixes the oldest watermark, so tasks already finished
// then never ask for attention; per Mission, Mark as read raises it and the tasks seen
// one by one after it are listed (compact ids, newest kept when the value is full).
const [version, setVersion] = createSignal(0)
const records = new Map<string, { watermark: number; seen: string[] }>()
const boundaries = new Map<string, number>()
const ID_LENGTH = 6
const ROOM = Math.floor((MAX_LAYOUT_VALUE_LENGTH - 12) / ID_LENGTH)

function hash(value: string): string {
  let a = 2166136261
  for (let i = 0; i < value.length; i++) a = Math.imul(a ^ value.charCodeAt(i), 16777619)
  return (a >>> 0).toString(36).padStart(ID_LENGTH, "0").slice(-ID_LENGTH)
}
const projectKey = (scope: string) => `mission-tasks-seen-since-${hash(scope)}`
const missionKey = (scope: string, missionId: string) => `mission-tasks-seen-${hash(scope)}-${hash(missionId)}`

/** The project's first-use watermark, fixed once. */
export function seedMissionTasksSeen(scope: string, boundary: number): void {
  if (boundaries.has(scope) || !Number.isSafeInteger(boundary) || boundary < 0) return
  const text = readClientLayoutValue(projectKey(scope)) ?? ""
  const stored = /^[0-9a-z]{1,11}$/.test(text) ? Number.parseInt(text, 36) : NaN
  const value = Number.isSafeInteger(stored) ? stored : boundary
  boundaries.set(scope, value)
  writeClientLayoutValue(projectKey(scope), value.toString(36))
  setVersion(v => v + 1)
}

function record(scope: string, missionId: string) {
  version()
  const storageKey = missionKey(scope, missionId)
  let value = records.get(storageKey)
  if (!value) {
    const match = /^([0-9a-z]{1,11}):([0-9a-z]*)$/.exec(readClientLayoutValue(storageKey) ?? "")
    value = { watermark: match ? Number.parseInt(match[1], 36) : 0, seen: match?.[2].match(new RegExp(`.{${ID_LENGTH}}`, "g")) ?? [] }
    records.set(storageKey, value)
  }
  value.watermark = Math.max(value.watermark, boundaries.get(scope) ?? 0)
  return value
}

function save(scope: string, missionId: string, value: { watermark: number; seen: string[] }) {
  const kept = { watermark: value.watermark, seen: value.seen.slice(-ROOM) }
  records.set(missionKey(scope, missionId), kept)
  writeClientLayoutValue(missionKey(scope, missionId), `${kept.watermark.toString(36)}:${kept.seen.join("")}`)
  setVersion(v => v + 1)
}

/** Whether a finished task still asks to be seen. */
export function missionTaskUnseen(scope: string, missionId: string, task: MissionSeenTask): boolean {
  version()
  if (!boundaries.has(scope) || task.status !== "completed") return false
  const value = record(scope, missionId)
  return task.updatedAt > value.watermark && !value.seen.includes(hash(`${task.id}:${task.updatedAt}`))
}

/** Marks finished tasks as seen: one at a time (selection, its icon), or every task
 * the Mission holds (Mark as read), which raises its watermark instead. */
export function markMissionTasksSeen(scope: string, missionId: string, tasks: readonly MissionSeenTask[], all = false, through = 0): void {
  const value = record(scope, missionId)
  tasks = tasks.filter(task => task.status === "completed")
  if (all) {
    const watermark = Math.max(value.watermark, Number.isSafeInteger(through) ? through : 0, ...tasks.map(task => task.updatedAt))
    if (watermark !== value.watermark) save(scope, missionId, { watermark, seen: value.seen })
    return
  }
  const added = tasks.filter(task => task.updatedAt > value.watermark).map(task => hash(`${task.id}:${task.updatedAt}`)).filter(id => !value.seen.includes(id))
  if (added.length) save(scope, missionId, { watermark: value.watermark, seen: [...value.seen, ...added] })
}
