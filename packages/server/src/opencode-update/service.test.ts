import assert from "node:assert/strict"
import test from "node:test"
import { OpenCodeUpdateService, OpenCodeUpdateError, buildOpenCodeUpgradeCommand,
  resolveLatestOpenCodeVersion, detectOpenCodePackageManager, compareOpenCodeVersionStrings,
  type OpenCodeUpdateServiceDeps } from "./service"
import { MINIMUM_OPENCODE_VERSION as minimum } from "../opencode/runtime-support"
import { rememberRuntime } from "../opencode/compatibility/runtime"
import type { Endpoint } from "@opencode/client/service"

function deps(overrides: Partial<OpenCodeUpdateServiceDeps> = {}): OpenCodeUpdateServiceDeps {
  let version = "0.0.0-beta-19271"
  return {
    resolveBinary: () => ({ path: "opencode2", label: "OpenCode" }),
    probeBinary: () => ({ valid: true, version }),
    resolveLatestVersion: async () => minimum,
    canUpgradeBinary: () => true,
    upgradeBinary: async (_binary, target) => { version = target; return { success: true, version: target } },
    ...overrides,
  }
}

test("missing installs and old releases use one updater; probe failures are not absence", async () => {
  for (const initial of [undefined, "0.0.0-beta-19271", "2.0.10"]) {
    let version = initial
    const service = new OpenCodeUpdateService(deps({
      probeBinary: () => version ? { valid: true, version } : { valid: false, missing: true },
      upgradeBinary: async (_binary, target) => { version = target; return { success: true, version: target } },
    }))
    const status = await service.getStatus()
    assert.equal(status.state, initial ? "update_required" : "missing")
    assert.equal(status.minimumVersion, minimum)
    assert.equal(status.canUpgrade, true)
    assert.deepEqual(await service.upgrade(), { success: true, version: minimum })
    assert.equal((await service.getStatus()).state, "ready")
  }
  const invalid = new OpenCodeUpdateService(deps({ probeBinary: () => ({ valid: false, error: "EACCES" }) }))
  assert.equal((await invalid.getStatus()).state, "error")
  assert.equal((await invalid.getStatus()).canUpgrade, false)
  await assert.rejects(invalid.upgrade(), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "binary_unavailable")
})

test("offline registry retains local required-update diagnosis", async () => {
  const service = new OpenCodeUpdateService(deps({ resolveLatestVersion: async () => { throw new Error("offline") } }))
  const status = await service.getStatus()
  assert.equal(status.state, "update_required")
  assert.equal(status.checkError, "update_check_failed")
  assert.equal(status.canUpgrade, false)
  await assert.rejects(service.upgrade(), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "update_check_failed")
})

test("custom and WSL executables remain user managed", async () => {
  const service = new OpenCodeUpdateService(deps({
    resolveBinary: () => ({ path: "\\\\wsl.localhost\\Ubuntu\\usr\\bin\\opencode", label: "WSL" }),
    canUpgradeBinary: () => false,
  }))
  const status = await service.getStatus()
  assert.equal(status.target, "wsl")
  assert.equal(status.canUpgrade, false)
  await assert.rejects(service.upgrade(), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "unsupported_binary")
})

test("installation re-resolves the executable and rejects false success", async () => {
  let installed = false
  const service = new OpenCodeUpdateService(deps({
    resolveBinary: () => ({ path: installed ? "managed" : "opencode2", label: "OpenCode" }),
    probeBinary: path => path === "managed" ? { valid: true, version: minimum } : { valid: false, missing: true },
    upgradeBinary: async (_binary, target) => { installed = true; return { success: true, version: target } },
  }))
  assert.equal((await service.upgrade()).version, minimum)
  const wrong = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: "2.0.10" }),
    upgradeBinary: async (_binary, target) => ({ success: true, version: target }),
  }))
  await assert.rejects(wrong.upgrade(), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "upgrade_verification_failed")
})

test("coalesces overlapping installations and never downgrades a newer version", async () => {
  let upgrades = 0
  let version = "2.0.10"
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version }),
    upgradeBinary: async (_binary, target) => { upgrades++; await gate; version = target; return { success: true, version: target } },
  }))
  const first = service.upgrade(), second = service.upgrade()
  release()
  await Promise.all([first, second])
  assert.equal(upgrades, 1)
  version = "2.0.999"
  assert.equal((await service.getStatus()).updateAvailable, false)
  assert.equal((await service.upgrade()).version, version)
  assert.equal(upgrades, 1)
})

