import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import type { MissionDocument } from "../../missions/mission-document"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { unobservedMissionSchedule, type MissionScheduleObservation } from "../../missions/mission-schedule-display"
import { acquireNativeScheduleCalendarService, nativeScheduleCalendarMatches, type NativeScheduleCalendarService } from "./native-schedule-calendar-service"
import type { MissionNativeRunner } from "./native-service-adapter"

/** At most eight exact point reads, never a calendar list, clock computation,
 * reconciliation or mutation. Partial/foreign data keeps the entire group unknown. */
export async function observeNativeMissionSchedule(doc: MissionDocument, native: Pick<NativeScheduleCalendarService, "get" | "assertCurrent">,
  unchanged: () => Promise<boolean>): Promise<MissionScheduleObservation> {
  const unknown = { ...unobservedMissionSchedule(doc), state: "unknown" as const }
  const slots = doc.calendarOwner?.slots.filter(item => item.role === "principal") ?? []
  if (!slots.length && !doc.calendars.some(item => item.role === "principal")) return unobservedMissionSchedule(doc)
  const expected = doc.configuration.launch.timing.kind === "multi" ? doc.configuration.launch.timing.calendars.length : 1
  if (slots.length !== expected || doc.synchronization || doc.calendarOwner?.operation.pending) return unknown
  try {
    let wakeCount = 0
    const dates: number[] = []
    const statuses = new Set<"active" | "paused" | "done">()
    for (const slot of slots) {
      const mapping = doc.calendars.find(item => item.role === "principal" && item.slot === slot.slot)
      if (slot.creation !== "adopted" || !slot.scheduleID || !mapping || mapping.scheduleID !== slot.scheduleID
        || mapping.sessionID !== slot.sessionID || slot.timeGeneration !== doc.timeGeneration || mapping.timeGeneration !== doc.timeGeneration) return unknown
      const info = await native.get({ missionID: doc.id, descriptor: slot }, slot.scheduleID, () => native.assertCurrent())
      if (!info || info.id !== slot.scheduleID || !nativeScheduleCalendarMatches(info, slot) || info.runCount < mapping.highWater) return unknown
      if (info.status === "active" && info.nextDueAt === null) return unknown
      statuses.add(info.status)
      wakeCount += info.runCount
      if (!Number.isSafeInteger(wakeCount)) return unknown
      if (info.status === "active" && info.nextDueAt !== null) dates.push(info.nextDueAt)
    }
    native.assertCurrent()
    if (!await unchanged()) return unknown
    native.assertCurrent()
    return { ...unknown, state: "known", nativeStatus: statuses.size === 1 ? [...statuses][0] : "mixed", wakeCount, nextDueAt: dates.length ? Math.min(...dates) : null }
  } catch { return unknown }
}

export async function nativeMissionScheduleObservation(ctx: Plugin.Context, doc: MissionDocument, run: MissionNativeRunner) {
  if (!doc.calendars.some(item => item.role === "principal")) return unobservedMissionSchedule(doc)
  try {
    return await run(Effect.scoped(Effect.gen(function* () {
      // The existing qualified adapter's get path is read-only. Carrier agent is
      // used solely by ensureCarrier, which this display reader never calls.
      const native = yield* acquireNativeScheduleCalendarService(ctx, "schedule-display", () => true, run)
      const store = new NativeMissionDocumentStore({ get: key => run(ctx.storage.get(key)),
        compareAndSet: async () => { throw new Error("schedule-display-read-only") } }, ctx.location.project.id, ctx.location.project.canonical)
      return yield* Effect.promise(() => observeNativeMissionSchedule(doc, native, async () => {
        const fresh = await store.read(doc.id)
        return !!fresh && !("deletedAt" in fresh) && fresh.revision === doc.revision
      }))
    })))
  } catch { return { ...unobservedMissionSchedule(doc), state: "unknown" as const } }
}
