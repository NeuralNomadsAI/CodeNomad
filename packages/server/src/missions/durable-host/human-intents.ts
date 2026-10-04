import { authorityDigest, rejectAuthority, type SignedAuthorityIntent } from "../authority-protocol"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"

/** Ephemeral request correlation, not authorization, a dispatcher or a retry map.
 * Exact signed contracts only; captured leases never borrow a later retry. */
export class HumanIntentLeases {
  private readonly leases = new Map<string, { current(): true; settled: boolean }>()
  constructor(private readonly limit = 128) {}

  async run<T>(signed: SignedAuthorityIntent, signal: AbortSignal, guard: () => true,
    operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    assertSynchronousAuthorityGuard(guard, "policy-unqualified")
    const digest = authorityDigest(signed)
    if (this.leases.has(digest)) rejectAuthority("request-conflict")
    if (this.leases.size >= this.limit) rejectAuthority("capacity")
    const lease = { settled: false, current: (): true => {
      signal.throwIfAborted()
      if (lease.settled) rejectAuthority("authorization-blocked")
      return assertSynchronousAuthorityGuard(guard, "policy-unqualified")
    } }
    this.leases.set(digest, lease)
    try { return await operation() }
    finally { lease.settled = true; if (this.leases.get(digest) === lease) this.leases.delete(digest) }
  }

  /** Capture synchronously at native RPC entry, BEFORE any plugin await. A
   * missing scope stays denied even if the same contract is registered later. */
  capture(signed: SignedAuthorityIntent): () => true {
    const lease = this.leases.get(authorityDigest(signed))
    return () => {
      if (!lease) rejectAuthority("authorization-blocked")
      return lease.current()
    }
  }
}
