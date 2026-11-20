import crypto from "crypto"

export interface SessionInfo {
  id: string
  createdAt: number
  lastSeenAt: number
  username: string
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()
  private revocations = new Map<string, Set<() => void>>()

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

  /** Track an open stream without renewing the password session's idle limit. */
  watch(id: string, revoked: () => void): () => void {
    const session = this.sessions.get(id)
    if (!session || this.now() >= this.deadline(session)) {
      revoked()
      return () => {}
    }
    const listeners = this.revocations.get(id) ?? new Set<() => void>()
    this.revocations.set(id, listeners)
    let timer: ReturnType<typeof setTimeout>
    const stop = () => {
      clearTimeout(timer)
      listeners.delete(notify)
      if (!listeners.size && this.revocations.get(id) === listeners) this.revocations.delete(id)
    }
    const notify = () => { stop(); revoked() }
    const check = () => {
      const remaining = this.deadline(session) - this.now()
      if (remaining <= 0) this.revoke(id)
      else timer = setTimeout(check, Math.min(remaining, 0x7fff_ffff)).unref()
    }
    listeners.add(notify)
    check()
    return stop
  }

  revoke(id: string): void {
    this.sessions.delete(id)
    const listeners = this.revocations.get(id)
    this.revocations.delete(id)
    if (listeners) for (const notify of listeners) notify()
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
