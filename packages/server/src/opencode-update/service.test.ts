import assert from "node:assert/strict"
import test from "node:test"
import { OpenCodeUpdateError, OpenCodeUpdateService, type OpenCodeUpdateServiceDeps } from "./service"

function createDeps(overrides: Partial<OpenCodeUpdateServiceDeps> = {}): OpenCodeUpdateServiceDeps {
  return {
    resolveBinary: () => ({ path: "opencode", label: "OpenCode" }),
    probeBinary: () => ({ valid: true, version: "1.0.0" }),
    findReadyInstanceId: () => "workspace-1",
    fetchLatestVersion: async () => "1.1.0",
    upgradeInstance: async (_instanceId, target) => ({ success: true, version: target }),
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

test("upgrades through the matching OpenCode instance to the advertised version", async () => {
  const calls: Array<{ instanceId: string; target: string }> = []
  const service = new OpenCodeUpdateService(createDeps({
    upgradeInstance: async (instanceId, target) => {
      calls.push({ instanceId, target })
      return { success: true, version: target }
    },
  }))

  assert.deepEqual(await service.upgrade(), { success: true, version: "1.1.0" })
  assert.deepEqual(calls, [{ instanceId: "workspace-1", target: "1.1.0" }])
})

test("rejects an upgrade when no matching OpenCode instance is running", async () => {
  const service = new OpenCodeUpdateService(createDeps({ findReadyInstanceId: () => undefined }))

  await assert.rejects(
    () => service.upgrade(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "no_ready_instance",
  )
})
