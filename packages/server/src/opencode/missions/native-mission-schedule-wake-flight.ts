import { nativeScheduleWakeKey, type NativeScheduleWake } from "./native-schedule-transport-contract"
import { sameNativeScheduleIncarnation, type NativeScheduleIncarnation } from "./native-schedule-transport-identity"

// Receivers of every bundle incarnation in this process share one registry.
const symbol = Symbol.for("codenomad.missions.native-schedule-wake.receivers")
const host = globalThis as typeof globalThis & { [symbol]?: Map<string, number> }
const receivers = host[symbol] ??= new Map<string, number>()

/** Registers a wake receiver for the lifetime of its own Promise, which can
 * outlive the HTTP request that started it. Registration precedes any await. */
export async function receivingNativeScheduleWake<T>(wake: NativeScheduleWake, work: () => Promise<T>): Promise<T> {
  const key = nativeScheduleWakeKey(wake)
  receivers.set(key, (receivers.get(key) ?? 0) + 1)
  try { return await work() }
  finally {
    const count = (receivers.get(key) ?? 1) - 1
    if (count > 0) receivers.set(key, count)
    else receivers.delete(key)
  }
}

export const nativeScheduleWakeReceiving = (wake: NativeScheduleWake) => receivers.has(nativeScheduleWakeKey(wake))

/** An unsettled claim on this exact wake whose receiver ended. Callers first prove
 * the run is unconsumed (calendar high-water below it). A receiver of another
 * incarnation fails its incarnation guard before every CAS; one of this process
 * is registered for its whole lifetime and also fails once its signed preflight
 * expires. Such a dispatch left no technical effect, so its original identity may
 * be dispatched again. */
export function nativeScheduleClaimAbandoned(claim: { key: string; incarnation: NativeScheduleIncarnation; settled?: unknown },
  wake: NativeScheduleWake, incarnation: NativeScheduleIncarnation): boolean {
  return claim.key === nativeScheduleWakeKey(wake) && claim.settled === undefined
    && (!sameNativeScheduleIncarnation(claim.incarnation, incarnation) || !nativeScheduleWakeReceiving(wake))
}
