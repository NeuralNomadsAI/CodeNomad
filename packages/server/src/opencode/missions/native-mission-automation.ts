import { Context, DateTime, Effect, Schema } from "effect"
import { Automation } from "@opencode/schema/automation"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"

export const missionAutomationService = Context.Service<never, unknown>("@opencode/Automation")

// OpenCode migrates surviving schedule rows to aut_* with the same suffix.
// Keep the Mission's durable IDs, including already prepared wake identities.
export const missionAutomationID = (id: string) => id.startsWith("sch_") ? `aut_${id.slice(4)}` : id
export const sameMissionAutomation = (left: string, right: string) => missionAutomationID(left) === missionAutomationID(right)
export const missionWakeMessageID = (id: string, run: number) => `msg_${id}_${run}`
export const missionWakeReadIDs = (id: string, run: number) =>
  id.startsWith("sch_") ? [missionWakeMessageID(id, run), missionWakeMessageID(missionAutomationID(id), run)] : [missionWakeMessageID(id, run)]

type Metadata = Readonly<Record<string, unknown>>
type WakeMetadata = { id: string; run: number; dueAt: number; late: boolean }
export function missionWakeMetadata(metadata: Metadata | undefined, messageID?: string): WakeMetadata | undefined {
  const native = metadata?.automation, legacy = metadata?.schedule
  if ((native === undefined) === (legacy === undefined)) return
  const value = (native ?? legacy) as Partial<WakeMetadata> | null
  if (!value || typeof value.id !== "string" || !Number.isSafeInteger(value.run) || value.run! < 1
    || !Number.isSafeInteger(value.dueAt) || value.dueAt! < 0 || typeof value.late !== "boolean"
    || (native !== undefined && !value.id.startsWith("aut_"))
    || (messageID !== undefined && messageID !== missionWakeMessageID(value.id, value.run!))) return
  return value as WakeMetadata
}

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
  if (!directory || info.projectID !== owner.projectID || info.sessionID !== slot.sessionID
    || info.name !== slot.name || info.action.type !== "prompt" || info.action.prompt !== signal
    || info.action.to.session !== slot.sessionID || info.trigger.type === "event"
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
