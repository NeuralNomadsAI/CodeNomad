import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import type { MissionDocument } from "../../missions/mission-document"
import { requiresMissionCalendar } from "../../missions/launch-policy"
import { assertNativeScheduleProviderAvailable } from "./native-schedule-provider-registration"
import { assertNativeScheduleCarrierArtifacts, NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { isAllowedScheduleCarrierModel, isLegacyScheduleCarrierModel } from "./native-schedule-carrier"

import { matchMissionAutomation, missionAutomationID, missionAutomationService, missionCodeWake, readMissionAutomation, type MissionAutomationReader } from "./native-mission-automation"
const sessionTag = Context.Service<never, unknown>("@opencode/Session")
type NativeEffect = Effect.Effect<unknown, unknown>

/** Per-invocation mutation qualification. Observers need neither an installed
 * provider nor a live auxiliary. Native mutations qualify after lazy construction
 * and pinned-root reads, immediately before their synchronous effect-entry fence. */
export const acquireNativeScheduledPassageCapability = Effect.fn("missions.acquireScheduledPassageCapability")(function* (
  ctx: Plugin.Context, current: () => true,
) {
  const schedules = yield* Effect.serviceOption(missionAutomationService), sessions = yield* Effect.serviceOption(sessionTag)
  const qualified = new Set<string>()
  const identity = (doc: MissionDocument) => {
    current()
    const owner = doc.calendarOwner
    if (!owner || !doc.pending) throw new Error("Document passage owner unavailable")
    if (!requiresMissionCalendar(doc.pending.configuration.launch)) {
      if (doc.calendars.length || owner.slots.length || owner.retired.length || owner.auxiliaryReady)
        throw new Error("Immediate passage technical ownership unresolved")
      return { owner, descriptor: undefined, key: canonicalAuthority(["immediate", doc.id, doc.pending.id,
        doc.timeGeneration, owner.installation]) }
    }
    const auxiliary = owner?.slots.filter(item => item.role === "reconciliation")
    const descriptor = auxiliary?.length === 1 ? auxiliary[0] : undefined
    const calendar = doc.calendars.find(item => item.role === "reconciliation")
    if (!owner?.auxiliaryReady || !doc.pending || !descriptor || descriptor.creation !== "adopted" || !descriptor.scheduleID
      || descriptor.slot !== 0 || descriptor.timeGeneration !== doc.timeGeneration || !calendar
      || calendar.scheduleID !== descriptor.scheduleID || calendar.sessionID !== descriptor.sessionID
      || calendar.timeGeneration !== doc.timeGeneration || calendar.slot !== 0) throw new Error("Scheduled passage auxiliary unavailable")
    assertNativeScheduleCarrierArtifacts(owner.installation)
    return { owner, descriptor, key: canonicalAuthority([doc.id, doc.pending.id, doc.timeGeneration, owner.installation, descriptor,
      calendar.scheduleID, calendar.sessionID]) }
  }
  const assertCurrent = (doc: MissionDocument): true => {
    const proof = identity(doc)
    if (!qualified.has(proof.key)) throw new Error("Scheduled passage capability unqualified")
    return current()
  }
  const prepare = (doc: MissionDocument) => Effect.gen(function* () {
    const proof = identity(doc)
    qualified.delete(proof.key)
    if (!proof.descriptor) { qualified.add(proof.key); return }
    if (Option.isNone(schedules) || Option.isNone(sessions)) throw new Error("Scheduled passage native capabilities unavailable")
    const schedule = schedules.value as MissionAutomationReader
    const session = sessions.value as { get(id: string): NativeEffect }
    if (!Predicate.isFunction(schedule.get) || !Predicate.isFunction(schedule.enabled) || !Predicate.isFunction(session.get))
      throw new Error("Scheduled passage native capabilities unavailable")
    const id = missionAutomationID(proof.descriptor.scheduleID!)
    const info = yield* schedule.get(id).pipe(Effect.flatMap(readMissionAutomation))
    const carrier = yield* session.get(proof.descriptor.sessionID).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(Session.Info))))
    const code = missionCodeWake(info)
    if (!code) yield* assertNativeScheduleProviderAvailable(ctx, proof.owner.installation)
    if (info.id !== id || info.status !== "active" || info.nextDueAt === undefined || !matchMissionAutomation(info, proof.descriptor,
      { directory: ctx.location.directory, projectID: doc.projectID }, NATIVE_SCHEDULE_CARRIER_SIGNAL)
      || carrier.id !== proof.descriptor.sessionID || carrier.parentID
      || carrier.projectID !== doc.projectID || carrier.location.directory !== ctx.location.directory
      || carrier.location.workspaceID !== ctx.location.workspaceID
      || !(code ? isAllowedScheduleCarrierModel(carrier.model) : isLegacyScheduleCarrierModel(carrier.model))
      || canonicalAuthority(carrier.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER])
        !== canonicalAuthority({ missionID: doc.id, timeGeneration: doc.timeGeneration, role: "reconciliation", slot: 0 }))
      throw new Error("Scheduled passage auxiliary differs")
    const flag = schedule.enabled(ctx.location.directory)
    if (!Effect.isEffect(flag) || (yield* flag) !== true) throw new Error("Scheduled passage native flag disabled")
    identity(doc); current()
    qualified.add(proof.key)
  })
  return { prepare, assertCurrent }
})
