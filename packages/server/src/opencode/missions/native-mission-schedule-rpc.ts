import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import { documentID, nativeDocumentID } from "../../missions/launch-policy"
import { nativeMissionScheduleResult } from "./native-mission-schedule-result"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { nativeInvocation } from "./native-invocation"
import { nativeScheduleCarrierLookupKey } from "./native-schedule-carrier-binding"
import type { NativeScheduleArtifacts } from "./native-schedule-installation"
import { acquireNativeMissionScheduleAuthority, NATIVE_MISSION_SCHEDULE_CONTROL_TIMEOUT_MS } from "./native-mission-schedule-authority"
import { controlNativeMissionSchedule } from "./native-mission-schedule-control"

const readInput = z.object({ missionID: documentID, requestID: z.string().min(1).max(128).optional() }).strict()
const carrierInput = z.object({ sessionID: nativeDocumentID }).strict()

/** Every method acquires its own RPC graph. Public KV reads remain available
 * independently of the private calendar capability and desktop presence. */
export function nativeMissionScheduleHandlers(ctx: Plugin.Context, artifacts?: NativeScheduleArtifacts) {
  const invocation = nativeInvocation(NATIVE_MISSION_SCHEDULE_CONTROL_TIMEOUT_MS)
  return {
    scheduleRead: (raw: unknown) => invocation.capture(Effect.gen(function* () {
      const { missionID, requestID } = readInput.parse(raw)
      const doc = yield* Effect.tryPromise({ try: () => invocation.check(run => {
        const store = new NativeMissionDocumentStore({ get: key => run(ctx.storage.get(key)),
          compareAndSet: async () => { throw new Error("schedule-read-only") } }, ctx.location.project.id, ctx.location.project.canonical)
        return store.read(missionID)
      }), catch: error => error })
      return yield* Effect.tryPromise(() => invocation.check(run => nativeMissionScheduleResult(ctx, doc, run, false, requestID)))
    }).pipe(Effect.orDie)),
    scheduleCarrierRead: (raw: unknown) => Effect.gen(function* () {
      const { sessionID } = carrierInput.parse(raw)
      const reservation = yield* ctx.storage.get(nativeScheduleCarrierLookupKey(ctx, sessionID))
      // An owned reverse reservation keeps its target protected throughout arm,
      // replacement and cleanup, including when session metadata is altered.
      return { owned: reservation !== undefined }
    }).pipe(Effect.orDie),
    scheduleControl: (raw: unknown) => invocation.capture(Effect.gen(function* () {
      return yield* Effect.tryPromise({ try: () => invocation.check(run => run(Effect.scoped(Effect.gen(function* () {
        const authority = yield* acquireNativeMissionScheduleAuthority(ctx, raw, run)
        return yield* controlNativeMissionSchedule(ctx, authority, artifacts, run)
      })))), catch: error => error })
    }).pipe(Effect.orDie)),
  }
}
