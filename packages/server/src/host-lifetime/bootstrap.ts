import { createHash } from "node:crypto"
import { HostError } from "./protocol"
import type { AuthManager } from "../auth/manager"

/** Backend-only attachment bookkeeping over EXISTING AuthManager bootstrap auth.
 * Existing loopback bootstrap route consumes the token and creates its session.
 * Requires the independently bounded multi-token TokenManager, not a single slot.
 * Cookies/passwords are neither issued here nor transferred through the manager. */
export class BootstrapProofs {
  private readonly proofs = new Map<string, { token: string; windowId: string; expires: number }>()
  constructor(private readonly auth: Pick<AuthManager, "issueBootstrapToken" | "consumeBootstrapToken">,
    private readonly ttlMs = 60_000, private readonly now = Date.now) {}
  issue(windowId: string): string {
    this.prune()
    if (this.proofs.size >= 128) throw new HostError("bootstrap-capacity")
    const proof = this.auth.issueBootstrapToken()
    if (!proof) throw new HostError("bootstrap-unavailable")
    this.proofs.set(this.digest(proof), { token: proof, windowId, expires: this.now() + this.ttlMs })
    return proof
  }
  consume(proof: string): boolean {
    const key = this.digest(proof)
    const entry = this.proofs.get(key)
    this.proofs.delete(key)
    if (!entry) return false
    const consumed = this.auth.consumeBootstrapToken(proof)
    return entry.expires > this.now() && consumed
  }
  revoke(windowId: string): void {
    for (const [key, entry] of this.proofs) if (entry.windowId === windowId) {
      this.auth.consumeBootstrapToken(entry.token)
      this.proofs.delete(key)
    }
  }
  revokeAll(): void {
    for (const entry of this.proofs.values()) this.auth.consumeBootstrapToken(entry.token)
    this.proofs.clear()
  }
  private digest(proof: string): string { return createHash("sha256").update(proof).digest("hex") }
  private prune(): void { for (const [key, entry] of this.proofs) if (entry.expires <= this.now()) {
    this.auth.consumeBootstrapToken(entry.token)
    this.proofs.delete(key)
  } }
}
