import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { nativeScheduleCarrierLookupKey, nativeScheduleCarrierReferenceSchema, type NativeScheduleCarrierOwnership } from "./native-schedule-carrier-binding"
import { sendNativeMissionScheduleMaintenance, type NativeMissionScheduleIdleHint } from "./native-mission-schedule-wake-maintenance"

const types = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const

/** Bounded pure-data cache learned by live ownership hooks. Setup never acquires
 * Database/Session/Schedule. A fresh receiver resolves unavailable setup KV. */
export const registerNativeMissionScheduleIdleHints = Effect.fn("missions.registerScheduleIdleHints")(function* (
  ctx: Plugin.Context, send = sendNativeMissionScheduleMaintenance, settle: Effect.Effect<void> = Effect.sleep("3 seconds"),
) {
  const learned = new Map<string, NativeMissionScheduleIdleHint>(), pending = new Set<string>()
  let active = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false; learned.clear() }))
  const remember = (sessionID: string, ownership: NativeScheduleCarrierOwnership) => {
    const doc = ownership.document
    if (!active || !ownership.verified || !doc?.calendarOwner) return
    if (!learned.has(sessionID) && learned.size >= 128) learned.delete(learned.keys().next().value!)
    learned.set(sessionID, Object.freeze({ sessionID, missionID: doc.id, timeGeneration: ownership.reference.timeGeneration,
      directory: ctx.location.directory, registrationFile: doc.calendarOwner.installation.registrationFile }))
  }
  const trigger = (sessionID: string) => Effect.suspend(() => {
    const hint = learned.get(sessionID)
    if (!active || !hint || pending.has(hint.missionID) || pending.size >= 128) return Effect.void
    pending.add(hint.missionID)
    return Effect.gen(function* () {
      yield* settle // Native terminal publications can precede Session.active removal.
      if (!active) return
      const observed = yield* Effect.suspend((): Effect.Effect<{ available: boolean; value?: unknown }, unknown> => {
        if (typeof ctx.storage?.get !== "function") return Effect.succeed({ available: false })
        const read = ctx.storage.get(nativeScheduleCarrierLookupKey(ctx, sessionID))
        return Effect.isEffect(read) ? read.pipe(Effect.map(value => ({ available: true, value }))) : Effect.succeed({ available: false })
      }).pipe(Effect.catchCause(() => Effect.succeed({ available: false, value: undefined })))
      if (observed.available) {
        const index = nativeScheduleCarrierReferenceSchema.safeParse(observed.value)
        if (!index.success || index.data.missionID !== hint.missionID || index.data.timeGeneration !== hint.timeGeneration) return
      }
      // Public KV can be unavailable in the setup event graph. The learned data
      // merely targets the fixed RPC; that fresh receiver always rechecks ownership.
      if (!active) return
      yield* Effect.tryPromise({ try: signal => send(hint, signal), catch: () => new Error("schedule-idle-hint-unavailable") })
    }).pipe(Effect.catchCause(() => Effect.void), Effect.ensuring(Effect.sync(() => { pending.delete(hint.missionID) })),
      Effect.forkScoped, Effect.asVoid)
  })
  if (typeof ctx.event?.subscribe === "function") yield* Effect.suspend(() => {
    const events = ctx.event.subscribe({ types })
    if (!Stream.isStream(events)) return Effect.void
    return events.pipe(Stream.runForEach(event => {
      if (!types.includes(event.type as typeof types[number]) || !event.data || typeof event.data.sessionID !== "string"
        || event.location && (event.location.directory !== ctx.location.directory || event.location.workspaceID !== ctx.location.workspaceID)) return Effect.void
      return trigger(event.data.sessionID)
    }), Effect.catchCause(() => Effect.void), Effect.forkScoped, Effect.asVoid)
  }).pipe(Effect.catchCause(() => Effect.void))
  return { remember }
})
