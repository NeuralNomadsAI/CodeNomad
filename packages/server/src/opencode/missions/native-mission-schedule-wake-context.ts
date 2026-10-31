import type { Plugin } from "@opencode/plugin/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import type { MissionDocument, MissionWake } from "../../missions/mission-document"
import { missionDocumentChanges } from "../../missions/mission-document-state"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { nativeInvocation } from "./native-invocation"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { acquireNativeMissionScheduleWakeReader } from "./native-mission-schedule-wake-reader"
import { nativeScheduleCarrierWakes, nativeScheduleCarrierNonWakeMessageIDs } from "./native-schedule-carrier"
import { assertNativeScheduleCarrierArtifacts, readNativeScheduleCarrierOwnership, claimNativeScheduleCarrierWake,
  nativeScheduleClaimKey, type NativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { createNativeScheduleTransport } from "./native-schedule-transport"
import { nativeScheduleWakeIdentity, type NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeSchedulePreflight } from "./native-mission-schedule-preflight"
import { dispatchNativeMissionScheduleWake, nativeMissionSchedulePriorHeld, parseNativeMissionScheduleClaim } from "./native-mission-schedule-wake-dispatch"

/** One local technical turn only retains public facade closures between HTTP
 * calls. Every native preflight/wake is reacquired by the receiving RPC. */
export function nativeMissionScheduleWakeContext(ctx: Plugin.Context, event: SessionContext) {
  const invocation = nativeInvocation()
  return Effect.scoped(invocation.capture(Effect.gen(function* () {
    const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
    const ownership = yield* readNativeScheduleCarrierOwnership(ctx, event.sessionID), original = ownership?.document
    if (!ownership?.verified || !original?.calendarOwner) throw new Error("schedule-context-owner")
    const store = yield* acquireNativeMissionDocumentStore(ctx, run), reader = yield* acquireNativeMissionScheduleWakeReader(ctx, run)
    const transport = createNativeScheduleTransport(), abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 8000)
    yield* Effect.addFinalizer(() => Effect.sync(() => { clearTimeout(timer); abort.abort() }))
    const current = (): true => {
      abort.signal.throwIfAborted(); reader.current()
      assertNativeScheduleCarrierArtifacts(original.calendarOwner!.installation)
      return assertMissionCalendarPlacement(original.calendarOwner!.placement, original.configuration.roots)
    }
    const fresh = async (): Promise<MissionDocument | undefined> => {
      const doc = await store.read(original.id)
      return doc && !("deletedAt" in doc) ? doc : undefined
    }
    const prepare = async (wake: NativeScheduleWake, proof: MissionWake) => store.withExclusion(async locked => {
      current()
      const doc = await locked.read(wake.missionID)
      if (!doc || "deletedAt" in doc || doc.timeGeneration !== wake.generation) return
      const calendar = doc.calendars.find(item => item.sessionID === wake.sessionID && item.scheduleID === wake.scheduleID)
      if (!calendar || calendar.role !== "principal" || calendar.highWater >= wake.run || calendar.wakePreparing) return
      if (doc.pending || doc.synchronization || doc.calendarOwner?.operation.pending || doc.blocked || doc.deletion || doc.state !== "running") return
      await locked.change(doc.id, doc.revision, current, value => missionDocumentChanges.prepareWake(value, proof))
    })
    const dispatch = async (wake: NativeScheduleWake) => {
      current()
      return dispatchNativeMissionScheduleWake({ wake, registrationFile: original.calendarOwner!.installation.registrationFile,
        directory: ctx.location.directory, signal: abort.signal }, { transport, current,
        held: async () => {
          const doc = await fresh()
          if (!doc) return true
          return nativeMissionSchedulePriorHeld(parseNativeMissionScheduleClaim(await run(ctx.storage.get(nativeScheduleClaimKey(ctx, doc.id))), doc.id), doc, wake)
        },
        claim: async (incarnation, preflight) => {
          assertNativeSchedulePreflight(preflight, wake, incarnation.id)
          const readAuxiliaryIntent = async (): Promise<NativeScheduleCarrierBinding | undefined> => {
            assertNativeSchedulePreflight(preflight, wake, incarnation.id); current()
            const owned = await run(readNativeScheduleCarrierOwnership(ctx, wake.sessionID)), doc = owned?.document
            const slot = doc?.calendarOwner?.slots.find(item => item.role === "reconciliation" && item.sessionID === wake.sessionID
              && item.timeGeneration === wake.generation && item.creation !== "prepared" && !item.ambiguous.length
              && (item.scheduleID === null || item.scheduleID === wake.scheduleID))
            if (!owned?.verified || !doc || doc.timeGeneration !== wake.generation || !slot) return undefined
            // The positive, signed own-process preflight validated the exact row
            // and message. Only plain current intent data crosses this boundary.
            return { document: doc, calendar: doc.calendars.find(item => item.sessionID === wake.sessionID) ?? { role: "reconciliation", slot: 0,
              timeGeneration: wake.generation, sessionID: wake.sessionID, scheduleID: wake.scheduleID, highWater: 0, pendingWake: null, wakePreparing: null } }
          }
          return claimNativeScheduleCarrierWake(ctx, wake, incarnation, run, current, readAuxiliaryIntent)
        } })
    }
    const descriptor = original.calendarOwner.slots.find(item => item.sessionID === event.sessionID && item.timeGeneration === original.timeGeneration)
    if (!descriptor) return // Retiring carriers stay local, without autonomous admission.
    const calendar = original.calendars.find(item => item.sessionID === event.sessionID)
    let scheduleID = calendar?.scheduleID ?? descriptor.scheduleID
    if (!scheduleID) {
      const ids = new Set(event.messages.filter(message => message.role === "user").map(message =>
        (message as { metadata?: { schedule?: { id?: unknown } } }).metadata?.schedule?.id).filter((id): id is string => typeof id === "string"))
      if (ids.size !== 1 || descriptor.role !== "reconciliation" || descriptor.creation !== "attempted") return
      scheduleID = [...ids][0]
    }
    const mapping = { missionID: original.id, generation: original.timeGeneration, sessionID: event.sessionID, scheduleID }
    const window = yield* ctx.session.context({ sessionID: event.sessionID })
    if (window.length > 128 || Buffer.byteLength(JSON.stringify(window)) > 1024 * 1024) throw new Error("schedule-context-coverage")
    const candidates = nativeScheduleCarrierWakes(mapping, calendar?.highWater ?? 0, event.messages, nativeScheduleCarrierNonWakeMessageIDs(window))
    const next = calendar?.highWater ?? 0
    const candidate = candidates[0] ?? { ...mapping, run: next + 1, messageID: `msg_${scheduleID}_${next + 1}` }
    yield* Effect.tryPromise(async () => {
      const proof = await reader.message(candidate)
      if (!proof) return
      if (descriptor.role === "principal") await prepare(candidate, proof)
      const result = await dispatch(nativeScheduleWakeIdentity(candidate))
      if (descriptor.role !== "reconciliation" || result.state !== "received" || result.reply.state !== "applied") return
      // A fresh auxiliary turn recovers only original next principal identities.
      // Previously dispatched identities remain status-only in dispatch().
      const doc = await fresh()
      for (const principal of doc?.calendars.filter(item => item.role === "principal").slice(0, 8) ?? []) {
        current()
        const run = principal.wakePreparing?.run ?? principal.highWater + 1
        const wake = { missionID: doc!.id, generation: principal.timeGeneration, sessionID: principal.sessionID,
          scheduleID: principal.scheduleID, run, messageID: `msg_${principal.scheduleID}_${run}` }
        const proof = await reader.message(wake)
        if (!proof) continue
        await prepare(wake, proof)
        await dispatch(wake)
      }
    }).pipe(Effect.catchCause(() => Effect.void)) // Durable preparation/claim retain uncertainty for later native wakes.
  })).pipe(Effect.orDie))
}
