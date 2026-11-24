import { Context, DateTime, Effect, Option, Predicate, Schema } from "effect"
import { Automation } from "@opencode/schema/automation"
import { canonicalAuthority } from "../../missions/authority-protocol"
import type { MissionCalendar, MissionDocument, MissionWake } from "../../missions/mission-document"
import type { DocumentFanInWindow, DocumentPassageWake } from "../../missions/mission-document-passage-engine"
import { isAllowedScheduleCarrierModel } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import type { MissionNativeRunner, MissionNativeService } from "./native-service-adapter"

import { matchMissionAutomation, missionAutomationID, missionAutomationRunFloor, missionAutomationService, missionCodeWake, missionCodeWakeProof, missionCodeWakeRow,
  readMissionAutomation, type MissionAutomationReader,
  type MissionAutomationInfo } from "./native-mission-automation"

/** Complete, bounded native coverage. The durable cutoff is a barrier: a future
 * nextDueAt (or done) proves that later native firings cannot join this window.
 * Both observations occur outside document SQL publication; commit guards are pure. */
export const acquireNativeScheduledPassageCoverage = Effect.fn("missions.acquireScheduledPassageCoverage")(function* (
  native: MissionNativeService, run: MissionNativeRunner,
) {
  const found = yield* Effect.serviceOption(missionAutomationService)
  if (Option.isNone(found)) throw new Error("Native scheduled passage coverage unavailable")
  const schedules = found.value as MissionAutomationReader
  if (!Predicate.isFunction(schedules.get) || !Predicate.isFunction(schedules.enabled)) throw new Error("Native schedule readers unavailable")
  const read = async (doc: MissionDocument, calendar: MissionCalendar, current: () => true, signal: AbortSignal) => {
    current(); signal.throwIfAborted()
    const descriptor = doc.calendarOwner?.slots.find(item => item.sessionID === calendar.sessionID && item.scheduleID === calendar.scheduleID)
    if (!descriptor || descriptor.creation !== "adopted" || descriptor.timeGeneration !== doc.timeGeneration
      || descriptor.role !== calendar.role || descriptor.slot !== calendar.slot) throw new Error("Native calendar ownership incomplete")
    const nativeID = missionAutomationID(calendar.scheduleID)
    const [session, [enabled, info]] = await Promise.all([
      native.get({ sessionID: calendar.sessionID }, { signal }),
      run(Effect.all([Effect.suspend(() => schedules.enabled(native.location.directory)),
        Effect.suspend(() => schedules.get(nativeID)).pipe(Effect.flatMap(readMissionAutomation))], { concurrency: "unbounded" })),
    ])
    if (enabled !== true) throw new Error("Native schedule coverage disabled")
    if (!missionCodeWake(info)) throw new Error("schedule-calendar-requires-code")
    if (session.parentID || session.projectID !== doc.projectID || session.location.directory !== native.location.directory
      || session.location.workspaceID !== native.location.workspaceID || canonicalAuthority(session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER])
        !== canonicalAuthority({ missionID: doc.id, timeGeneration: doc.timeGeneration, role: calendar.role, slot: calendar.slot })
      || !isAllowedScheduleCarrierModel(session.model))
      throw new Error("Native passage carrier differs")
    if (info.id !== nativeID || !matchMissionAutomation(info, descriptor,
      { directory: native.location.directory, projectID: doc.projectID }, NATIVE_SCHEDULE_CARRIER_SIGNAL)
      || !Number.isSafeInteger(info.runCount) || info.runCount < missionAutomationRunFloor(calendar.highWater))
      throw new Error("Native passage calendar differs")
    current(); signal.throwIfAborted()
    return info
  }
  const occurrence = (calendar: MissionCalendar, info: MissionAutomationInfo, count: number): MissionWake => {
    const proof = missionCodeWakeProof(calendar, missionCodeWakeRow(info), count)
    if (!proof) throw new Error("Native passage wake proof unavailable")
    return proof
  }
  return {
    verifyWake: async (doc: MissionDocument, wake: DocumentPassageWake, current: () => true, signal: AbortSignal) => {
      const calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)
      if (!calendar || calendar.sessionID !== wake.sessionID || calendar.timeGeneration !== wake.generation || wake.missionID !== doc.id
        || wake.messageID !== `msg_${wake.scheduleID}_${wake.run}`) throw new Error("Native passage wake mapping differs")
      const info = await read(doc, calendar, current, signal)
      const observed = occurrence(calendar, info, wake.run)
      if (wake.dueAt !== undefined && wake.dueAt !== observed.dueAt) throw new Error("Native passage wake time differs")
      return { wake: observed, current }
    },
    coverage: async (doc: MissionDocument, window: DocumentFanInWindow, current: () => true, signal: AbortSignal) => {
      const principals = doc.calendars.filter(item => item.role === "principal")
      const incomplete = () => ({ complete: false, wakes: [] as MissionWake[], current })
      if (!principals.length || window.timeGeneration !== doc.timeGeneration || canonicalAuthority(window.principalIDs)
        !== canonicalAuthority(principals.map(item => item.scheduleID).sort())) return incomplete()
      const wakes: MissionWake[] = []
      const proofs: Array<{ calendar: MissionCalendar; before: MissionAutomationInfo; group: MissionWake[] }> = []
      for (const calendar of principals) {
        const before = await read(doc, calendar, current, signal)
        // A positive pause freezes future firing for observation only. An
        // in-flight preparation still needs its exact ACK/message below.
        const pausedObservation = window.suppress === true && before.status === "paused"
        // A live preparation is a barrier while its program is still uncounted.
        const prepared = calendar.wakePreparing
        const gated = before.status === "active" && prepared?.run === calendar.highWater + 1 && before.runCount >= calendar.highWater
        if (!pausedObservation && !gated && before.status !== "done" && (before.status !== "active" || before.nextDueAt === undefined
          || DateTime.toEpochMillis(before.nextDueAt) <= window.cutoff)) return incomplete()
        const last = Math.max(before.runCount, prepared?.run ?? 0)
        if (last - calendar.highWater > 256 - wakes.length) return incomplete()
        const group: MissionWake[] = []
        for (let count = calendar.highWater + 1; count <= last; count++) group.push(occurrence(calendar, before, count))
        if (calendar.wakePreparing && !group.some(wake => canonicalAuthority(wake) === canonicalAuthority(calendar.wakePreparing))) return incomplete()
        if (group.some((wake, index) => index > 0 && wake.dueAt < group[index - 1].dueAt)) return incomplete()
        proofs.push({ calendar, before, group })
        wakes.push(...group)
      }
      // Whole-group recheck, after every other principal's asynchronous reads.
      for (const { calendar, before, group } of proofs) {
        const after = await read(doc, calendar, current, signal)
        if (canonicalAuthority(Schema.encodeSync(Automation.Info)(before)) !== canonicalAuthority(Schema.encodeSync(Automation.Info)(after))) return incomplete()
        for (const wake of group) if (canonicalAuthority(occurrence(calendar, after, wake.run)) !== canonicalAuthority(wake)) return incomplete()
      }
      current(); signal.throwIfAborted()
      return { complete: true, wakes, current }
    },
  }
})
