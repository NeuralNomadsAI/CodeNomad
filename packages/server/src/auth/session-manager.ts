import crypto from "crypto"

export interface SessionInfo {
  id: string
  createdAt: number
  lastSeenAt: number
  username: string
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()

  constructor(private readonly options: { idleMs?: number; absoluteMs?: number; now?: () => number } = {}) {}

  private now() { return this.options.now?.() ?? Date.now() }

  private expired(session: SessionInfo, now: number): boolean {
    return now - session.lastSeenAt >= (this.options.idleMs ?? 24 * 60 * 60 * 1000)
      || now - session.createdAt >= (this.options.absoluteMs ?? 7 * 24 * 60 * 60 * 1000)
  }

  createSession(username: string): SessionInfo {
    const id = crypto.randomBytes(32).toString("base64url")
    const now = this.now()
    for (const [id, session] of this.sessions) if (this.expired(session, now)) this.sessions.delete(id)
    const info: SessionInfo = { id, createdAt: now, lastSeenAt: now, username }
    this.sessions.set(id, info)
    return info
  }

  getSession(id: string | undefined): SessionInfo | undefined {
    if (!id) return undefined
    const session = this.sessions.get(id)
    if (!session) return undefined
    const now = this.now()
    if (this.expired(session, now)) {
      this.sessions.delete(id)
      return undefined
    }
    session.lastSeenAt = now
    return session
  }

  revoke(id: string): void { this.sessions.delete(id) }

  revokeUser(username: string): void {
    for (const [id, session] of this.sessions) if (session.username === username) this.sessions.delete(id)
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
