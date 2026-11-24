import type { Plugin } from "@opencode/plugin/effect"
import type { Effect } from "effect"
import type { MissionDocument } from "../../missions/mission-document"
import { createNativeScheduleTransport } from "./native-schedule-transport"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeSchedulePreflight } from "./native-mission-schedule-preflight"
import { readNativeScheduleCarrierOwnership, claimNativeScheduleCarrierWake, nativeScheduleClaimKey,
  type NativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { dispatchNativeMissionScheduleWake, nativeMissionSchedulePriorHeld, parseNativeMissionScheduleClaim } from "./native-mission-schedule-wake-dispatch"

type Run = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>

/** Caller-side wake dispatch for Code Mode: status,
 * durable claim and wake through the own-process transport. `fresh` rereads the Mission. */
export function nativeMissionScheduleDispatcher(ctx: Plugin.Context, original: MissionDocument, ports: {
  run: Run; current(): true; signal: AbortSignal; fresh(): Promise<MissionDocument | undefined>
}) {
  const transport = createNativeScheduleTransport(), { run, current } = ports
  const dispatch = async (wake: NativeScheduleWake) => {
    current()
    return dispatchNativeMissionScheduleWake({ wake, registrationFile: original.calendarOwner!.installation.registrationFile,
      directory: ctx.location.directory, signal: ports.signal }, { transport, current,
      held: async () => {
        const doc = await ports.fresh()
        if (!doc) return true
        return nativeMissionSchedulePriorHeld(parseNativeMissionScheduleClaim(await run(ctx.storage.get(nativeScheduleClaimKey(ctx, doc.id))), doc.id), doc, wake)
      },
      claim: async (incarnation, preflight, retry) => {
        assertNativeSchedulePreflight(preflight, wake, incarnation.id)
        const readAuxiliaryIntent = async (): Promise<NativeScheduleCarrierBinding | undefined> => {
          assertNativeSchedulePreflight(preflight, wake, incarnation.id); current()
          const owned = await run(readNativeScheduleCarrierOwnership(ctx, wake.sessionID)), doc = owned?.document
          const slot = doc?.calendarOwner?.slots.find(item => item.role === "reconciliation" && item.sessionID === wake.sessionID
            && item.timeGeneration === wake.generation && item.creation !== "prepared" && !item.ambiguous.length
            && (item.scheduleID === null || item.scheduleID === wake.scheduleID))
          if (!owned?.verified || !doc || doc.timeGeneration !== wake.generation || !slot) return undefined
          // The positive, signed own-process preflight validated the exact row
          // and occurrence. Only plain current intent data crosses this boundary.
          return { document: doc, calendar: doc.calendars.find(item => item.sessionID === wake.sessionID) ?? { role: "reconciliation", slot: 0,
            timeGeneration: wake.generation, sessionID: wake.sessionID, scheduleID: wake.scheduleID, highWater: 0, pendingWake: null, wakePreparing: null } }
        }
        return claimNativeScheduleCarrierWake(ctx, wake, incarnation, run, current, readAuxiliaryIntent, retry)
      } })
  }
  return { transport, dispatch }
}
