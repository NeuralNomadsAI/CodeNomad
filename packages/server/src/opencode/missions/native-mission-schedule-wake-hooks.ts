import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { nativeScheduleCarrierHooks } from "./native-schedule-carrier"
import { readNativeScheduleCarrierOwnership, type NativeScheduleCarrierOwnership } from "./native-schedule-carrier-binding"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../../missions/mission-schedule-carrier-identity"

/** Maintenance hooks use broad exact ownership, including retiring and attempted
 * descriptors. Only the Code Mode RPC path decides whether a wake may advance. */
export const registerNativeMissionScheduleCarrierHooks = Effect.fn("missions.registerScheduleCarrierHooks")(function* (ctx: Plugin.Context,
  remember?: (sessionID: string, ownership: NativeScheduleCarrierOwnership) => void) {
  const hooks = nativeScheduleCarrierHooks(() => true)
  const owns = (sessionID: string) => readNativeScheduleCarrierOwnership(ctx, sessionID).pipe(Effect.map(ownership => {
    if (ownership && !ownership.verified || !ownership && sessionID.startsWith(MISSION_SCHEDULE_CARRIER_SESSION_PREFIX))
      throw new Error("schedule-carrier-ownership")
    if (ownership?.verified) remember?.(sessionID, ownership)
    return ownership
  }), Effect.orDie)
  yield* ctx.session.hook("title", event => Effect.gen(function* () { if (yield* owns(event.sessionID)) hooks.title(event) }))
  yield* ctx.session.hook("compaction", event => Effect.gen(function* () { if (yield* owns(event.sessionID)) hooks.compaction(event) }))
  yield* ctx.session.hook("http.request", event => Effect.gen(function* () { if (yield* owns(event.sessionID)) hooks.httpRequest(event) }))
  yield* ctx.session.hook("prompt", event => Effect.gen(function* () {
    if (yield* owns(event.sessionID)) throw new Error("schedule-carrier-prompt")
  }))
  yield* ctx.session.hook("context", event => Effect.gen(function* () {
    if (yield* owns(event.sessionID)) throw new Error("schedule-carrier-context")
  }))
})