test("stale daemon needs explicit restart; status and installation never restart it", async () => {
  let daemonVersion = "2.0.10", restarts = 0, reconnects = 0
  const endpoint = () => {
    const value: Endpoint = { url: "http://127.0.0.1:9876" }
    rememberRuntime(value, { version: daemonVersion, pid: 123, discovery: "info" })
    return value
  }
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: minimum }),
    lifecycle: async () => ({ discover: async () => endpoint(), ensure: async () => endpoint(),
      restart: async () => { restarts++; daemonVersion = minimum; return endpoint() } }),
    reconnect: async () => { reconnects++ },
  }))
  assert.equal((await service.getStatus()).serviceState, "restart_required")
  assert.equal(restarts, 0)
  await assert.rejects(service.start(), /opencode_update_required/)
  assert.equal(restarts, 0)
  assert.equal(reconnects, 0)
  assert.equal((await service.start(true)).serviceState, "ready")
  assert.equal(restarts, 1)
  assert.equal(reconnects, 1)
})

test("resolves exact stable package versions and rejects malformed/prerelease tags", async () => {
  assert.equal(await resolveLatestOpenCodeVersion(async (url) => {
    assert.equal(url, "https://registry.npmjs.org/-/package/%40opencode%2Fcli/dist-tags")
    return new Response(JSON.stringify({ latest: minimum, beta: "2.1.0-beta.1" }))
  }), minimum)
  for (const tags of [{ beta: "0.0.0-beta-19271" }, { latest: "2.1.0-beta.1" }, { latest: "2.0.11;whoami" }]) {
    await assert.rejects(resolveLatestOpenCodeVersion(async () => new Response(JSON.stringify(tags))), /valid version/)
  }
})

test("activation coalesces repeated clicks and refuses a changed selection before reconnect", async () => {
  let selected = "original", restarts = 0, reconnects = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const endpoint = (version: string) => {
    const value: Endpoint = { url: "http://127.0.0.1:9876" }
    rememberRuntime(value, { version, pid: 123, discovery: "info" })
    return value
  }
  const service = new OpenCodeUpdateService(deps({
    resolveBinary: () => ({ path: selected, label: selected }),
    probeBinary: () => ({ valid: true, version: minimum }),
    lifecycle: async () => ({ discover: async () => endpoint("2.0.10"), ensure: async () => endpoint(minimum),
      restart: async () => { restarts++; await gate; return endpoint(minimum) } }),
    reconnect: async () => { reconnects++ },
  }))
  const first = service.start(true), second = service.start(true)
  assert.equal(first, second)
  selected = "replacement"
  release()
  await assert.rejects(first, /selection changed/)
  assert.equal(restarts, 1)
  assert.equal(reconnects, 0)
})

test("an unsupported latest or newer daemon cannot trigger a downgrade or restart", async () => {
  const value: Endpoint = { url: "http://127.0.0.1:9876" }
  rememberRuntime(value, { version: "3.0.0", pid: 123, discovery: "info" })
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: minimum }),
    resolveLatestVersion: async () => "3.0.0",
    lifecycle: async () => ({ discover: async () => value, ensure: async () => value,
      restart: async () => { assert.fail("must not restart a newer runtime") } }),
  }))
  assert.equal((await service.getStatus()).canUpgrade, false)
  assert.equal((await service.getStatus()).canRestart, false)
  await assert.rejects(service.upgrade(), /opencode_update_required/)
  await assert.rejects(service.start(true), /not an older runtime/)
})

test("legacy package-manager helpers retain V2 commands and beta comparison", () => {
  assert.deepEqual(buildOpenCodeUpgradeCommand(minimum, "npm"), { command: "npm", args: ["install", "-g", `@opencode/cli@${minimum}`] })
  assert.deepEqual(buildOpenCodeUpgradeCommand(minimum, "pnpm"), { command: "pnpm", args: ["add", "-g", "--allow-build=@opencode/cli", `@opencode/cli@${minimum}`] })
  assert.equal(detectOpenCodePackageManager("/home/me/.local/share/pnpm/opencode2", {}), "pnpm")
  assert.equal(detectOpenCodePackageManager("C:\\Users\\me\\.bun\\bin\\opencode2.exe", {}), "bun")
  assert.equal(compareOpenCodeVersionStrings("0.0.0-beta-10000", "0.0.0-beta-9999") > 0, true)
})
