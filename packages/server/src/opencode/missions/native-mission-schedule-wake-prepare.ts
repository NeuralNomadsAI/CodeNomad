import type { Plugin } from "@opencode/plugin/effect"
import type { SessionPrompt } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionDocumentStore, type NativeMissionDocumentRunner } from "./native-mission-document-storage"
import { assertNativeScheduleCarrierArtifacts, readNativeScheduleCarrierOwnership, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { assertNativeScheduleWake } from "./native-schedule-transport-contract"
import { missionWakeMessageID, missionWakeMetadata, sameMissionAutomation } from "./native-mission-automation"

/** Native prompt entry is the pre-inbox proof. Serialize with Pause/configure
 * before returning to native Session.prompt, without requiring a later run ACK. */
export async function prepareNativeMissionSchedulePrincipalPrompt(ctx: Plugin.Context, event: SessionPrompt,
  store: NativeMissionDocumentStore, run: NativeMissionDocumentRunner, current: () => true) {
  const sessionID = event.sessionID, messageID = event.messageID, text = event.prompt.text
  const metadata = missionWakeMetadata(structuredClone(event.metadata), messageID)
  return store.withExclusion(async locked => {
    current(); locked.assertActive()
    const owned = await run(readNativeScheduleCarrierOwnership(ctx, sessionID)), doc = owned?.document
    if (!owned?.verified || !owned.legacyModel || !doc?.calendarOwner || owned.reference.role !== "principal" || owned.reference.timeGeneration !== doc.timeGeneration)
      throw new Error("schedule-prompt-current-principal")
    if (!metadata || text !== NATIVE_SCHEDULE_CARRIER_SIGNAL)
      throw new Error("schedule-prompt-correlation")
    const fresh = await locked.read(doc.id)
    if (!fresh || "deletedAt" in fresh || fresh.revision !== doc.revision || fresh.state !== "running"
      || fresh.synchronization || fresh.deletion || fresh.blocked || fresh.calendarOwner?.operation.pending)
      throw new Error("schedule-prompt-control-barrier")
    const descriptor = fresh.calendarOwner?.slots.find(item => item.role === "principal" && item.sessionID === sessionID
      && item.scheduleID !== null && sameMissionAutomation(item.scheduleID, metadata.id)
      && item.creation === "adopted" && item.timeGeneration === fresh.timeGeneration)
    const calendar = fresh.calendars.find(item => item.role === "principal" && item.sessionID === sessionID && item.scheduleID === descriptor?.scheduleID)
    if (!descriptor || !calendar) throw new Error("schedule-prompt-mapping")
    const wake = { missionID: doc.id, generation: doc.timeGeneration, sessionID, scheduleID: calendar.scheduleID,
      run: metadata.run, messageID: missionWakeMessageID(calendar.scheduleID, metadata.run) }
    assertNativeScheduleWake(wake)
    const guard = (): true => {
      current(); locked.assertActive()
      assertNativeScheduleCarrierArtifacts(fresh.calendarOwner!.installation, { requireProvider: true })
      return assertMissionCalendarPlacement(fresh.calendarOwner!.placement, fresh.configuration.roots)
    }
    guard()
    return locked.change(fresh.id, fresh.revision, guard, value => missionDocumentChanges.prepareWake(value,
      { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: Number(metadata.dueAt) }))
  })
}

export function nativeMissionSchedulePreparePrompt(ctx: Plugin.Context, event: SessionPrompt) {
  const invocation = nativeInvocation()
  return Effect.scoped(invocation.capture(Effect.gen(function* () {
    const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
    const store = yield* acquireNativeMissionDocumentStore(ctx, run)
    let active = true
    yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
    return yield* Effect.tryPromise(() => prepareNativeMissionSchedulePrincipalPrompt(ctx, event, store, run,
      () => { if (!active) throw new Error("schedule-prompt-retired"); return true }))
  })).pipe(Effect.orDie))
}
