import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { registerUsageRoutes } from "./usage"

test("returns a typed unsupported result without exposing server details", async () => {
  const app = Fastify()
  registerUsageRoutes(app)

  try {
    const response = await app.inject({ method: "GET", url: "/api/usage/unknown-provider?modelId=test-model" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      requestedProviderId: "unknown-provider",
      providerId: null,
      providerName: "unknown-provider",
      modelId: "test-model",
      supported: false,
      configured: false,
      ok: false,
      windows: {},
      fetchedAt: response.json().fetchedAt,
    })
  } finally {
    await app.close()
  }
})
