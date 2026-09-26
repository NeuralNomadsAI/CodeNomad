import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { registerWebSearchSettingsRoutes } from "./websearch-settings"

test("web settings routes reject unscoped, arbitrary-path and legacy selectors", async () => {
  const app = Fastify(), writes: unknown[][] = []
  registerWebSearchSettingsRoutes(app, { read: async () => ({ location: { directory: "/owned" }, effective: null, scopes: [] }),
    update: async (...args) => { writes.push(args) } })
  try {
    for (const body of [{ provider: false }, { location: { directory: "/owned", workspaceID: "legacy" }, scope: "project", provider: false },
      { location: { directory: "/owned" }, scope: "global", provider: "alpha", path: "/arbitrary" }]) {
      assert.equal((await app.inject({ method: "PUT", url: "/api/workspaces/w/websearch-settings", payload: body })).statusCode, 400)
    }
    assert.equal((await app.inject({ method: "PUT", url: "/api/workspaces/w/websearch-settings",
      payload: { location: { directory: "/owned" }, scope: "project", provider: null } })).statusCode, 204)
    assert.deepEqual(writes, [["w", { directory: "/owned" }, "project", null]])
  } finally { await app.close() }
})
