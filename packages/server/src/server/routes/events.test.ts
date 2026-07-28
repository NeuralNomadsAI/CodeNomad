import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"

import { EventBus } from "../../events/bus"
import { registerEventRoutes } from "./events"

test("SSE does not reflect request origins", async () => {
  const app = Fastify({ logger: false })
  registerEventRoutes(app, {
    eventBus: new EventBus(),
    registerClient: (close) => {
      setImmediate(close)
      return () => undefined
    },
    logger: { debug: () => undefined, isLevelEnabled: () => false } as never,
    connectionManager: { register: () => () => undefined } as never,
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/events?clientId=client&connectionId=connection",
    headers: { origin: "https://attacker.example" },
  })

  assert.equal(response.headers["access-control-allow-origin"], undefined)
  assert.equal(response.headers["access-control-allow-credentials"], undefined)
  await app.close()
})
