import crypto from "crypto"

export interface SessionInfo {
  id: string
  createdAt: number
  username: string
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>()

  createSession(username: string): SessionInfo {
    const id = crypto.randomBytes(32).toString("base64url")
    const info: SessionInfo = { id, createdAt: Date.now(), username }
    this.sessions.set(id, info)
    return info
  }

  getSession(id: string | undefined): SessionInfo | undefined {
    if (!id) return undefined
    return this.sessions.get(id)
  }
}
