import { randomUUID } from "node:crypto"
import { NativeDeadline } from "./native-deadline"
import { HostError } from "./protocol"

interface Origin {
  signedDigest: string
  signal: AbortSignal
  channelSignal: AbortSignal
  assertOriginCurrent(): true
  assertChannelCurrent(): true
}
interface NativeInvocationControl {
  admit(invocation: Buffer): Promise<object>
  revoke(invocationID: string): void
  assertCurrent(lease: object): void
  invalidateChannel(): void
}
export interface NativeInvocationCorrelation { readonly invocationID: string; readonly signedDigest: string }
const deny = (): never => { throw new HostError("native-missions-human-invocation-refused") }

/** Local B-only correlation/lifecycle adapter. This function mints NO authority
 * or native capability and is not a producer/qualification seam. Production
 * calls it only with a nominal channel's captured native methods. Tests may
 * exercise lifecycle with an explicitly unqualified ledger. The HTTP guard and
 * cookies remain here; only a fresh invocation ID and signed digest are sent.
 * A revoke before admit settles must tombstone the invocation natively. */
export async function runNativeOriginInvocation<T>(origin: Origin, native: NativeInvocationControl,
  operation: (correlation: Readonly<NativeInvocationCorrelation>) => Promise<T>): Promise<T> {
  if (typeof origin.signedDigest !== "string" || !/^[a-f0-9]{64}$/.test(origin.signedDigest)) deny()
  const correlation = Object.freeze({ invocationID: randomUUID(), signedDigest: origin.signedDigest })
  let settled = false, revoked = false, revocationFailed = false
  const check = () => {
    origin.signal.throwIfAborted(); origin.channelSignal.throwIfAborted()
    if (settled || origin.assertChannelCurrent() !== true || origin.assertOriginCurrent() !== true) deny()
    origin.signal.throwIfAborted(); origin.channelSignal.throwIfAborted()
  }
  const assertNative = (lease: object) => { if (native.assertCurrent(lease) !== undefined) deny() }
  const revoke = () => {
    settled = true
    if (revoked) return
    revoked = true
    try { if (native.revoke(correlation.invocationID) !== undefined) deny() }
    catch {
      revocationFailed = true
      try { native.invalidateChannel() } catch { /* Disposal failure is still a refusal, never a successful lease settlement. */ }
    }
  }
  check()
  let abortAdmission: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    abortAdmission = () => { revoke(); reject(new HostError("native-missions-human-invocation-cancelled")) }
  })
  origin.signal.addEventListener("abort", abortAdmission!, { once: true })
  origin.channelSignal.addEventListener("abort", abortAdmission!, { once: true })
  try {
    check()
    const budget = new NativeDeadline(5_000, undefined, revoke)
    const admission = budget.observe(() => native.admit(Buffer.from(JSON.stringify(correlation))))
    const lease = await Promise.race([admission, aborted])
    check(); assertNative(lease)
    const result = await operation(correlation)
    check(); assertNative(lease)
    return result
  } finally {
    revoke()
    origin.signal.removeEventListener("abort", abortAdmission!)
    origin.channelSignal.removeEventListener("abort", abortAdmission!)
    if (revocationFailed) deny()
  }
}
