import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify, { type FastifyRequest } from "fastify"
import pino from "pino"
import { registerRemotePreviewCapabilityRoutes } from "../server/routes/remote-preview-capabilities"
import type { RemoteServerBrowseManager } from "./browse-manager"
import { RELAY_AUTHORITY_HEADER } from "./relay-authority"
import { createRelayPrincipalBinding } from "./relay-principal"

function authority(key: string) {
  const logout = new Set<(id: string) => void>()
  const revoked = new Set<() => void>()
  let valid = true
  let watchFailure = false
  const subscribe = <T>(set: Set<T>, listener: T) => {
    set.add(listener)
    return () => { set.delete(listener) }
  }
  const binding = createRelayPrincipalBinding({
    local: () => false,
    auth: {
      getSessionFromRequest: () => ({ sessionId: key, username: "fixture" }),
      isAuthEnabled: () => true,
      isSessionValid: () => valid,
      onPrincipalLoggedOut: listener => subscribe(logout, listener),
      onSessionInvalidated: (_id, listener) => subscribe(revoked, listener),
    },
    devices: {
      isDeviceAuthorized: () => valid,
      isPreviewDeviceAuthorized: (id, host, ingress) => valid && id === "device" && host === "app.invalid" && !ingress,
      onPreviewDeviceInvalidated: (_id, _ingress, listener) => {
        if (watchFailure) throw new Error("Observer unavailable")
        return subscribe(revoked, listener)
      },
    },
  })
  return {
    capture: (request = { raw: {} } as FastifyRequest) => binding.lifetime(request, "app.invalid"),
    logout: (id: string) => { for (const listener of logout) listener(id) },
    revoke: () => { for (const listener of revoked) listener() },
    invalidate: () => { valid = false },
    failWatch: () => { watchFailure = true },
    observers: () => logout.size + revoked.size,
  }
}

test("current authorization and explicit invalidation end preview authority without waiting for polling", () => {
  const session = authority("session")
  const cookie = session.capture()!
  session.revoke()
  assert.equal(cookie.signal.aborted, true)
  assert.equal(session.observers(), 0)

  const device = authority("remote-device:device")
  const loggedOut = device.capture()!
  device.logout("other-device")
  assert.equal(loggedOut.current(), true)
  device.logout("remote-device:device")
  assert.equal(loggedOut.signal.aborted, true)
  assert.equal(device.observers(), 0)

  const preview = device.capture()!
  device.revoke()
  assert.equal(preview.signal.aborted, true)
  assert.equal(device.observers(), 0)

  const expired = device.capture()!
  device.invalidate()
  assert.equal(expired.current(), false)
  assert.equal(expired.signal.aborted, true)
  assert.equal(device.capture(), null)
  assert.equal(device.observers(), 0)
})

test("failed acquisition and rejected create requests leave no preview observers", async t => {
  const device = authority("remote-device:device")
  device.failWatch()
  assert.throws(() => device.capture(), /Observer unavailable/)
  assert.equal(device.observers(), 0)

  const session = authority("session")
  const app = Fastify()
  t.after(() => app.close())
  let acquired = 0
  const manager = { previewOwner() { throw new Error("Owner unavailable") } } as unknown as RemoteServerBrowseManager
  registerRemotePreviewCapabilityRoutes(app, { manager, logger: pino({ level: "silent" }), getSelfOrigins: () => new Set(),
    remote: { local: () => false, guard: () => false, principal: request => { acquired++; return session.capture(request) } } })
  const url = "/api/backends/fixture/preview-capabilities"
  const payload = { url: "http://localhost:3000/", sessionId: "session" }
  const headers = { [RELAY_AUTHORITY_HEADER]: "a".repeat(43) }
  assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 404)
  assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 404)
  assert.equal(acquired, 0)
  assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 404)
  assert.equal(acquired, 1)
  assert.equal(session.observers(), 0)
})
