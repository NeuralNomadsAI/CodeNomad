import { Context, DateTime, Effect, Option, Predicate, Schema } from "effect"
import { Schedule } from "@opencode/schema/schedule"
import { canonicalAuthority } from "../../missions/authority-protocol"
import type { MissionCalendar, MissionDocument, MissionWake } from "../../missions/mission-document"
import type { DocumentFanInWindow, DocumentPassageWake } from "../../missions/mission-document-passage-engine"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import type { MissionNativeRunner, MissionNativeService } from "./native-service-adapter"

const scheduleTag = Context.Service<never, unknown>("@opencode/Schedule")
type Schedules = { get(id: string): Effect.Effect<unknown, unknown>; enabled(id: string): Effect.Effect<unknown, unknown> }

/** Complete, bounded native coverage. The durable cutoff is a barrier: a future
 * nextDueAt (or done) proves that later native firings cannot join this window.
 * Both observations occur outside document SQL publication; commit guards are pure. */
export const acquireNativeScheduledPassageCoverage = Effect.fn("missions.acquireScheduledPassageCoverage")(function* (
  native: MissionNativeService, run: MissionNativeRunner,
) {
  const found = yield* Effect.serviceOption(scheduleTag)
  if (Option.isNone(found)) throw new Error("Native scheduled passage coverage unavailable")
  const schedules = found.value as Schedules
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
      || session.model?.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID || session.model.id !== NATIVE_SCHEDULE_CARRIER_MODEL.id)
      throw new Error("Native passage carrier differs")
    const enabled = schedules.enabled(calendar.sessionID), get = schedules.get(calendar.scheduleID)
    if (!Effect.isEffect(enabled) || !Effect.isEffect(get) || await run(enabled) !== true) throw new Error("Native schedule coverage disabled")
    const info = await run(get.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(Schedule.Info)))))
    const endsAt = info.endsAt === undefined ? null : DateTime.toEpochMillis(info.endsAt)
    if (info.id !== calendar.scheduleID || info.sessionID !== calendar.sessionID || info.name !== descriptor.name
      || canonicalAuthority(info.when) !== canonicalAuthority(descriptor.when) || endsAt !== descriptor.endsAt
      || info.remainingRuns !== undefined || info.action.type !== "prompt" || info.action.prompt !== NATIVE_SCHEDULE_CARRIER_SIGNAL
      || !Number.isSafeInteger(info.runCount) || info.runCount < calendar.highWater) throw new Error("Native passage calendar differs")
    current(); signal.throwIfAborted()
    return info
  }
  const message = async (calendar: MissionCalendar, count: number, current: () => true, signal: AbortSignal): Promise<MissionWake> => {
    const messageID = `msg_${calendar.scheduleID}_${count}`
    const value = await native.message({ sessionID: calendar.sessionID, messageID }, { signal })
    const metadata = value?.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
    if (!value || value.id !== messageID || value.type !== "user"
      || value.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL || metadata?.id !== calendar.scheduleID || metadata.run !== count
      || !Number.isSafeInteger(metadata.dueAt) || Number(metadata.dueAt) < 0 || typeof metadata.late !== "boolean")
      throw new Error("Native passage wake proof unavailable")
    current(); signal.throwIfAborted()
    return { scheduleID: calendar.scheduleID, run: count, messageID, dueAt: Number(metadata.dueAt) }
  }
  return {
    verifyWake: async (doc: MissionDocument, wake: DocumentPassageWake, current: () => true, signal: AbortSignal) => {
      const calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)
      if (!calendar || calendar.sessionID !== wake.sessionID || calendar.timeGeneration !== wake.generation || wake.missionID !== doc.id
        || wake.messageID !== `msg_${wake.scheduleID}_${wake.run}`) throw new Error("Native passage wake mapping differs")
      const info = await read(doc, calendar, current, signal)
      if (info.runCount < wake.run) throw new Error("Native passage wake acknowledgement pending")
      const observed = await message(calendar, wake.run, current, signal)
      if (wake.dueAt !== undefined && wake.dueAt !== observed.dueAt) throw new Error("Native passage wake time differs")
      return { wake: observed, current }
    },
    coverage: async (doc: MissionDocument, window: DocumentFanInWindow, current: () => true, signal: AbortSignal) => {
      const principals = doc.calendars.filter(item => item.role === "principal")
      const incomplete = () => ({ complete: false, wakes: [] as MissionWake[], current })
      if (!principals.length || window.timeGeneration !== doc.timeGeneration || canonicalAuthority(window.principalIDs)
        !== canonicalAuthority(principals.map(item => item.scheduleID).sort())) return incomplete()
      const wakes: MissionWake[] = []
      const proofs: Array<{ calendar: MissionCalendar; before: Schedule.Info; group: MissionWake[] }> = []
      for (const calendar of principals) {
        const before = await read(doc, calendar, current, signal)
        // A positive pause freezes future firing for observation only. An
        // in-flight preparation still needs its exact ACK/message below.
        const pausedObservation = window.suppress === true && before.status === "paused"
        if (!pausedObservation && before.status !== "done" && (before.status !== "active" || before.nextDueAt === undefined
          || DateTime.toEpochMillis(before.nextDueAt) <= window.cutoff)) return incomplete()
        if (before.runCount - calendar.highWater > 256 - wakes.length) return incomplete()
        const group: MissionWake[] = []
        for (let count = calendar.highWater + 1; count <= before.runCount; count++) group.push(await message(calendar, count, current, signal))
        if (calendar.wakePreparing && !group.some(wake => canonicalAuthority(wake) === canonicalAuthority(calendar.wakePreparing))) return incomplete()
        if (group.some((wake, index) => index > 0 && wake.dueAt < group[index - 1].dueAt)) return incomplete()
        proofs.push({ calendar, before, group })
        wakes.push(...group)
      }
      // Whole-group recheck, after every other principal's asynchronous reads.
      for (const { calendar, before, group } of proofs) {
        for (const wake of group) if (canonicalAuthority(await message(calendar, wake.run, current, signal)) !== canonicalAuthority(wake)) return incomplete()
        const after = await read(doc, calendar, current, signal)
        if (canonicalAuthority(Schema.encodeSync(Schedule.Info)(before)) !== canonicalAuthority(Schema.encodeSync(Schedule.Info)(after))) return incomplete()
      }
      current(); signal.throwIfAborted()
      return { complete: true, wakes, current }
    },
  }
})
