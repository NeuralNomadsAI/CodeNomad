import assert from "node:assert/strict"
import { it } from "node:test"
import { PASSWORD_SESSION_TTL_MS, SessionManager } from "./session-manager"

it("expires a password session exactly at its lifetime and forgets it", () => {
  let now = 1_000_000
  const sessions = new SessionManager(() => now)
  const session = sessions.createSession("user", { ttlMs: PASSWORD_SESSION_TTL_MS })
  assert.equal(sessions.remainingSeconds(session.id), PASSWORD_SESSION_TTL_MS / 1000)
  now += PASSWORD_SESSION_TTL_MS - 1
  assert.equal(sessions.getSession(session.id)?.username, "user")
  now += 1
  assert.equal(sessions.getSession(session.id), undefined)
  assert.equal(sessions.remainingSeconds(session.id), undefined)
})

it("keeps sessions without lifetime until the server ends, prunes expired ones and revokes on demand", () => {
  let now = 0
  const sessions = new SessionManager(() => now)
  const token = sessions.createSession("desktop")
  const short = sessions.createSession("user", { ttlMs: 10 })
  now = 1_000_000_000
  assert.equal(sessions.getSession(token.id)?.username, "desktop")
  assert.equal(sessions.remainingSeconds(token.id), undefined)
  // A later login prunes the expired one even if its cookie never comes back.
  sessions.createSession("other")
  assert.equal((sessions as unknown as { sessions: Map<string, unknown> }).sessions.has(short.id), false)
  sessions.revokeSession(token.id)
  assert.equal(sessions.getSession(token.id), undefined)
})
