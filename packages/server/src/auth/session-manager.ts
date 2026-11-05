import crypto from "crypto"

/**
 * A password login lasts this long: its cookie gets the same Max-Age, so a browser
 * or desktop view keeps it across restarts and the server refuses it afterwards.
 */
export const PASSWORD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionInfo {
  id: string
  createdAt: number
  username: string
  /** Absent for sessions that end with the server (desktop bootstrap token). */
  expiresAt?: number
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()

  constructor(private readonly now: () => number = Date.now) {}

  createSession(username: string, options: { ttlMs?: number } = {}): SessionInfo {
    this.pruneExpired()
    const id = crypto.randomBytes(32).toString("base64url")
    const createdAt = this.now()
    const info: SessionInfo = {
      id, createdAt, username,
      ...(options.ttlMs === undefined ? {} : { expiresAt: createdAt + options.ttlMs }),
    }
    this.sessions.set(id, info)
    return info
  }

  getSession(id: string | undefined): SessionInfo | undefined {
    if (!id) return undefined
    const session = this.sessions.get(id)
    if (session && session.expiresAt !== undefined && session.expiresAt <= this.now()) {
      this.sessions.delete(id)
      return undefined
    }
    return session
  }

  /** Seconds left before an expiring session ends; undefined for one without expiry. */
  remainingSeconds(id: string): number | undefined {
    const expiresAt = this.getSession(id)?.expiresAt
    return expiresAt === undefined ? undefined : Math.max(0, Math.floor((expiresAt - this.now()) / 1000))
  }

  revokeSession(id: string | undefined): void {
    if (id) this.sessions.delete(id)
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt !== undefined && session.expiresAt <= now) this.sessions.delete(id)
    }
  }
}
