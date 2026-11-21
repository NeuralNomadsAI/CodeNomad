import crypto from "crypto"

export interface SessionInfo {
  id: string
  createdAt: number
  lastSeenAt: number
  username: string
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()
  private invalidations = new Map<string, Set<() => void>>()

  constructor(private readonly options: { idleMs?: number; absoluteMs?: number; now?: () => number } = {}) {}

  private now() { return this.options.now?.() ?? Date.now() }

  private deadline(session: SessionInfo): number {
    return Math.min(session.lastSeenAt + (this.options.idleMs ?? 24 * 60 * 60 * 1000),
      session.createdAt + (this.options.absoluteMs ?? 7 * 24 * 60 * 60 * 1000))
  }

  createSession(username: string): SessionInfo {
    const id = crypto.randomBytes(32).toString("base64url")
    const now = this.now()
    for (const [id, session] of this.sessions) if (now >= this.deadline(session)) this.revoke(id)
    const info: SessionInfo = { id, createdAt: now, lastSeenAt: now, username }
    this.sessions.set(id, info)
    return info
  }

  getSession(id: string | undefined): SessionInfo | undefined {
    if (!id) return undefined
    const session = this.sessions.get(id)
    if (!session) return undefined
    const now = this.now()
    if (now >= this.deadline(session)) {
      this.revoke(id)
      return undefined
    }
    session.lastSeenAt = now
    return session
  }

  /** Check validity without activity updates or revocation side effects. */
  hasSession(id: string): boolean {
    const session = this.sessions.get(id)
    return session !== undefined && this.now() < this.deadline(session)
  }

  /** Observe the captured session without refreshing its idle lifetime. */
  onInvalidated(id: string, listener: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true
    const release = () => {
      active = false
      clearTimeout(timer)
      const listeners = this.invalidations.get(id)
      listeners?.delete(invalidate)
      if (listeners?.size === 0) this.invalidations.delete(id)
    }
    const invalidate = () => { if (active) { release(); listener() } }
    const listeners = this.invalidations.get(id) ?? new Set<() => void>()
    listeners.add(invalidate)
    this.invalidations.set(id, listeners)
    const check = () => {
      if (!active) return
      const session = this.sessions.get(id), now = this.now()
      if (!session || now >= this.deadline(session)) { this.revoke(id); return }
      const remaining = this.deadline(session) - now
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
      timer.unref?.()
    }
    check()
    return release
  }

  watch(id: string, revoked: () => void): () => void {
    return this.onInvalidated(id, revoked)
  }

  revoke(id: string): void {
    this.sessions.delete(id)
    const listeners = this.invalidations.get(id)
    this.invalidations.delete(id)
    for (const listener of listeners ?? []) {
      try { listener() } catch { /* Each invalidation observer has its own failure boundary. */ }
    }
  }

  revokeUser(username: string): void {
    for (const [id, session] of this.sessions) if (session.username === username) this.revoke(id)
  }
}

export function sessionTimeoutMs(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds * 1000) || seconds <= 0) {
    throw new Error(`${name} must be a positive integer number of seconds`)
  }
  return seconds * 1000
}
