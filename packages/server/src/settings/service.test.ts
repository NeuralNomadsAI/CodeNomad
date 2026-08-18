import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SettingsService } from "./service"

function serviceWithStore(store: Record<string, unknown>) {
  const service = Object.create(SettingsService.prototype) as SettingsService
  Object.assign(service as any, { configStore: store, eventBus: undefined })
  return service
}

describe("SettingsService config persistence", () => {
  it("normalizes and persists a document patch once", () => {
    let writes = 0
    const service = serviceWithStore({
      get: () => ({ server: { logLevel: "info" } }),
      replace: (value: unknown) => {
        writes += 1
        return value
      },
      mergePatch: () => assert.fail("must not persist an intermediate document"),
    })

    const result = service.mergePatchDoc("config", { ui: { theme: "dark" } })
    assert.equal(writes, 1)
    assert.deepEqual(result, { server: { logLevel: "INFO" }, ui: { theme: "dark" } })
  })

  it("normalizes and persists a server-owner patch once", () => {
    let writes = 0
    const service = serviceWithStore({
      getOwner: () => ({ logLevel: "info", sidecars: [] }),
      replaceOwner: (_owner: string, value: unknown) => {
        writes += 1
        return value
      },
      mergePatchOwner: () => assert.fail("must not persist an intermediate owner"),
    })

    const result = service.mergePatchOwner("config", "server", { sidecars: [{ id: "one" }] })
    assert.equal(writes, 1)
    assert.deepEqual(result, { logLevel: "INFO", sidecars: [{ id: "one" }] })
  })

  it("does not report a persisted patch as failed when an event listener throws", () => {
    let warnings = 0
    const service = serviceWithStore({
      getOwner: () => ({}),
      mergePatchOwner: (_owner: string, patch: unknown) => patch,
    })
    Object.assign(service as any, {
      eventBus: { publish: () => { throw new Error("listener failed") } },
      logger: { warn: () => { warnings += 1 } },
    })

    assert.deepEqual(service.mergePatchOwner("config", "ui", { theme: "dark" }), { theme: "dark" })
    assert.equal(warnings, 1)
  })
})
