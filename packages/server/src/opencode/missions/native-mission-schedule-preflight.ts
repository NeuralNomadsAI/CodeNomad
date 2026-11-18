import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { NativeScheduleWake, NativeSchedulePreflight } from "./native-schedule-transport-contract"
import { nativeScheduleWakeKey } from "./native-schedule-transport-contract"

export type { NativeSchedulePreflight } from "./native-schedule-transport-contract"
const secretKey = Symbol.for("codenomad.missions.schedule-preflight/v1")
const host = globalThis as typeof globalThis & { [secretKey]?: Buffer }
const secret = host[secretKey] ??= randomBytes(32)
const sign = (wake: NativeScheduleWake, incarnation: string, cutoff: number, issuedAt: number) =>
  createHmac("sha256", secret).update(JSON.stringify(["schedule-preflight/v1", incarnation, nativeScheduleWakeKey(wake), cutoff, issuedAt])).digest("hex")

/** A pure-read preflight freezes the fan-in cutoff before taking a dispatch claim.
 * Its process-local receipt survives bundle reloads and carries no auth secret. */
export function nativeSchedulePreflight(wake: NativeScheduleWake, incarnation: string, cutoff: number, now = Date.now()): NativeSchedulePreflight {
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !Number.isSafeInteger(now)) throw new Error("schedule-preflight-invalid")
  return { cutoff, issuedAt: now, signature: sign(wake, incarnation, cutoff, now) }
}
export function assertNativeSchedulePreflight(value: NativeSchedulePreflight | undefined, wake: NativeScheduleWake, incarnation: string, now = Date.now()): number {
  if (!value || !Number.isSafeInteger(value.cutoff) || value.cutoff < 0 || !Number.isSafeInteger(value.issuedAt)
    || value.issuedAt > now + 5000 || now - value.issuedAt >= 8000 || !/^[a-f0-9]{64}$/.test(value.signature)
    || !timingSafeEqual(Buffer.from(value.signature, "hex"), Buffer.from(sign(wake, incarnation, value.cutoff, value.issuedAt), "hex")))
    throw new Error("schedule-preflight-invalid")
  return value.cutoff
}
