import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, type TestContext } from "node:test"
import Fastify from "fastify"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { resolveConfigLocation } from "../../config/location"
import { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { SettingsService } from "../../settings/service"
import { registerSettingsRoutes } from "./settings"

const url = "/api/storage/config/ui?conditional=missions-v1"
const logger = { child() { return this }, info() {}, warn() {} } as unknown as Logger

async function fixture(t: TestContext, rawSettings: unknown = {}) {
  const tempRoot = path.join(tmpdir(), "opencode")
  mkdirSync(tempRoot, { recursive: true })
  const root = mkdtempSync(path.join(tempRoot, "codenomad-mission-condition-"))
  const location = resolveConfigLocation(root)
  const original = {
    ui: { theme: "dark", settings: rawSettings },
    server: { logLevel: "INFO", custom: { keep: true } },
    app: { keep: [1, 2] },
  }
  writeFileSync(location.configYamlPath, stringifyYaml(original))
  const bus = new EventBus()
  let events = 0
  bus.on("storage.configChanged", () => { events += 1 })
  const settings = new SettingsService(location, bus, logger)
  const app = Fastify()
  registerSettingsRoutes(app, { settings, logger })
  t.after(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  await app.ready()
  return {
    app, settings, original, configPath: location.configYamlPath,
    events: () => events,
    bytes: () => readFileSync(location.configYamlPath, "utf8"),
    disk: () => parseYaml(readFileSync(location.configYamlPath, "utf8")),
  }
}

function body(patch: Record<string, unknown>, expected: unknown[]) {
  return { patch: { settings: patch }, expected }
}

describe("PATCH owner conditional=missions-v1", () => {
  it("fails closed on malformed whole YAML even after a forgiving cached read", async (t) => {
    const f = await fixture(t)
    const malformed = "ui: [broken\nserver: untouched\n"
    writeFileSync(f.configPath, malformed)
    // Legacy callers still have their existing forgiving read semantics.
    assert.equal(f.settings.getOwner("config", "ui"), undefined)
    const get = await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })
    assert.equal(get.statusCode, 503)
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 503)
    assert.equal(f.bytes(), malformed)
    assert.equal(f.events(), 0)
    // A genuinely repaired document is observable without restarting the backend.
    writeFileSync(f.configPath, stringifyYaml({ ui: { settings: { missionModels: [] } } }))
    assert.equal((await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })).statusCode, 200)
  })

  it("rejects non-object document roots instead of treating them as absent preferences", async (t) => {
    const f = await fixture(t)
    for (const source of ["null\n", "- entry\n", "scalar\n", ""]) {
      writeFileSync(f.configPath, source)
      assert.equal((await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })).statusCode, 503)
      assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 503)
      assert.equal(f.bytes(), source)
      assert.equal(f.events(), 0)
    }
  })

  it("rejects read failures, but accepts a genuinely missing file and missing ui owner", async (t) => {
    const f = await fixture(t)
    rmSync(f.configPath)
    mkdirSync(f.configPath)
    assert.equal((await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })).statusCode, 503)
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 503)
    assert.equal(statSync(f.configPath).isDirectory(), true)
    assert.equal(f.events(), 0)
    rmdirSync(f.configPath)
    const missing = await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })
    assert.equal(missing.statusCode, 200)
    assert.deepEqual(missing.json(), {})
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 200)
    assert.deepEqual(f.disk(), { ui: { settings: { missionModels: [] } } })
    writeFileSync(f.configPath, stringifyYaml({ server: { logLevel: "info" } }))
    const bytes = f.bytes()
    const noOwner = await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })
    assert.equal(noOwner.statusCode, 200)
    assert.deepEqual(noOwner.json(), {})
    assert.equal(f.bytes(), bytes)
    assert.equal(f.events(), 1)
  })

  it("does not normalize malformed UI owners or settings containers into empty mutation authority", async (t) => {
    const f = await fixture(t)
    for (const source of ["ui: null\n", "ui: []\n", "ui: { settings: null }\n", "ui: { settings: corrupt }\n"]) {
      writeFileSync(f.configPath, source)
      assert.equal((await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })).statusCode, 503)
      assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 503)
      assert.equal(f.bytes(), source)
      assert.equal(f.events(), 0)
    }
  })

  it("never persists server normalization during UI reads or conflicts", async (t) => {
    const f = await fixture(t, { missionModels: [] })
    const raw = { ...f.original, server: { logLevel: "info", opencodeBinary: "opencode" } }
    writeFileSync(f.configPath, stringifyYaml(raw))
    const before = f.bytes()
    assert.equal((await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })).statusCode, 200)
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 409)
    assert.equal(f.bytes(), before)
    assert.equal(f.events(), 0)
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [{ id: "new" }] }, [{ key: "missionModels", present: true, value: [] }]) })).statusCode, 200)
    assert.deepEqual(f.disk().server, raw.server)
  })

  it("rereads external file edits before comparison and retains external unrelated fields", async (t) => {
    const f = await fixture(t, { missionModels: [] })
    assert.equal((await f.app.inject({ method: "GET", url: "/api/storage/config/ui" })).statusCode, 200)
    const external = {
      ...f.original, app: { keep: [9] },
      ui: { ...f.original.ui, settings: { missionModels: [{ id: "external" }], external: { keep: true } } },
    }
    writeFileSync(f.configPath, stringifyYaml(external))
    const before = f.bytes()
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [{ id: "stale" }] }, [{ key: "missionModels", present: true, value: [] }]) })).statusCode, 409)
    assert.equal(f.bytes(), before)
    assert.equal(f.events(), 0)
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [{ id: "updated" }] }, [{ key: "missionModels", present: true, value: [{ id: "external" }] }]) })).statusCode, 200)
    assert.deepEqual(f.disk(), { ...external, ui: { ...external.ui, settings: { ...external.ui.settings, missionModels: [{ id: "updated" }] } } })
  })

  it("admits only one concurrent writer with the same fresh expectation", async (t) => {
    const f = await fixture(t, { missionModels: [], unrelated: { keep: "yes" } })
    const results = await Promise.all(["first", "second"].map((id) => f.app.inject({
      method: "PATCH", url,
      payload: body({ missionModels: [{ id }] }, [{ key: "missionModels", present: true, value: [] }]),
    })))
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409])
    assert.equal(f.events(), 1)
    const winner = results.find((result) => result.statusCode === 200)!.json()
    assert.deepEqual(winner, f.disk().ui)
    assert.deepEqual(f.disk(), {
      ...f.original,
      ui: { ...f.original.ui, settings: { missionModels: winner.settings.missionModels, unrelated: { keep: "yes" } } },
    })
  })

  it("does not let a stale editor resurrect a deleted model library", async (t) => {
    const initial = [{ id: "saved" }]
    const f = await fixture(t, { missionModels: initial })
    const expected = [{ key: "missionModels", present: true, value: initial }]
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: null }, expected) })).statusCode, 200)
    const afterDelete = f.bytes()
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [{ id: "stale" }] }, expected) })).statusCode, 409)
    assert.equal(f.bytes(), afterDelete)
    assert.equal(Object.prototype.hasOwnProperty.call(f.disk().ui.settings, "missionModels"), false)
    assert.equal(f.events(), 1)
  })

  it("distinguishes absent, empty and explicitly null raw fields", async (t) => {
    const f = await fixture(t, { missionModels: [], missionProfileDefaults: null })
    const originalBytes = f.bytes()
    for (const [key, value] of [["missionModels", null], ["missionProfileDefaults", {}]] as const) {
      const response = await f.app.inject({
        method: "PATCH", url,
        payload: body({ [key]: [] }, [{ key, present: true, value }]),
      })
      assert.equal(response.statusCode, 409)
    }
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 409)
    assert.equal(f.bytes(), originalBytes)
    assert.equal(f.events(), 0)
    assert.equal((await f.app.inject({
      method: "PATCH", url,
      payload: body({ missionModels: null, missionProfileDefaults: { coordinator: { agent: "general" } } }, [
        { key: "missionModels", present: true, value: [] },
        { key: "missionProfileDefaults", present: true, value: null },
      ]),
    })).statusCode, 200)
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }]) })).statusCode, 200)
    assert.deepEqual(f.disk().ui.settings.missionModels, [])
  })

  it("compares raw invalid values for explicit repairs, not normalized UI defaults", async (t) => {
    const invalid = { bad: ["raw", null], version: "wrong" }
    const f = await fixture(t, { missionModels: invalid })
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: true, value: [] }]) })).statusCode, 409)
    assert.equal(f.events(), 0)
    assert.equal((await f.app.inject({
      method: "PATCH", url,
      payload: body({ missionModels: [] }, [{ key: "missionModels", present: true, value: { version: "wrong", bad: ["raw", null] } }]),
    })).statusCode, 200)
    assert.deepEqual(f.disk().ui.settings.missionModels, [])
  })

  it("returns 400 without writes/events for strict schema or unknown mode/owner failures", async (t) => {
    const f = await fixture(t)
    const valid = body({ missionModels: [] }, [{ key: "missionModels", present: false }])
    const cases = [
      { url, payload: { ...valid, unknown: true } },
      { url, payload: { ...valid, patch: { settings: { missionModels: [], locale: "en" } } } },
      { url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false, value: null }]) },
      { url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: true }]) },
      { url, payload: body({ missionModels: [], missionProfileDefaults: {} }, [{ key: "missionModels", present: false }]) },
      { url, payload: body({ missionModels: [] }, [{ key: "missionModels", present: false }, { key: "missionModels", present: false }]) },
      { url: "/api/storage/config/ui?conditional=other", payload: { settings: { missionModels: [] } } },
      { url: "/api/storage/config/ui?conditional=", payload: { settings: { missionModels: [] } } },
      { url: `${url}&conditional=missions-v1`, payload: valid },
      { url: "/api/storage/config/server?conditional=missions-v1", payload: valid },
    ]
    const before = f.bytes()
    for (const entry of cases) {
      assert.equal((await f.app.inject({ method: "PATCH", ...entry })).statusCode, 400, JSON.stringify(entry))
      assert.equal(f.bytes(), before)
      assert.equal(f.events(), 0)
    }
  })

  it("preserves ordinary owner/document patch routes and merge-patch semantics", async (t) => {
    const f = await fixture(t, { missionModels: [{ id: "one" }], missionProfileDefaults: { coordinator: { agent: "old", keep: true } } })
    assert.equal((await f.app.inject({
      method: "PATCH", url,
      payload: body({ missionModels: [{ id: "two" }], missionProfileDefaults: { coordinator: { agent: "new" } } }, [
        { key: "missionModels", present: true, value: [{ id: "one" }] },
        { key: "missionProfileDefaults", present: true, value: { coordinator: { keep: true, agent: "old" } } },
      ]),
    })).statusCode, 200)
    assert.deepEqual(f.disk().ui.settings, { missionModels: [{ id: "two" }], missionProfileDefaults: { coordinator: { agent: "new", keep: true } } })
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/storage/config/ui", payload: { theme: "light" } })).statusCode, 200)
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/storage/config", payload: { app: { keep: [3] } } })).statusCode, 200)
    assert.equal(f.disk().ui.theme, "light")
    assert.deepEqual(f.disk().app.keep, [3])
    assert.equal(f.events(), 3)
  })

  it("accepts taskMode only inside mission defaults and preserves unrelated preference fields with CAS", async t => {
    const original = { coordinator: { agent: "general" }, future: { keep: true } }
    const f = await fixture(t, { missionProfileDefaults: original, unrelated: { keep: "yes" } })
    let expected: unknown = original
    for (const taskMode of ["native", "independent"] as const) {
      const response = await f.app.inject({ method: "PATCH", url, payload: body({ missionProfileDefaults: { taskMode } },
        [{ key: "missionProfileDefaults", present: true, value: expected }]) })
      assert.equal(response.statusCode, 200)
      expected = { ...original, taskMode }
      assert.deepEqual(f.disk().ui.settings, { missionProfileDefaults: expected, unrelated: { keep: "yes" } })
    }
    const before = f.bytes()
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ missionProfileDefaults: { taskMode: "native" } },
      [{ key: "missionProfileDefaults", present: true, value: original }]) })).statusCode, 409)
    assert.equal((await f.app.inject({ method: "PATCH", url, payload: body({ taskMode: "native" },
      [{ key: "taskMode", present: false }]) })).statusCode, 400)
    assert.equal(f.bytes(), before)
    assert.equal(f.events(), 2)
  })
})
