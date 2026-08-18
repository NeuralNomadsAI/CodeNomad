import assert from "node:assert/strict"
import test from "node:test"
import {
  OpenCodeUpdateError,
  OpenCodeUpdateService,
  buildOpenCodeUpgradeCommand,
  compareOpenCodeVersionStrings,
  detectOpenCodePackageManager,
  type OpenCodeUpdateServiceDeps,
} from "./service"

function createDeps(overrides: Partial<OpenCodeUpdateServiceDeps> = {}): OpenCodeUpdateServiceDeps {
  let currentVersion = "1.0.0"
  return {
    resolveBinary: () => ({ path: "opencode", label: "OpenCode" }),
    probeBinary: () => ({ valid: true, version: currentVersion }),
    canUpgradeBinary: () => true,
    fetchLatestVersion: async () => "1.1.0",
    upgradeBinary: async (_binary, target) => {
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

test("keeps the update visible for a custom binary", async () => {
  const service = new OpenCodeUpdateService(createDeps({ canUpgradeBinary: () => false }))

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

test("upgrades the managed OpenCode binary to the advertised version", async () => {
  const calls: Array<{ path: string; target: string }> = []
  let currentVersion = "1.0.0"
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: currentVersion }),
    upgradeBinary: async (binary, target) => {
      calls.push({ path: binary.path, target })
      currentVersion = target
      return { success: true, version: target }
    },
  }))

  assert.deepEqual(await service.upgrade(), { success: true, version: "1.1.0" })
  assert.deepEqual(calls, [{ path: "opencode", target: "1.1.0" }])
})

test("rejects success when the configured binary was not updated", async () => {
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: "1.0.0" }),
    upgradeBinary: async (_binary, target) => ({ success: true, version: target }),
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
    upgradeBinary: async (_binary, target) => {
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

test("rejects an upgrade for a custom binary", async () => {
  const service = new OpenCodeUpdateService(createDeps({ canUpgradeBinary: () => false }))

  await assert.rejects(
    () => service.upgrade(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "unsupported_binary",
  )
})

test("builds official V2 package-manager update commands", () => {
  assert.deepEqual(buildOpenCodeUpgradeCommand("0.0.0-beta-123", "npm"), {
    command: "npm",
    args: ["install", "-g", "@opencode-ai/cli@0.0.0-beta-123"],
  })
  assert.deepEqual(buildOpenCodeUpgradeCommand("0.0.0-beta-123", "pnpm"), {
    command: "pnpm",
    args: ["add", "-g", "--allow-build=@opencode-ai/cli", "@opencode-ai/cli@0.0.0-beta-123"],
  })
  assert.deepEqual(buildOpenCodeUpgradeCommand("0.0.0-beta-123", "bun"), {
    command: "bun",
    args: ["install", "-g", "--trust", "@opencode-ai/cli@0.0.0-beta-123"],
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
