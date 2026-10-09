import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import path from "node:path"
import { describe, it } from "node:test"
import { SettingsService } from "./service"
import { resolveConfigLocation } from "../config/location"

function serviceWithStore(store: Record<string, unknown>) {
  const service = Object.create(SettingsService.prototype) as SettingsService
  Object.assign(service as any, { configStore: store, eventBus: undefined })
  return service
}

describe("SettingsService config persistence", () => {
  it("preserves Tauri's ASCII-folded Unicode Windows identity without moving profile state", () => {
    if (process.platform !== "win32") return
    const service = serviceWithStore({})
    const config = resolveConfigLocation(path.resolve("Émilie", "custom.json"))
    Object.assign(service as any, { location: config })
    const oldChannel = process.env.CODENOMAD_UPDATE_CHANNEL, oldIdentity = process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
    try {
      process.env.CODENOMAD_UPDATE_CHANNEL = "dev-v2"
      delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      const electron = service.getProfileScope()
      const tauriIdentity = path.resolve(config.configYamlPath).replaceAll("/", "\\")
        .replace(/[A-Z]/g, letter => letter.toLowerCase())
      assert.notEqual(tauriIdentity, electron.configIdentity, "Unicode lowercasing differs from ASCII-only Tauri")
      process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = tauriIdentity
      const tauri = service.getProfileScope()
      assert.equal(tauri.configIdentity, tauriIdentity)
      assert.equal(tauri.key, createHash("sha256").update(`dev-v2\0${tauriIdentity}`).digest("hex"))
      assert.notEqual(tauri.key, electron.key)
      assert.equal(config.legacyJsonPath, path.resolve("Émilie", "custom.json"))
      process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = tauriIdentity.replace("Émilie", "Other")
      assert.throws(() => service.getProfileScope(), /profile configuration differs/)
    } finally {
      if (oldChannel === undefined) delete process.env.CODENOMAD_UPDATE_CHANNEL
      else process.env.CODENOMAD_UPDATE_CHANNEL = oldChannel
      if (oldIdentity === undefined) delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      else process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = oldIdentity
    }
  })
  it("Tauri's resolved dev-v2 channel gives the same custom-profile key as the signer", () => {
    const service = serviceWithStore({})
    const oldChannel = process.env.CODENOMAD_UPDATE_CHANNEL, oldDev = process.env.CODENOMAD_DEV
    const oldIdentity = process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
    try {
      delete process.env.CODENOMAD_UPDATE_CHANNEL
      delete process.env.CODENOMAD_DEV
      delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      for (const extension of ["json", "yaml"] as const) {
        const original = `isolated-profile/custom.${extension}`
        const selected = path.resolve(process.cwd(), original)
        const config = resolveConfigLocation(selected)
        Object.assign(service as any, { location: config })
        assert.equal(extension === "json" ? config.legacyJsonPath : config.configYamlPath, selected)
        assert.notEqual(selected, path.resolve(process.cwd(), "other-backend-cwd", original))
        const wrong = service.getProfileScope().key
        // Tauri resolves dev-v2 without a launcher env, then passes that channel,
        // the canonical identity, and the UNCHANGED CLI_CONFIG into the backend.
        process.env.CODENOMAD_UPDATE_CHANNEL = "dev-v2"
        const scope = service.getProfileScope()
        process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = scope.configIdentity
        assert.equal(service.getProfileScope().key,
          createHash("sha256").update(`dev-v2\0${scope.configIdentity}`).digest("hex"))
        assert.equal(scope.configIdentity, process.platform === "win32"
          ? config.configYamlPath.replaceAll("/", "\\").toLowerCase() : config.configYamlPath)
        assert.notEqual(scope.key, wrong)
        process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = "other-profile"
        assert.throws(() => service.getProfileScope(), /profile configuration differs/)
        delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
        delete process.env.CODENOMAD_UPDATE_CHANNEL
      }
    } finally {
      if (oldChannel === undefined) delete process.env.CODENOMAD_UPDATE_CHANNEL
      else process.env.CODENOMAD_UPDATE_CHANNEL = oldChannel
      if (oldDev === undefined) delete process.env.CODENOMAD_DEV
      else process.env.CODENOMAD_DEV = oldDev
      if (oldIdentity === undefined) delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      else process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = oldIdentity
    }
  })
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
      getOwner: () => ({ logLevel: "info", opencodeBinary: "opencode", sidecars: [] }),
      replaceOwner: (_owner: string, value: unknown) => {
        writes += 1
        return value
      },
      mergePatchOwner: () => assert.fail("must not persist an intermediate owner"),
    })

    const result = service.mergePatchOwner("config", "server", { sidecars: [{ id: "one" }] })
    assert.equal(writes, 1)
    assert.deepEqual(result, { logLevel: "INFO", opencodeBinary: "opencode2", sidecars: [{ id: "one" }] })
  })

  it("keeps only known update feeds", () => {
    const owner = (updateFeed: unknown) => serviceWithStore({
      getOwner: () => ({}),
      replaceOwner: (_owner: string, value: unknown) => value,
    }).mergePatchOwner("config", "server", { updateFeed })
    assert.deepEqual(owner("preview"), { updateFeed: "preview" })
    assert.deepEqual(owner("stable"), { updateFeed: "stable" })
    assert.deepEqual(owner("dev"), {})
    assert.deepEqual(owner(null), {})
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
