import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"

import { EventBus } from "../../events/bus"
import { registerPluginRoutes } from "./plugin"

test("plugin event callbacks require the capability on the canonical handler", async () => {
  const app = Fastify({ logger: false })
  registerPluginRoutes(app, {
    workspaceManager: {
      get: (id: string) => id === "workspace" ? { id, status: "ready" } : undefined,
      getPluginCallbackAuthorizationHeader: (id: string) => id === "workspace" ? "Bearer callback-secret" : undefined,
    } as never,
    eventBus: new EventBus(),
    logger: { debug: () => undefined } as never,
    channel: {} as never,
    voiceModeManager: {} as never,
  })

  const missing = await app.inject({
    method: "POST",
    url: "/workspaces/workspace/plugin/event",
    payload: { type: "test.event" },
  })
  const authorized = await app.inject({
    method: "POST",
    url: "/workspaces/workspace/plugin/event",
    headers: { authorization: "Bearer callback-secret" },
    payload: { type: "test.event" },
  })
  const doubledSlash = await app.inject({
    method: "POST",
    url: "/workspaces/workspace/plugin//event",
    headers: { authorization: "Bearer callback-secret" },
    payload: { type: "test.event" },
  })

  assert.equal(missing.statusCode, 401)
  assert.equal(authorized.statusCode, 204)
  assert.equal(doubledSlash.statusCode, 404)
  await app.close()
})
