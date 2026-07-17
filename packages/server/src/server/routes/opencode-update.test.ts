import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { Logger } from "../../logger"
import type { OpenCodeUpdateService } from "../../opencode-update/service"
import { registerOpenCodeUpdateRoutes } from "./opencode-update"

test("does not pass request-controlled binary paths to the update service", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const service = {
    getStatus: async (...args: unknown[]) => {
      calls.push({ method: "status", args })
      return {
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
        canUpgrade: true,
      }
    },
    upgrade: async (...args: unknown[]) => {
      calls.push({ method: "upgrade", args })
      return { success: true, version: "1.1.0" }
    },
  } as unknown as OpenCodeUpdateService
  const app = Fastify()
  registerOpenCodeUpdateRoutes(app, {
    service,
    logger: { warn() {} } as unknown as Logger,
  })

  await app.inject({ method: "GET", url: "/api/opencode/update?binary=untrusted.cmd" })
  await app.inject({ method: "POST", url: "/api/opencode/update", payload: { binary: "untrusted.cmd" } })

  assert.deepEqual(calls, [
    { method: "status", args: [] },
    { method: "upgrade", args: [] },
  ])
  await app.close()
})
