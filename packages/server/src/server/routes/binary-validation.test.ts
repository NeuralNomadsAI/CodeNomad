import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { it } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { registerSettingsRoutes } from "./settings"
import type { SettingsService } from "../../settings/service"
import { binaryProbeFixture, legacyHelp } from "../../workspaces/__tests__/binary-probe-fixture"

it("validates through HTTP without writing preferences or blocking other requests", async () => {
  const app = Fastify()
  registerSettingsRoutes(app, {
    settings: new Proxy({} as SettingsService, { get() { throw new Error("Validation must not read or mutate settings") } }),
    logger: pino({ level: "silent" }),
  })
  app.get("/ping", async () => ({ ok: true }))
  await app.ready()
  const compatible = binaryProbeFixture({ delayMs: 250 })
  const legacy = binaryProbeFixture({ help: legacyHelp, stderr: true })
  try {
    let completed = false
    const validating = app.inject({ method: "POST", url: "/api/storage/binaries/validate", payload: { path: compatible.binary } })
      .then((response) => { completed = true; return response })
    await delay(50)
    assert.equal((await app.inject("/ping")).statusCode, 200)
    assert.equal(completed, false, "HTTP must remain available while the CLI is slow")
    const valid = await validating
    assert.equal(valid.statusCode, 200)
    assert.deepEqual(valid.json(), { valid: true })
    const invalid = await app.inject({ method: "POST", url: "/api/storage/binaries/validate", payload: { path: legacy.binary } })
    assert.equal(invalid.statusCode, 200)
    assert.deepEqual(invalid.json(), { valid: false, errorCode: "opencode_v2_required" })
    assert.deepEqual(compatible.calls(), [["--version"], ["service", "--help"]])
    assert.deepEqual(legacy.calls(), [["--version"], ["service", "--help"]])
    assert.equal((await app.inject({ method: "POST", url: "/api/storage/binaries/validate", payload: { path: 42 } })).statusCode, 400)
  } finally {
    await app.close()
    compatible.dispose()
    legacy.dispose()
  }
})
