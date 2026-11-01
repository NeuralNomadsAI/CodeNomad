import type { Plugin } from "@opencode/plugin/effect"
import type { SessionPrompt } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionDocumentStore, type NativeMissionDocumentRunner } from "./native-mission-document-storage"
import { readNativeScheduleCarrierOwnership, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { assertNativeScheduleWake } from "./native-schedule-transport-contract"

/** Native prompt entry is the pre-inbox proof. Serialize with Pause/configure
 * before returning to native Session.prompt, without requiring a later run ACK. */
export async function prepareNativeMissionSchedulePrincipalPrompt(ctx: Plugin.Context, event: SessionPrompt,
  store: NativeMissionDocumentStore, run: NativeMissionDocumentRunner, current: () => true) {
  const sessionID = event.sessionID, messageID = event.messageID, text = event.prompt.text
  const metadata = structuredClone(event.metadata?.schedule) as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
  return store.withExclusion(async locked => {
    current(); locked.assertActive()
    const owned = await run(readNativeScheduleCarrierOwnership(ctx, sessionID)), doc = owned?.document
    if (!owned?.verified || !doc?.calendarOwner || owned.reference.role !== "principal" || owned.reference.timeGeneration !== doc.timeGeneration)
      throw new Error("schedule-prompt-current-principal")
    if (typeof metadata?.id !== "string" || !Number.isSafeInteger(metadata.run) || !Number.isSafeInteger(metadata.dueAt)
      || Number(metadata.dueAt) < 0 || typeof metadata.late !== "boolean" || text !== NATIVE_SCHEDULE_CARRIER_SIGNAL)
      throw new Error("schedule-prompt-correlation")
    const wake = { missionID: doc.id, generation: doc.timeGeneration, sessionID, scheduleID: metadata.id,
      run: Number(metadata.run), messageID }
    assertNativeScheduleWake(wake)
    const fresh = await locked.read(doc.id)
    if (!fresh || "deletedAt" in fresh || fresh.revision !== doc.revision || fresh.state !== "running"
      || fresh.synchronization || fresh.deletion || fresh.blocked || fresh.calendarOwner?.operation.pending)
      throw new Error("schedule-prompt-control-barrier")
    const descriptor = fresh.calendarOwner?.slots.find(item => item.role === "principal" && item.sessionID === sessionID
      && item.scheduleID === wake.scheduleID && item.creation === "adopted" && item.timeGeneration === fresh.timeGeneration)
    const calendar = fresh.calendars.find(item => item.role === "principal" && item.sessionID === sessionID && item.scheduleID === wake.scheduleID)
    if (!descriptor || !calendar) throw new Error("schedule-prompt-mapping")
    const guard = (): true => { current(); locked.assertActive(); return assertMissionCalendarPlacement(fresh.calendarOwner!.placement, fresh.configuration.roots) }
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
