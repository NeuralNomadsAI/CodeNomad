import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { RemoteControlManager } from "../../remote-control/manager"
import { registerRemoteControlRoutes } from "./remote-control"

function manager() {
  return {
    status: () => ({ manageable: true, enabled: false, state: "stopped", hostId: "a".repeat(32), relayUrl: "https://relay.example", remoteUrl: "https://host.relay.example", pairedDevices: 0 }),
    start: async () => { throw new Error("not used") },
    stop: () => ({ manageable: true, enabled: false, state: "stopped", hostId: "a".repeat(32), relayUrl: "https://relay.example", remoteUrl: "https://host.relay.example", pairedDevices: 0 }),
    createPairing: async () => { throw new Error("not used") },
    devices: async () => [],
    revokeDevice: async () => undefined,
  } as unknown as RemoteControlManager
}

test("Remote Control status is readable remotely but management remains local-only", async () => {
  const app = Fastify()
  registerRemoteControlRoutes(app, { manager: manager() })
  const local = await app.inject({ method: "GET", url: "/api/remote-control/status" })
  assert.equal(local.statusCode, 200)

  const relayed = await app.inject({
    method: "GET",
    url: "/api/remote-control/status",
    headers: { "x-codenomad-remote-control": "1" },
  })
  assert.equal(relayed.statusCode, 200)
  assert.equal(relayed.json().manageable, false)
  const blocked = await app.inject({
    method: "DELETE",
    url: "/api/remote-control",
    headers: { "x-codenomad-remote-control": "1" },
  })
  assert.equal(blocked.statusCode, 403)
  await app.close()
})

test("device revocation validates UUIDs before reaching the relay", async () => {
  const app = Fastify()
  registerRemoteControlRoutes(app, { manager: manager() })
  const response = await app.inject({ method: "DELETE", url: "/api/remote-control/devices/not-a-uuid" })
  assert.equal(response.statusCode, 400)
  await app.close()
})
