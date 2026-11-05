import type { OpenCodeServerRegistry } from "./registry"
import type { PairingTokenStore } from "./pairing-store"

export interface CredentialScope { profileKey: string; configIdentity: string }
type Failure = "unknown_server" | "invalid_credentials" | "metadata_unavailable" | "closed"
export class CredentialOperationError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "CredentialOperationError" }
}

/** One private owner per backend profile/config. Only backend transport code may read secrets. */
export class OpenCodeServerCredentials {
  #scope: CredentialScope
  #registry: OpenCodeServerRegistry
  #memory = new Map<string, { key: string; value: string }>()
  #closed = false
  #listeners = new Set<(serverId?: string) => void>()
  #unsubscribe: () => void

  #paired?: PairingTokenStore

  constructor(scope: CredentialScope, registry: OpenCodeServerRegistry, paired?: PairingTokenStore) {
    this.#scope = { ...scope }
    this.#registry = registry
    this.#paired = paired
    this.#unsubscribe = registry.beforeChange(next => {
      for (const previous of registry.list()) {
        const id = previous.id, profile = next.find(value => value.id === id)
        if (previous?.kind !== "explicit" || profile?.kind !== "explicit" || previous.origin !== profile.origin) {
          this.#paired?.delete(id)
          if (this.#memory.delete(id)) this.notify(id)
        }
      }
    })
  }

  onChange(listener: (serverId?: string) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  private notify(id?: string): void { for (const listener of this.#listeners) listener(id) }

  private key(serverId: string): string {
    if (this.#closed) throw new CredentialOperationError("closed")
    let profile
    try { profile = this.#registry.get(serverId) }
    catch { throw new CredentialOperationError("metadata_unavailable") }
    if (profile?.kind !== "explicit") {
      if (this.#memory.delete(serverId)) this.notify(serverId)
      throw new CredentialOperationError("unknown_server")
    }
    const key = JSON.stringify([this.#scope.profileKey, this.#scope.configIdentity, serverId, profile.origin])
    if (this.#memory.get(serverId)?.key !== key && this.#memory.delete(serverId)) this.notify(serverId)
    return key
  }

  /** Secret-bearing backend seam. Never mount as a route or event payload. */
  async readForConnection(serverId: string): Promise<string | null> {
    const key = this.key(serverId)
    const value = this.#memory.get(serverId)?.value
    if (value !== undefined) return value
    return this.#paired?.read(serverId, key) ?? null
  }

  async status(serverId: string) {
    const hasCredentials = (await this.readForConnection(serverId)) !== null
    return { hasCredentials, needsCredentials: !hasCredentials }
  }

  /** Metadata-only status; never materializes a secret or mutates the private Map. */
  hasCredentials(serverId: string): boolean {
    if (this.#closed) return false
    const profile = this.#registry.get(serverId)
    if (profile?.kind !== "explicit") return false
    const key = JSON.stringify([this.#scope.profileKey, this.#scope.configIdentity, serverId, profile.origin])
    return this.#memory.get(serverId)?.key === key || Boolean(this.#paired?.has(serverId, key))
  }

  /** prototype-1236: an `opencode pair` token, kept across launches until expiry or 401. */
  async setPaired(serverId: string, token: string): Promise<void> {
    const key = this.key(serverId)
    if (!this.#paired || typeof token !== "string" || !token.length || Buffer.byteLength(token, "utf8") > 16 * 1024) {
      throw new CredentialOperationError("invalid_credentials")
    }
    this.#memory.delete(serverId)
    this.#paired.set(serverId, key, token)
    this.notify(serverId)
  }

  /** A rejected credential (401) leaves the server waiting for a new link or password. */
  async rejected(serverId: string): Promise<void> {
    if (this.#closed) return
    this.#paired?.delete(serverId)
    if (this.#memory.delete(serverId)) this.notify(serverId)
  }

  async set(serverId: string, value: string): Promise<void> {
    const key = this.key(serverId)
    if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > 16 * 1024) {
      throw new CredentialOperationError("invalid_credentials")
    }
    // prototype-1236 (R17): a manual password is kept across launches like a paired token;
    // memory remains only for a backend without a private store.
    if (this.#paired) { this.#memory.delete(serverId); this.#paired.setCredential(serverId, key, value) }
    else this.#memory.set(serverId, { key, value })
    this.notify(serverId)
  }

  /** Also usable after metadata removal; deletion/forget callers clear before reusing an ID. */
  async clear(serverId: string): Promise<void> {
    if (this.#closed) throw new CredentialOperationError("closed")
    this.#memory.delete(serverId)
    this.#paired?.delete(serverId)
    this.notify(serverId)
  }

  async dispose(): Promise<void> {
    this.#closed = true
    this.#memory.clear()
    this.notify()
    this.#listeners.clear()
    this.#unsubscribe()
  }
}
