import { Context, DateTime, Effect, Schema } from "effect"
import { Automation } from "@opencode/schema/automation"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"
import type { MissionCalendar, MissionWake } from "../../missions/mission-document"

export const missionAutomationService = Context.Service<never, unknown>("@opencode/Automation")

/** New calendars run this fixed Code Mode program, which calls the wake tool with
 * no model turn. */
export const MISSION_WAKE_TOOL = Object.freeze({ namespace: "codenomad", name: "mission_schedule_wake", permission: "codenomad_mission_schedule_wake" })
// OpenCode accepts only nothing or a CodeResult: without `return null` the tool's output would be the result.
export const MISSION_WAKE_CODE = `await tools.${MISSION_WAKE_TOOL.namespace}.${MISSION_WAKE_TOOL.name}({}); return null`
/** Carrier rules that let OpenCode authorize the program at creation and run it unattended. */
export const MISSION_WAKE_PERMISSIONS = Object.freeze([
  Object.freeze({ action: "execute", resource: "*", effect: "allow" as const }),
  Object.freeze({ action: MISSION_WAKE_TOOL.permission, resource: "*", effect: "allow" as const }),
])
export const missionCodeWake = (info: Pick<MissionAutomationInfo, "action">) => info.action.type === "code"

// Code wake programs running in this process, shared by every bundle incarnation.
const runningSymbol = Symbol.for("codenomad.missions.code-wake.running")
const host = globalThis as typeof globalThis & { [runningSymbol]?: Map<string, number> }
const running = host[runningSymbol] ??= new Map<string, number>()
const runningKey = (scheduleID: string, run: number) => `${missionAutomationID(scheduleID)}:${run}`
/** Registers a code wake for its program's whole run; registration precedes any await. */
export async function runningMissionCodeWake<T>(scheduleID: string, run: number, work: () => Promise<T>): Promise<T> {
  const key = runningKey(scheduleID, run)
  running.set(key, (running.get(key) ?? 0) + 1)
  try { return await work() }
  finally {
    const count = (running.get(key) ?? 1) - 1
    if (count > 0) running.set(key, count)
    else running.delete(key)
  }
}
/** OpenCode counts a returned run even after a pause; only a program that ended uncounted stays uncounted. */
export const missionCodeWakeRunning = (scheduleID: string, run: number) => running.has(runningKey(scheduleID, run))
/** OpenCode counts a code run once its program returns, after Missions consumed it. */
export const missionAutomationRunFloor = (highWater: number) => highWater - 1
export type MissionCodeWakeRow = { runCount: number; status: Automation.Status; nextDueAt: number | null }
export const missionCodeWakeRow = (info: MissionAutomationInfo): MissionCodeWakeRow => ({ runCount: info.runCount, status: info.status,
  nextDueAt: info.nextDueAt === undefined ? null : DateTime.toEpochMillis(info.nextDueAt) })

/** A code run leaves no native message. Its proof is the calendar itself: a run at or
 * below high-water, a principal's durable preparation, or an auxiliary run whose program
 * is live in this process (OpenCode has not counted it; its due time is the row's next one). */
export function missionCodeWakeProof(calendar: MissionCalendar, row: MissionCodeWakeRow, run: number): MissionWake | undefined {
  const messageID = missionWakeMessageID(calendar.scheduleID, run), prepared = calendar.wakePreparing
  if (row.runCount < missionAutomationRunFloor(calendar.highWater) || row.runCount > Math.max(calendar.highWater, prepared?.run ?? 0)) return
  if (run <= calendar.highWater) return { scheduleID: calendar.scheduleID, run, messageID, dueAt: calendar.lastDueAt ?? 0 }
  if (prepared) return prepared.run === run ? prepared : undefined
  if (calendar.role !== "reconciliation" || run !== calendar.highWater + 1 || row.runCount !== run - 1
    || row.status === "done" || row.nextDueAt === null || !missionCodeWakeRunning(calendar.scheduleID, run)) return
  return { scheduleID: calendar.scheduleID, run, messageID, dueAt: row.nextDueAt }
}

// OpenCode migrates surviving schedule rows to aut_* with the same suffix.
// Keep the Mission's durable IDs, including already prepared wake identities.
export const missionAutomationID = (id: string) => id.startsWith("sch_") ? `aut_${id.slice(4)}` : id
export const sameMissionAutomation = (left: string, right: string) => missionAutomationID(left) === missionAutomationID(right)
export const missionWakeMessageID = (id: string, run: number) => `msg_${id}_${run}`
export const missionAutomationInfo = Schema.toType(Automation.Info)
export const readMissionAutomation = Schema.decodeUnknownEffect(missionAutomationInfo)
export type MissionAutomationInfo = typeof missionAutomationInfo.Type
type NativeEffect = Effect.Effect<unknown, unknown>
export type MissionAutomationReader = { get(id: string): NativeEffect; enabled(directory: string): NativeEffect }

export function missionAutomationTrigger(slot: Pick<MissionCalendarOwnerSlot, "when" | "anchorAt">): Exclude<Automation.Trigger, Automation.Event> {
  if (slot.when.type !== "in") return slot.when
  const delay = Automation.durationMillis(slot.when.in)
  if (slot.anchorAt === undefined || delay._tag !== "Some") throw new Error("Native calendar anchor unavailable")
  return { type: "at", at: new Date(slot.anchorAt + delay.value).toISOString(), tz: slot.when.tz }
}

export function matchMissionAutomation(info: MissionAutomationInfo, slot: MissionCalendarOwnerSlot,
  owner: { directory: string; projectID: string }, signal: string) {
  // Migrated Windows rows can contain the slash-separated SQL spelling of the same Location.
  const directory = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(owner.directory)
    ? info.directory.replaceAll("/", "\\") === owner.directory.replaceAll("/", "\\") : info.directory === owner.directory
  const action = info.action
  const wakes = action.type === "prompt" ? action.prompt === signal && action.to.session === slot.sessionID
    : action.type === "code" && action.code === MISSION_WAKE_CODE && action.args === undefined
  if (!directory || info.projectID !== owner.projectID || info.sessionID !== slot.sessionID
    || info.name !== slot.name || !wakes || info.trigger.type === "event"
    || (info.expires === undefined ? null : DateTime.toEpochMillis(info.expires)) !== slot.endsAt
    || (slot.anchorAt !== undefined && DateTime.toEpochMillis(info.time.created) !== slot.anchorAt)) return false
  const expected = missionAutomationTrigger(slot), actual = info.trigger
  if ((actual.tz ?? info.tz) !== expected.tz) return false
  switch (expected.type) {
    case "at": return actual.type === "at" && actual.at === expected.at
    case "every": return actual.type === "every" && actual.every === expected.every
    case "cron": return actual.type === "cron" && actual.cron === expected.cron
  }
}
