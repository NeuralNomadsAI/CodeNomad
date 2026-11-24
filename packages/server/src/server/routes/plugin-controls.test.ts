import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { registerPluginControlRoutes } from "./plugin-controls"

describe("plugin activation control routes", () => {
  it("passes only a validated workspace location to the narrow read operation", async () => {
    const calls: unknown[] = []
    const app = Fastify()
    registerPluginControlRoutes(app, { controls: {
      read: async (...args: unknown[]) => { calls.push(args); return snapshot() },
      mutate: async () => { throw new Error("not used") },
    } as any })

    const response = await app.inject({
      method: "GET",
      url: "/api/workspaces/workspace/plugin-controls?directory=%2Frepo&workspaceID=native-id",
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls, [["workspace", { directory: "/repo", workspaceID: "native-id" }]])
    await app.close()
  })

  it("rejects malformed and excess mutation fields before invoking the operation", async () => {
    let calls = 0
    const app = Fastify()
    registerPluginControlRoutes(app, { controls: {
      read: async () => snapshot(),
      mutate: async () => { calls++; return {} },
    } as any })

    for (const payload of [
      { location: { directory: "/repo" }, pluginId: "-invalid", scope: "global", enabled: false },
      { location: { directory: "/repo" }, pluginId: "known", scope: "machine", enabled: false },
      { location: { directory: "/repo", token: "secret" }, pluginId: "known", scope: "project", enabled: true },
      { location: { directory: "/repo" }, pluginId: "known", scope: "project", enabled: true, path: "/other" },
    ]) {
      const response = await app.inject({ method: "PATCH", url: "/api/workspaces/workspace/plugin-controls", payload })
      assert.equal(response.statusCode, 400)
    }
    assert.equal(calls, 0)
    await app.close()
  })

  it("maps ownership, malformed-file, conflict, and availability failures without proxying upstream mutations", async () => {
    const cases = [
      ["forbidden", 403], ["invalid", 422], ["conflict", 409], ["unavailable", 503], ["not-found", 404],
    ] as const
    for (const [kind, status] of cases) {
      const app = Fastify({ logger: false })
      registerPluginControlRoutes(app, { controls: {
        read: async () => snapshot(),
        mutate: async () => { throw new PluginControlsError("controlled failure", kind) },
      } as any })
      const response = await app.inject({
        method: "PATCH",
        url: "/api/workspaces/workspace/plugin-controls",
        payload: { location: { directory: "/repo" }, pluginId: "known", scope: "project", enabled: false },
      })
      assert.equal(response.statusCode, status)
      assert.deepEqual(response.json(), { error: "controlled failure" })
      await app.close()
    }
  })
})

function snapshot() {
  return {
    location: { directory: "/repo" },
    runtime: [],
    configured: { rules: [], sources: [] },
    controls: [],
    targets: [],
  }
}
