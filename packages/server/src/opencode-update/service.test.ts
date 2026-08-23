import assert from "node:assert/strict"
import test from "node:test"
import {
  OpenCodeUpdateError,
  OpenCodeUpdateService,
  TARGET_OPENCODE_CHANNEL,
  buildOpenCodeUpgradeCommand,
  compareOpenCodeVersionStrings,
  detectOpenCodePackageManager,
  type OpenCodeUpdateServiceDeps,
} from "./service"

function createDeps(overrides: Partial<OpenCodeUpdateServiceDeps> = {}): OpenCodeUpdateServiceDeps {
  let currentVersion = "0.0.0-beta-1"
  const latestVersion = "0.0.0-beta-2"
  return {
    resolveBinary: () => ({ path: "opencode", label: "OpenCode" }),
    probeBinary: () => ({ valid: true, version: currentVersion }),
    resolveLatestVersion: async () => latestVersion,
    canUpgradeBinary: () => true,
    upgradeBinary: async (_binary, target) => {
      currentVersion = latestVersion
      return { success: true, version: target }
    },
    ...overrides,
  }
}

test("reports the concrete version currently published on the beta channel", async () => {
  const service = new OpenCodeUpdateService(createDeps())

  assert.deepEqual(await service.getStatus(), {
    currentVersion: "0.0.0-beta-1",
    latestVersion: "0.0.0-beta-2",
    updateAvailable: true,
    canUpgrade: true,
  })
})

test("keeps the update visible for a custom binary", async () => {
  const service = new OpenCodeUpdateService(createDeps({ canUpgradeBinary: () => false }))

  assert.deepEqual(await service.getStatus(), {
    currentVersion: "0.0.0-beta-1",
    latestVersion: "0.0.0-beta-2",
    updateAvailable: true,
    canUpgrade: false,
  })
})

test("upgrades the managed OpenCode binary to the advertised version", async () => {
  const calls: Array<{ path: string; target: string }> = []
  let currentVersion = "0.0.0-beta-1"
  const latestVersion = "0.0.0-beta-2"
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: currentVersion }),
    resolveLatestVersion: async () => latestVersion,
    upgradeBinary: async (binary, target) => {
      calls.push({ path: binary.path, target })
      currentVersion = latestVersion
      return { success: true, version: target }
    },
  }))

  assert.deepEqual(await service.upgrade(), { success: true, version: latestVersion })
  assert.deepEqual(calls, [{ path: "opencode", target: TARGET_OPENCODE_CHANNEL }])
})

test("rejects success when the configured binary was not updated", async () => {
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: "0.0.0-beta-1" }),
    upgradeBinary: async (_binary, target) => ({ success: true, version: target }),
  }))

  await assert.rejects(
    () => service.upgrade(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "upgrade_verification_failed",
  )
})

test("accepts a newer beta published while the update command is running", async () => {
  let currentVersion = "0.0.0-beta-1"
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: currentVersion }),
    upgradeBinary: async (_binary, target) => {
      currentVersion = "0.0.0-beta-3"
      return { success: true, version: target }
    },
  }))

  assert.deepEqual(await service.upgrade(), { success: true, version: "0.0.0-beta-3" })
})

test("joins concurrent upgrades for the same binary", async () => {
  let currentVersion = "0.0.0-beta-1"
  const latestVersion = "0.0.0-beta-2"
  let upgrades = 0
  let finishUpgrade: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    finishUpgrade = resolve
  })
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: currentVersion }),
    resolveLatestVersion: async () => latestVersion,
    upgradeBinary: async (_binary, target) => {
      upgrades += 1
      await gate
      currentVersion = latestVersion
      return { success: true, version: target }
    },
  }))

  const first = service.upgrade()
  const second = service.upgrade()
  finishUpgrade?.()

  assert.deepEqual(await Promise.all([first, second]), [
    { success: true, version: latestVersion },
    { success: true, version: latestVersion },
  ])
  assert.equal(upgrades, 1)
})

test("rejects an upgrade for a custom binary", async () => {
  const service = new OpenCodeUpdateService(createDeps({ canUpgradeBinary: () => false }))

  await assert.rejects(
    () => service.upgrade(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "unsupported_binary",
  )
})

test("reports registry failures as update check failures", async () => {
  const service = new OpenCodeUpdateService(createDeps({
    resolveLatestVersion: async () => {
      throw new Error("registry unavailable")
    },
  }))

  await assert.rejects(
    () => service.getStatus(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "update_check_failed",
  )
})

test("builds official V2 package-manager update commands", () => {
  assert.deepEqual(buildOpenCodeUpgradeCommand(TARGET_OPENCODE_CHANNEL, "npm"), {
    command: "npm",
    args: ["install", "-g", "@opencode-ai/cli@beta"],
  })
  assert.deepEqual(buildOpenCodeUpgradeCommand(TARGET_OPENCODE_CHANNEL, "pnpm"), {
    command: "pnpm",
    args: ["add", "-g", "--allow-build=@opencode-ai/cli", "@opencode-ai/cli@beta"],
  })
  assert.deepEqual(buildOpenCodeUpgradeCommand(TARGET_OPENCODE_CHANNEL, "bun"), {
    command: "bun",
    args: ["install", "-g", "--trust", "@opencode-ai/cli@beta"],
  })
})

test("detects the package manager from the binary path or launch environment", () => {
  assert.equal(detectOpenCodePackageManager("/home/me/.local/share/pnpm/opencode2", {}), "pnpm")
  assert.equal(detectOpenCodePackageManager("C:\\Users\\me\\.bun\\bin\\opencode2.exe", {}), "bun")
  assert.equal(detectOpenCodePackageManager("/usr/local/bin/opencode2", { npm_config_user_agent: "yarn/1.22" }), "yarn")
  assert.equal(detectOpenCodePackageManager("C:\\Users\\me\\AppData\\Roaming\\npm\\opencode2.cmd", {}), "npm")
  assert.equal(detectOpenCodePackageManager("C:\\Users\\me\\AppData\\Roaming\\npm\\opencode2.cmd", { npm_config_user_agent: "pnpm/10" }), "npm")
  assert.equal(detectOpenCodePackageManager("/home/ubuntu/bin/opencode2", {}), "npm")
})

test("compares monotonically numbered V2 beta builds numerically", () => {
  assert.equal(compareOpenCodeVersionStrings("0.0.0-beta-10000", "0.0.0-beta-9999") > 0, true)
  assert.equal(compareOpenCodeVersionStrings("0.0.0-beta-9999", "0.0.0-beta-10000") < 0, true)
})
