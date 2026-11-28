import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import type { NativeScheduleCalendarInfo } from "./native-schedule-calendar-service"
import { missionCodeWakeRunning } from "./native-mission-automation"
import { nativeScheduleWakeKey, type NativeScheduleTransportReply, type NativeScheduleWake } from "./native-schedule-transport-contract"

/** A principal run is admitted while its
 * program still runs: OpenCode counts the run only after the program returns, so the
 * row's unchanged count and next due time identify it. The durable preparation then
 * proves the run once OpenCode counts it. `pending`: admitted; `applied`: consumed;
 * `rejected`: nothing written, so the program fails and OpenCode retries the same run. */
export async function admitNativeMissionScheduleCodeWake(wake: NativeScheduleWake, ports: {
  store: NativeMissionDocumentStore; current(): true; row(): Promise<NativeScheduleCalendarInfo | undefined>
}): Promise<NativeScheduleTransportReply> {
  const reply = (state: NativeScheduleTransportReply["state"]) => ({ key: nativeScheduleWakeKey(wake), state })
  return ports.store.withExclusion(async locked => {
    ports.current()
    const doc = await locked.read(wake.missionID)
    if (!doc || "deletedAt" in doc || doc.timeGeneration !== wake.generation || !doc.calendarOwner) return reply("rejected")
    const calendar = doc.calendars.find(item => item.sessionID === wake.sessionID && item.scheduleID === wake.scheduleID
      && item.timeGeneration === wake.generation && item.role === "principal")
    const descriptor = doc.calendarOwner.slots.find(item => item.sessionID === wake.sessionID && item.scheduleID === wake.scheduleID
      && item.role === "principal" && item.creation === "adopted" && item.timeGeneration === doc.timeGeneration)
    if (!calendar || !descriptor) return reply("rejected")
    const row = await ports.row()
    ports.current(); locked.assertActive()
    const prepared = calendar.wakePreparing
    if (row && !row.code) throw new Error("schedule-calendar-requires-code")
    if (row && calendar.highWater >= wake.run) return reply("applied")
    if (!row || row.status !== "active" || row.nextDueAt === null) return reply("rejected")
    // Counted already: only its own preparation explains it.
    if (row.runCount !== wake.run - 1) return reply(row.runCount === wake.run && prepared?.run === wake.run ? "pending" : "rejected")
    // An earlier counted run waits for its own processing first.
    if (wake.run !== calendar.highWater + 1) return reply("rejected")
    const proof = { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: row.nextDueAt }
    if (prepared && canonicalAuthority(prepared) === canonicalAuthority(proof)) return reply("pending")
    // Row state alone also fits a future occurrence: only this run's own program, live in this process, may admit it.
    if (!missionCodeWakeRunning(wake.scheduleID, wake.run)) return reply("rejected")
    if (doc.state !== "running" || doc.synchronization || doc.deletion || doc.blocked || doc.calendarOwner.operation.pending) return reply("rejected")
    const guard = (): true => { ports.current(); locked.assertActive(); return assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots) }
    await locked.change(doc.id, doc.revision, guard, value => {
      // A row resumed after failed runs reuses this count at its next slot; the
      // uncounted earlier slot never ran, and no passage reserved its preparation.
      const target = value.calendars.find(item => item.scheduleID === wake.scheduleID)!
      target.wakePreparing = null
      missionDocumentChanges.prepareWake(value, proof)
    })
    return reply("pending")
  })
}
