import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { RemoteControlManager } from "../../remote-control/manager"
import { registerRemoteControlRoutes } from "./remote-control"

// Remote-origin behavior is covered through the real ingress in remote-surface.test.ts.
function manager() {
  return {
    status: () => ({ manageable: true, enabled: false, state: "stopped", pairedDevices: 0 }),
    createPairing: () => { throw new Error("Remote Control is not connected") },
    devices: () => [],
    revokeDevice: () => false,
  } as unknown as RemoteControlManager
}

test("local management validates device IDs and reports unknown devices", async () => {
  const app = Fastify()
  registerRemoteControlRoutes(app, { manager: manager() })
  assert.equal((await app.inject({ method: "DELETE", url: "/api/remote-control/devices/not-a-uuid" })).statusCode, 400)
  assert.equal((await app.inject({ method: "DELETE", url: "/api/remote-control/devices/00000000-0000-4000-8000-000000000000" })).statusCode, 404)
  await app.close()
})

test("pairing links require a connected tunnel", async () => {
  const app = Fastify()
  registerRemoteControlRoutes(app, { manager: manager() })
  const response = await app.inject({ method: "POST", url: "/api/remote-control/pairings" })
  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error, "Remote Control is not connected")
  await app.close()
})

test("pairing routes do not answer on local listeners", async () => {
  const app = Fastify()
  registerRemoteControlRoutes(app, { manager: manager() })
  assert.equal((await app.inject({ method: "GET", url: "/remote-pair" })).statusCode, 404)
  assert.equal((await app.inject({ method: "POST", url: "/api/remote-control/pair", payload: { code: "x" } })).statusCode, 404)
  await app.close()
})
