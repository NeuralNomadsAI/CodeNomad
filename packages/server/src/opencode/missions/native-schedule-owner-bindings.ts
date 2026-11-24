import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { closeNativeScheduleCarrierClaimLocked, registerNativeScheduleCarrierLookupLocked, removeNativeScheduleCarrierLookupLocked,
  readNativeScheduleCarrierOwnership, assertNativeScheduleCarrierArtifacts, type NativeScheduleCarrierBinding } from "./native-schedule-carrier-binding"
import { nativeScheduleCalendarMatches, type NativeScheduleCalendarService } from "./native-schedule-calendar-service"
import { assertNativeScheduleWake, type NativeScheduleWake } from "./native-schedule-transport-contract"
import { missionCodeWakeRunning } from "./native-mission-automation"

export interface NativeScheduleOwnerBindings {
  register(locked: NativeMissionDocumentStore, missionID: string, slot: MissionCalendarOwnerSlot, current: () => true): Promise<void>
  remove(locked: NativeMissionDocumentStore, missionID: string, slot: MissionCalendarOwnerSlot, current: () => true): Promise<void>
  close(locked: NativeMissionDocumentStore, missionID: string, current: () => true): Promise<boolean>
  readAuxiliaryWake(wake: NativeScheduleWake, native: NativeScheduleCalendarService, current: () => true): Promise<NativeScheduleCarrierBinding | undefined>
}

/** Read-only own-process RPC preflight for a current auxiliary, including a
 * dispatched create whose ACK was lost. The row and live program qualify its run. */
export async function readNativeScheduleAuxiliaryWakeBinding(ctx: Plugin.Context, wake: NativeScheduleWake, native: NativeScheduleCalendarService,
  run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>, current: () => true): Promise<NativeScheduleCarrierBinding | undefined> {
  assertNativeScheduleWake(wake)
  const guard = () => { native.assertCurrent(); assertSynchronousAuthorityGuard(current, "policy-unqualified") }
  guard()
  const ownership = await run(readNativeScheduleCarrierOwnership(ctx, wake.sessionID)), doc = ownership?.document
  if (!ownership?.verified || !doc || doc.id !== wake.missionID || ownership.reference.role !== "reconciliation"
    || ownership.reference.timeGeneration !== doc.timeGeneration || wake.generation !== doc.timeGeneration) return undefined
  const slot = doc.calendarOwner?.slots.find(item => item.sessionID === wake.sessionID && item.role === "reconciliation"
    && item.timeGeneration === doc.timeGeneration && item.creation !== "prepared" && !item.ambiguous.length)
  if (!slot || slot.scheduleID !== null && slot.scheduleID !== wake.scheduleID) return undefined
  assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots)
  assertNativeScheduleCarrierArtifacts(doc.calendarOwner!.installation)
  // Final read: ownership and the row together, then synchronous checks only.
  const [fresh, list] = await Promise.all([run(readNativeScheduleCarrierOwnership(ctx, wake.sessionID)),
    native.list({ missionID: doc.id, descriptor: slot }, current)])
  guard()
  const row = list.length === 1 && list[0].id === wake.scheduleID && nativeScheduleCalendarMatches(list[0], slot) ? list[0] : undefined
  if (!row || !fresh?.verified || fresh.document?.revision !== doc.revision
    || canonicalAuthority(fresh.reference) !== canonicalAuthority(ownership.reference)) return undefined
  if (!row.code) throw new Error("schedule-calendar-requires-code")
  // An uncounted run must be live in this process.
  if (row.runCount < wake.run && !(row.runCount === wake.run - 1 && missionCodeWakeRunning(wake.scheduleID, wake.run))) return undefined
  assertMissionCalendarPlacement(doc.calendarOwner!.placement, doc.configuration.roots)
  const calendar = doc.calendars.find(item => item.sessionID === slot.sessionID)
  if (calendar && (calendar.scheduleID !== wake.scheduleID || calendar.role !== "reconciliation" || calendar.timeGeneration !== doc.timeGeneration)) return undefined
  return { document: doc, calendar: calendar ?? { role: "reconciliation", slot: 0, timeGeneration: doc.timeGeneration,
    sessionID: slot.sessionID, scheduleID: wake.scheduleID, highWater: 0, pendingWake: null, wakePreparing: null } }
}
export function nativeScheduleOwnerBindings(ctx: Plugin.Context, run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>): NativeScheduleOwnerBindings {
  const reference = (missionID: string, slot: MissionCalendarOwnerSlot) => ({ missionID, timeGeneration: slot.timeGeneration, role: slot.role, slot: slot.slot })
  return {
    register: (locked, id, slot, current) => registerNativeScheduleCarrierLookupLocked(ctx, slot.sessionID, reference(id, slot), run, current, locked),
    remove: (locked, id, slot, current) => removeNativeScheduleCarrierLookupLocked(ctx, slot.sessionID, reference(id, slot), run, current, locked),
    close: (locked, id, current) => closeNativeScheduleCarrierClaimLocked(ctx, id, run, current, locked),
    readAuxiliaryWake: (wake, native, current) => readNativeScheduleAuxiliaryWakeBinding(ctx, wake, native, run, current),
  }
}
