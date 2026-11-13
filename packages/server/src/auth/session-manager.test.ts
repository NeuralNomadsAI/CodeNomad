import assert from "node:assert/strict"
import test from "node:test"
import * as sessionModule from "./session-manager"

const { SessionManager, sessionTimeoutMs } = sessionModule

test("sessions slide until idle or absolute expiry and revocation isolates principals", () => {
  let now = 0
  const sessions = new SessionManager({ idleMs: 10, absoluteMs: 25, now: () => now })
  const first = sessions.createSession("alice")
  const second = sessions.createSession("alice")
  const other = sessions.createSession("bob")
  sessions.revoke(first.id)
  assert.equal(sessions.getSession(first.id), undefined)
  assert.ok(sessions.getSession(second.id))
  sessions.revokeUser("alice")
  assert.equal(sessions.getSession(second.id), undefined)
  for (now of [9, 18, 24]) assert.ok(sessions.getSession(other.id))
  now = 25
  assert.equal(sessions.getSession(other.id), undefined, "activity cannot extend the absolute lifetime")
  const idle = sessions.createSession("bob")
  now = 35
  assert.equal(sessions.getSession(idle.id), undefined, "idle expiry includes its boundary")
  now = 36
  assert.equal(sessions.getSession(idle.id), undefined, "an expired token stays revoked")
})

test("session defaults expire at 24 idle hours or seven absolute days; configuration is positive seconds", () => {
  let now = 0
  const sessions = new SessionManager({ now: () => now })
  const idle = sessions.createSession("alice")
  now = 24 * 60 * 60 * 1000
  assert.equal(sessions.getSession(idle.id), undefined)
  const active = sessions.createSession("alice")
  for (let hour = 1; hour < 7 * 24; hour++) {
    now += 60 * 60 * 1000
    assert.ok(sessions.getSession(active.id))
  }
  now += 60 * 60 * 1000
  assert.equal(sessions.getSession(active.id), undefined)
  assert.equal(sessionTimeoutMs("60", "TIMEOUT"), 60_000)
  assert.equal(sessionTimeoutMs(undefined, "TIMEOUT"), undefined)
  for (const value of ["", "0", "-1", "NaN", "1.5", "Infinity", "99999999999999999"]) {
    assert.throws(() => sessionTimeoutMs(value, "TIMEOUT"))
  }
})
