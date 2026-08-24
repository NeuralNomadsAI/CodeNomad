import assert from "node:assert/strict"
import test from "node:test"
import { OpenCodeUpdateError, OpenCodeUpdateService, type OpenCodeUpdateServiceDeps } from "./service"

function createDeps(overrides: Partial<OpenCodeUpdateServiceDeps> = {}): OpenCodeUpdateServiceDeps {
  let currentVersion = "1.0.0"
  return {
    resolveBinary: () => ({ path: "opencode", label: "OpenCode" }),
    probeBinary: () => ({ valid: true, version: currentVersion }),
    findReadyInstanceId: () => "workspace-1",
    fetchLatestVersion: async () => "1.1.0",
    upgradeInstance: async (_instanceId, target) => {
      currentVersion = target
      return { success: true, version: target }
    },
    ...overrides,
  }
}

test("reports an available update and caches the latest version", async () => {
  let checks = 0
  const service = new OpenCodeUpdateService(createDeps({
    fetchLatestVersion: async () => {
      checks += 1
      return "1.1.0"
    },
  }))

  assert.deepEqual(await service.getStatus(), {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateAvailable: true,
    canUpgrade: true,
  })
  await service.getStatus()
  assert.equal(checks, 1)
})

test("keeps the update visible when no matching instance is ready", async () => {
  const service = new OpenCodeUpdateService(createDeps({ findReadyInstanceId: () => undefined }))

  assert.deepEqual(await service.getStatus(), {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateAvailable: true,
    canUpgrade: false,
  })
})

test("preserves the installed version when the registry check fails", async () => {
  const service = new OpenCodeUpdateService(createDeps({
    fetchLatestVersion: async () => {
      throw new Error("registry unavailable")
    },
  }))

  assert.deepEqual(await service.getStatus(), {
    currentVersion: "1.0.0",
    latestVersion: null,
    updateAvailable: null,
    canUpgrade: false,
    checkError: "update_check_failed",
  })
})

test("upgrades through the matching OpenCode instance to the advertised version", async () => {
  const calls: Array<{ instanceId: string; target: string }> = []
  let currentVersion = "1.0.0"
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: currentVersion }),
    upgradeInstance: async (instanceId, target) => {
      calls.push({ instanceId, target })
      currentVersion = target
      return { success: true, version: target }
    },
  }))

  assert.deepEqual(await service.upgrade(), { success: true, version: "1.1.0" })
  assert.deepEqual(calls, [{ instanceId: "workspace-1", target: "1.1.0" }])
})

test("rejects success when the configured binary was not updated", async () => {
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: "1.0.0" }),
    upgradeInstance: async (_instanceId, target) => ({ success: true, version: target }),
  }))

  await assert.rejects(
    () => service.upgrade(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "upgrade_verification_failed",
  )
})

test("joins concurrent upgrades for the same binary", async () => {
  let currentVersion = "1.0.0"
  let upgrades = 0
  let finishUpgrade: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    finishUpgrade = resolve
  })
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: currentVersion }),
    upgradeInstance: async (_instanceId, target) => {
      upgrades += 1
      await gate
      currentVersion = target
      return { success: true, version: target }
    },
  }))

  const first = service.upgrade()
  const second = service.upgrade()
  finishUpgrade?.()

  assert.deepEqual(await Promise.all([first, second]), [
    { success: true, version: "1.1.0" },
    { success: true, version: "1.1.0" },
  ])
  assert.equal(upgrades, 1)
})

test("rejects an upgrade when no matching OpenCode instance is running", async () => {
  const service = new OpenCodeUpdateService(createDeps({ findReadyInstanceId: () => undefined }))

  await assert.rejects(
    () => service.upgrade(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "no_ready_instance",
  )
})
