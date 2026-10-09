import crypto from "crypto"

export interface BootstrapToken {
  token: string
  createdAt: number
  consumed: boolean
}

export class TokenManager {
  private token: BootstrapToken | null = null

  constructor(private readonly ttlMs: number) {}

  generate(): string {
    const token = crypto.randomBytes(32).toString("base64url")
    this.token = { token, createdAt: Date.now(), consumed: false }
    return token
  }

  consume(token: string): boolean {
    if (!this.token) return false
    if (this.token.consumed) return false
    if (Date.now() - this.token.createdAt > this.ttlMs) return false
    if (token !== this.token.token) return false
    this.token.consumed = true
    return true
  }

  peek(): string | null {
    return this.token?.token ?? null
  }
}
