import { canonicalAuthority } from "../../missions/authority-protocol"
import type { MissionDocument } from "../../missions/mission-document"
import { assertNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import type { NativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { assertNativeScheduleWake, nativeScheduleWakeKey } from "./native-schedule-transport-contract"
import type { NativeScheduleWake, NativeSchedulePreflight } from "./native-schedule-transport-contract"
import type { createNativeScheduleTransport, NativeScheduleTransportResult } from "./native-schedule-transport"

export type NativeMissionScheduleClaim = { version: 1; key: string; wake: NativeScheduleWake; incarnation: NativeScheduleIncarnation;
  settled?: { revision: number; highWater: number } }
export function parseNativeMissionScheduleClaim(raw: unknown, missionID: string): NativeMissionScheduleClaim | undefined {
  if (raw === undefined) return undefined
  canonicalAuthority(raw, 32 * 1024)
  const claim = raw as NativeMissionScheduleClaim
  assertNativeScheduleWake(claim?.wake); assertNativeScheduleIncarnation(claim.incarnation)
  if (claim.version !== 1 || claim.wake.missionID !== missionID || claim.key !== nativeScheduleWakeKey(claim.wake)
    || claim.settled !== undefined && (!claim.settled || !Number.isSafeInteger(claim.settled.revision) || claim.settled.revision < 0
      || !Number.isSafeInteger(claim.settled.highWater) || claim.settled.highWater < claim.wake.run)) throw new Error("schedule-claim-invalid")
  return claim
}
export function nativeMissionSchedulePriorHeld(claim: NativeMissionScheduleClaim | undefined, doc: MissionDocument, wake: NativeScheduleWake): boolean {
  if (!claim) return false
  if (claim.key === nativeScheduleWakeKey(wake)) return true
  if (claim.settled) return claim.settled.revision > doc.revision || claim.wake.generation > doc.timeGeneration
  return ![...doc.calendars, ...doc.synchronization?.retiredCalendars ?? []].some(calendar => calendar.scheduleID === claim.wake.scheduleID
    && calendar.sessionID === claim.wake.sessionID && calendar.timeGeneration === claim.wake.generation && calendar.highWater >= claim.wake.run)
}

/** One outer deadline includes read-only preflight and the original dispatch.
 * A previous exact/unknown claim stays status-only, including across reloads. */
export async function dispatchNativeMissionScheduleWake(input: { wake: NativeScheduleWake; registrationFile: string; directory: string; signal?: AbortSignal },
  ports: { transport: ReturnType<typeof createNativeScheduleTransport>; current(): true; held(): Promise<boolean>;
    claim(incarnation: NativeScheduleIncarnation, preflight: NativeSchedulePreflight): Promise<boolean> }): Promise<NativeScheduleTransportResult> {
  const abort = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal
  const timer = setTimeout(() => abort.abort(), 8000)
  const request = { ...input, signal }
  let attempted = false
  try {
    ports.current(); signal.throwIfAborted()
    const status = await ports.transport.status(request)
    ports.current(); signal.throwIfAborted()
    if (status.state !== "received" || status.reply.state === "applied" || !status.reply.messagePresent
      || !status.reply.ready || !status.reply.preflight || await ports.held()) return status
    ports.current(); signal.throwIfAborted()
    const preflight = status.reply.preflight
    attempted = true
    return await ports.transport.wake({ ...request, preflight,
      claim: incarnation => { ports.current(); signal.throwIfAborted(); return ports.claim(incarnation, preflight) } })
  } catch { return { state: attempted ? "uncertain" : "not-dispatched", reason: signal.aborted ? "deadline" : "unavailable" } }
  finally { clearTimeout(timer) }
}
