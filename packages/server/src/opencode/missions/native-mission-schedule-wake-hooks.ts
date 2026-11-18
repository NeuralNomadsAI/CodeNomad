import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { nativeScheduleCarrierHooks } from "./native-schedule-carrier"
import { readNativeScheduleCarrierOwnership, NATIVE_SCHEDULE_CARRIER_SIGNAL, type NativeScheduleCarrierOwnership } from "./native-schedule-carrier-binding"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"
import { nativeMissionScheduleWakeContext } from "./native-mission-schedule-wake-context"
import { nativeMissionSchedulePreparePrompt } from "./native-mission-schedule-wake-prepare"

/** Maintenance hooks use broad exact ownership, including retiring and attempted
 * descriptors. Only the context/RPC path decides whether a wake may advance. */
export const registerNativeMissionScheduleCarrierHooks = Effect.fn("missions.registerScheduleCarrierHooks")(function* (ctx: Plugin.Context,
  remember?: (sessionID: string, ownership: NativeScheduleCarrierOwnership) => void) {
  const hooks = nativeScheduleCarrierHooks(() => true)
  const owns = (sessionID: string) => readNativeScheduleCarrierOwnership(ctx, sessionID).pipe(Effect.map(ownership => {
    if (ownership && !ownership.verified || !ownership && sessionID.startsWith(MISSION_SCHEDULE_CARRIER_SESSION_PREFIX))
      throw new Error("schedule-carrier-ownership")
    if (ownership?.verified) remember?.(sessionID, ownership)
    return ownership
  }), Effect.orDie)
  yield* ctx.aisdk.hook("language", event => Effect.sync(() => hooks.language(event)))
  yield* ctx.session.hook("title", event => Effect.gen(function* () { if (yield* owns(event.sessionID)) hooks.title(event) }))
  yield* ctx.session.hook("compaction", event => Effect.gen(function* () { if (yield* owns(event.sessionID)) hooks.compaction(event) }))
  yield* ctx.session.hook("http.request", event => Effect.gen(function* () { if (yield* owns(event.sessionID)) hooks.httpRequest(event) }))
  yield* ctx.session.hook("prompt", event => Effect.gen(function* () {
    const ownership = yield* owns(event.sessionID)
    if (!ownership) return
    const value = event.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
    if (typeof value?.id !== "string" || !Number.isSafeInteger(value.run) || Number(value.run) < 1 || !Number.isSafeInteger(value.dueAt)
      || Number(value.dueAt) < 0 || typeof value.late !== "boolean" || event.messageID !== `msg_${value.id}_${value.run}`
      || event.prompt.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL) throw new Error("schedule-carrier-prompt")
    const owner = ownership.document!.calendarOwner
    const slots = [...owner?.slots ?? [], ...owner?.retired.map(item => item.descriptor) ?? []]
    if (!slots.some(slot => slot.sessionID === event.sessionID && (slot.scheduleID === value.id || slot.creation === "attempted" && slot.scheduleID === null)))
      throw new Error("schedule-carrier-prompt-mapping")
    if (ownership.reference.role === "principal") yield* nativeMissionSchedulePreparePrompt(ctx, event)
  }))
  yield* ctx.session.hook("context", event => Effect.gen(function* () {
    const ownership = yield* owns(event.sessionID)
    if (!ownership) return
    hooks.context(event)
    yield* nativeMissionScheduleWakeContext(ctx, event)
  }))
})
