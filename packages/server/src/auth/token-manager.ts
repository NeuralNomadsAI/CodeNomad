import crypto from "crypto"

export interface BootstrapToken {
  token: string
  createdAt: number
  consumed: boolean
}

export class TokenManager {
  private readonly tokens = new Map<string, BootstrapToken>()
  private latest: string | null = null

  constructor(private readonly ttlMs: number) {}

  generate(): string {
    this.prune()
    // Each attached native client needs its own one-shot proof. Issuing a proof
    // must not invalidate another client's concurrent attach handshake.
    if (this.tokens.size >= 32) throw new Error("Too many pending bootstrap requests")
    const token = crypto.randomBytes(32).toString("base64url")
    this.tokens.set(token, { token, createdAt: Date.now(), consumed: false })
    this.latest = token
    return token
  }

  consume(token: string): boolean {
    this.prune()
    const proof = this.tokens.get(token)
    if (!proof) return false
    this.tokens.delete(token)
    return true
  }

  peek(): string | null {
    return this.latest
  }

  private prune(): void {
    const now = Date.now()
    for (const [token, proof] of this.tokens) {
      if (now - proof.createdAt > this.ttlMs) this.tokens.delete(token)
    }
  }
}
