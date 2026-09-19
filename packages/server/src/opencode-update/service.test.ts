import assert from "node:assert/strict"
import test from "node:test"
import {
  OpenCodeUpdateError,
  OpenCodeUpdateService,
  TARGET_OPENCODE_CHANNEL,
  buildOpenCodeUpgradeCommand,
  compareOpenCodeVersionStrings,
  detectOpenCodePackageManager,
  resolveLatestOpenCodeVersion,
  type OpenCodeUpdateServiceDeps,
} from "./service"

function createDeps(overrides: Partial<OpenCodeUpdateServiceDeps> = {}): OpenCodeUpdateServiceDeps {
  let currentVersion = "0.0.0-beta-19271"
  const latestVersion = "2.0.10"
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

test("offers the current stable release to an installation on the old beta package", async () => {
  const service = new OpenCodeUpdateService(createDeps())

  assert.deepEqual(await service.getStatus(), {
    currentVersion: "0.0.0-beta-19271",
    latestVersion: "2.0.10",
    updateAvailable: true,
    canUpgrade: true,
  })
})

test("keeps the update visible for a custom binary", async () => {
  const service = new OpenCodeUpdateService(createDeps({ canUpgradeBinary: () => false }))

  assert.deepEqual(await service.getStatus(), {
    currentVersion: "0.0.0-beta-19271",
    latestVersion: "2.0.10",
    updateAvailable: true,
    canUpgrade: false,
  })
})

test("upgrades the managed OpenCode binary to the advertised version", async () => {
  const calls: Array<{ path: string; target: string }> = []
  let currentVersion = "0.0.0-beta-19271"
  const latestVersion = "2.0.10"
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
  assert.deepEqual(calls, [{ path: "opencode", target: latestVersion }])
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

test("rejects a different release installed while the update command is running", async () => {
  let currentVersion = "2.0.9"
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: currentVersion }),
    upgradeBinary: async (_binary, target) => {
      currentVersion = "2.0.11"
      return { success: true, version: target }
    },
  }))

  await assert.rejects(
    () => service.upgrade(),
    (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "upgrade_verification_failed",
  )
})

test("joins concurrent upgrades for the same binary", async () => {
  let currentVersion = "2.0.9"
  const latestVersion = "2.0.10"
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

test("resolves stable latest from the current package even when a newer beta is available", async () => {
  const version = await resolveLatestOpenCodeVersion(async (url, init) => {
    assert.equal(url, "https://registry.npmjs.org/-/package/%40opencode%2Fcli/dist-tags")
    assert.deepEqual(init?.headers, { Accept: "application/json" })
    return new Response(JSON.stringify({ latest: "2.0.10", beta: "2.1.0-beta.1" }))
  })

  assert.equal(version, "2.0.10")
})

test("rejects malformed registry dist-tags data", async () => {
  await assert.rejects(
    () => resolveLatestOpenCodeVersion(async () => new Response(JSON.stringify({ "dist-tags": { beta: "beta" } }))),
    /did not resolve to a valid version/,
  )
})

test("builds official V2 package-manager update commands", () => {
  assert.equal(TARGET_OPENCODE_CHANNEL, "latest")
  assert.deepEqual(buildOpenCodeUpgradeCommand("2.0.10", "npm"), {
    command: "npm",
    args: ["install", "-g", "@opencode/cli@2.0.10"],
  })
  assert.deepEqual(buildOpenCodeUpgradeCommand("2.0.10", "pnpm"), {
    command: "pnpm",
    args: ["add", "-g", "--allow-build=@opencode/cli", "@opencode/cli@2.0.10"],
  })
  assert.deepEqual(buildOpenCodeUpgradeCommand("2.0.10", "bun"), {
    command: "bun",
    args: ["install", "-g", "--trust", "@opencode/cli@2.0.10"],
  })
  assert.deepEqual(buildOpenCodeUpgradeCommand("2.0.10", "yarn"), {
    command: "yarn",
    args: ["global", "add", "@opencode/cli@2.0.10"],
  })
})

test("does not downgrade installations newer than the stable release", async () => {
  const service = new OpenCodeUpdateService(createDeps({
    probeBinary: () => ({ valid: true, version: "2.0.11" }),
    upgradeBinary: async () => { assert.fail("a newer installation must not be overwritten") },
  }))
  assert.equal((await service.getStatus()).updateAvailable, false)
  assert.deepEqual(await service.upgrade(), { success: true, version: "2.0.11" })
})

test("rejects a missing or prerelease latest tag instead of falling back to beta", async () => {
  for (const tags of [{ beta: "0.0.0-beta-19271" }, { latest: "2.1.0-beta.1" }]) {
    await assert.rejects(
      resolveLatestOpenCodeVersion(async () => new Response(JSON.stringify(tags))),
      /did not resolve to a valid version/,
    )
  }
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
