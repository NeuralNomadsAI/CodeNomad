import { Context, DateTime, Effect, Option, Predicate, Schema } from "effect"
import { Automation } from "@opencode/schema/automation"
import { canonicalAuthority } from "../../missions/authority-protocol"
import type { MissionCalendar, MissionDocument, MissionWake } from "../../missions/mission-document"
import type { DocumentFanInWindow, DocumentPassageWake } from "../../missions/mission-document-passage-engine"
import { isAllowedScheduleCarrierModel, isLegacyScheduleCarrierModel } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import type { MissionNativeRunner, MissionNativeService } from "./native-service-adapter"

import { matchMissionAutomation, missionAutomationID, missionAutomationRunFloor, missionAutomationService, missionCodeWake, missionCodeWakeProof, missionCodeWakeRow,
  missionWakeMetadata, missionWakeReadIDs, readMissionAutomation, sameMissionAutomation, type MissionAutomationReader,
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
    const session = await native.get({ sessionID: calendar.sessionID }, { signal })
    if (session.parentID || session.projectID !== doc.projectID || session.location.directory !== native.location.directory
      || session.location.workspaceID !== native.location.workspaceID || canonicalAuthority(session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER])
        !== canonicalAuthority({ missionID: doc.id, timeGeneration: doc.timeGeneration, role: calendar.role, slot: calendar.slot })
      || !isAllowedScheduleCarrierModel(session.model))
      throw new Error("Native passage carrier differs")
    const nativeID = missionAutomationID(calendar.scheduleID)
    const enabled = schedules.enabled(native.location.directory), get = schedules.get(nativeID)
    if (!Effect.isEffect(enabled) || !Effect.isEffect(get) || await run(enabled) !== true) throw new Error("Native schedule coverage disabled")
    const info = await run(get.pipe(Effect.flatMap(readMissionAutomation)))
    const code = missionCodeWake(info)
    if (!code && !isLegacyScheduleCarrierModel(session.model)) throw new Error("Native passage carrier differs")
    if (info.id !== nativeID || !matchMissionAutomation(info, descriptor,
      { directory: native.location.directory, projectID: doc.projectID }, NATIVE_SCHEDULE_CARRIER_SIGNAL)
      || !Number.isSafeInteger(info.runCount) || info.runCount < missionAutomationRunFloor(code, calendar.highWater))
      throw new Error("Native passage calendar differs")
    current(); signal.throwIfAborted()
    return info
  }
  const message = async (calendar: MissionCalendar, info: MissionAutomationInfo, count: number, current: () => true, signal: AbortSignal): Promise<MissionWake> => {
    if (missionCodeWake(info)) {
      const proof = missionCodeWakeProof(calendar, missionCodeWakeRow(info), count)
      if (!proof) throw new Error("Native passage wake proof unavailable")
      current(); signal.throwIfAborted()
      return proof
    }
    const messageID = `msg_${calendar.scheduleID}_${count}`
    let proof: MissionWake | undefined
    for (const id of missionWakeReadIDs(calendar.scheduleID, count)) {
      const value = await native.message({ sessionID: calendar.sessionID, messageID: id }, { signal })
      if (!value) continue
      const metadata = missionWakeMetadata(value.metadata, id)
      if (proof || value.id !== id || value.type !== "user" || value.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL
        || !metadata || !sameMissionAutomation(metadata.id, calendar.scheduleID) || metadata.run !== count)
        throw new Error("Native passage wake proof unavailable")
      proof = { scheduleID: calendar.scheduleID, run: count, messageID, dueAt: metadata.dueAt }
    }
    if (!proof) throw new Error("Native passage wake proof unavailable")
    current(); signal.throwIfAborted()
    return proof
  }
  return {
    verifyWake: async (doc: MissionDocument, wake: DocumentPassageWake, current: () => true, signal: AbortSignal) => {
      const calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)
      if (!calendar || calendar.sessionID !== wake.sessionID || calendar.timeGeneration !== wake.generation || wake.missionID !== doc.id
        || wake.messageID !== `msg_${wake.scheduleID}_${wake.run}`) throw new Error("Native passage wake mapping differs")
      const info = await read(doc, calendar, current, signal)
      if (!missionCodeWake(info) && info.runCount < wake.run) throw new Error("Native passage wake acknowledgement pending")
      const observed = await message(calendar, info, wake.run, current, signal)
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
        // Prompt entry admits only highWater + 1, so while that prepared run is native's
        // last one every later firing is refused before its message exists: native then
        // keeps retrying an overdue slot, and that refusal is the barrier. A prepared code
        // run is that barrier from admission, before its own program returns.
        const code = missionCodeWake(before), prepared = calendar.wakePreparing
        const gated = before.status === "active" && prepared?.run === calendar.highWater + 1
          && (code ? before.runCount >= calendar.highWater : before.runCount === prepared.run)
        if (!pausedObservation && !gated && before.status !== "done" && (before.status !== "active" || before.nextDueAt === undefined
          || DateTime.toEpochMillis(before.nextDueAt) <= window.cutoff)) return incomplete()
        const last = code ? Math.max(before.runCount, prepared?.run ?? 0) : before.runCount
        if (last - calendar.highWater > 256 - wakes.length) return incomplete()
        const group: MissionWake[] = []
        for (let count = calendar.highWater + 1; count <= last; count++) group.push(await message(calendar, before, count, current, signal))
        if (calendar.wakePreparing && !group.some(wake => canonicalAuthority(wake) === canonicalAuthority(calendar.wakePreparing))) return incomplete()
        if (group.some((wake, index) => index > 0 && wake.dueAt < group[index - 1].dueAt)) return incomplete()
        proofs.push({ calendar, before, group })
        wakes.push(...group)
      }
      // Whole-group recheck, after every other principal's asynchronous reads.
      for (const { calendar, before, group } of proofs) {
        for (const wake of group) if (canonicalAuthority(await message(calendar, before, wake.run, current, signal)) !== canonicalAuthority(wake)) return incomplete()
        const after = await read(doc, calendar, current, signal)
        if (canonicalAuthority(Schema.encodeSync(Automation.Info)(before)) !== canonicalAuthority(Schema.encodeSync(Automation.Info)(after))) return incomplete()
      }
      current(); signal.throwIfAborted()
      return { complete: true, wakes, current }
    },
  }
})
