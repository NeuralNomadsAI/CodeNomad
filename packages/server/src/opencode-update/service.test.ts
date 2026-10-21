import assert from "node:assert/strict"
import test from "node:test"
import { OpenCodeUpdateService, OpenCodeUpdateError,
  resolveLatestOpenCodeVersion, compareOpenCodeVersionStrings,
  type OpenCodeUpdateServiceDeps, type UpgradeOptions } from "./service"
import { MINIMUM_OPENCODE_VERSION as minimum } from "../opencode/runtime-support"
import { rememberRuntime } from "../opencode/compatibility/runtime"
import type { Endpoint } from "@opencode/client/service"
import { probeBinaryVersion } from "../workspaces/spawn"
import { LegacyReplacementError } from "./shared-installation"

function deps(overrides: Partial<OpenCodeUpdateServiceDeps> = {}): OpenCodeUpdateServiceDeps {
  let version = "0.0.0-beta-19271"
  return {
    resolveBinary: () => ({ path: "opencode2", label: "OpenCode" }),
    probeBinary: () => ({ valid: true, version }),
    resolveLatestVersion: async () => minimum,
    canUpgradeBinary: () => true,
    upgradeBinary: async (_binary, target) => { version = target; return { success: true, version: target } },
    inspectRuntime: async () => ({ reload: true }),
    ...overrides,
  }
}

test("missing installs and old releases use one updater; probe failures are not absence", async () => {
  for (const initial of [undefined, "0.0.0-beta-19271", "2.0.6"]) {
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
    probeBinary: () => ({ valid: true, version: "2.0.6" }),
    upgradeBinary: async (_binary, target) => ({ success: true, version: target }),
  }))
  await assert.rejects(wrong.upgrade(), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "upgrade_verification_failed")
})

test("user npm PATH repair remains available without an update and never downgrades", async () => {
  for (const source of ["user"] as const) {
    let migrated = false, installs = 0
    const service = new OpenCodeUpdateService(deps({
      resolveBinary: () => ({ path: migrated ? "common" : source, label: "OpenCode", source: migrated ? "path" : source }),
      probeBinary: () => ({ valid: true, version: "2.1.3" }),
      resolveLatestVersion: async () => minimum,
      upgradeBinary: async (_binary, target) => {
        assert.equal(target, "2.1.3")
        installs++; migrated = true
        return { success: true, version: target }
      },
    }))
    assert.equal((await service.getStatus()).canUpgrade, true)
    assert.equal((await service.getStatus()).needsSharedInstallation, true)
    await service.upgrade()
    assert.equal(installs, 1)
    assert.equal((await service.getStatus()).needsSharedInstallation, false)
    assert.equal((await service.getStatus()).canUpgrade, false)
  }
})

test("OpenCode 1.x npm replacement requires explicit consent and reports failure after removal", async () => {
  let version = "1.18.10", replaced = false
  const requests: UpgradeOptions[] = []
  const legacyReplacement = { path: "C:/npm/opencode.cmd", version: "1.18.10" }
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version }),
    inspectInstallation: () => replaced ? {} : { legacyReplacement },
    upgradeBinary: async (_binary, target, options) => {
      requests.push(options)
      // The first consented attempt fails after removing 1.x.
      if (requests.length === 1) throw new LegacyReplacementError("legacy_removed_install_failed", "registry offline")
      version = target; replaced = true
      return { success: true, version: target }
    },
  }))
  const status = await service.getStatus()
  assert.equal(status.canUpgrade, true)
  assert.deepEqual(status.legacyReplacement, legacyReplacement)
  await assert.rejects(service.upgrade(), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "legacy_replacement_required")
  for (const stale of [{ ...legacyReplacement, version: "1.18.9" }, { ...legacyReplacement, path: "C:/other/opencode.cmd" }]) {
    await assert.rejects(service.upgrade({ replaceLegacy: stale }), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "legacy_replacement_required")
  }
  assert.deepEqual(requests, [], "no installer runs without consent to the exact installation")
  await assert.rejects(service.upgrade({ replaceLegacy: legacyReplacement }), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "legacy_removed_install_failed")
  assert.deepEqual(await service.upgrade({ replaceLegacy: legacyReplacement }), { success: true, version: minimum })
  assert.deepEqual(requests, [{ replaceLegacy: legacyReplacement }, { replaceLegacy: legacyReplacement }])
  assert.equal((await service.getStatus()).legacyReplacement, undefined)
})

test("a broken OpenCode 1.x npm install remains replaceable with consent", async () => {
  let installed = false
  const legacyReplacement = { path: "C:/npm/opencode.cmd", version: "1.18.10" }
  const requests: UpgradeOptions[] = []
  const service = new OpenCodeUpdateService(deps({
    resolveBinary: () => ({ path: installed ? "C:/npm/opencode2.cmd" : legacyReplacement.path, label: "OpenCode", source: "path" }),
    // The published placeholder bin/opencode.exe fails when postinstall did not run.
    probeBinary: () => installed ? { valid: true, version: minimum } : { valid: false, error: "Exited with code 1: postinstall script was not run" },
    inspectInstallation: () => installed ? {} : { legacyReplacement },
    upgradeBinary: async (_binary, target, options) => { requests.push(options); installed = true; return { success: true, version: target } },
  }))
  const status = await service.getStatus()
  assert.equal(status.state, "error")
  assert.equal(status.canUpgrade, true)
  assert.deepEqual(status.legacyReplacement, legacyReplacement)
  await assert.rejects(service.upgrade(), (error: unknown) => error instanceof OpenCodeUpdateError && error.code === "legacy_replacement_required")
  assert.deepEqual(await service.upgrade({ replaceLegacy: legacyReplacement }), { success: true, version: minimum })
  assert.deepEqual(requests, [{ replaceLegacy: legacyReplacement }])
})

test("bounded installation inputs settle before resolution on status and upgrade", async () => {
  const order: string[] = []
  const service = new OpenCodeUpdateService(deps({
    prepareInstallation: async () => { order.push("prepare") },
    resolveBinary: () => { order.push("resolve"); return { path: "opencode2", label: "OpenCode" } },
  }))
  await service.getStatus()
  await service.upgrade()
  assert.deepEqual(order.slice(0, 2), ["prepare", "resolve"])
  assert.equal(order.filter(step => step === "prepare").length, 2)
  assert.ok(order.indexOf("prepare", 1) < order.lastIndexOf("resolve"))
})

test("only an explicit recheck asks for fresh installation probes", async () => {
  const rechecks: boolean[] = []
  const service = new OpenCodeUpdateService(deps({ prepareInstallation: async ({ recheck }) => { rechecks.push(recheck === true) } }))
  await service.getStatus()
  await service.getStatus({ recheck: true })
  await service.upgrade()
  assert.deepEqual(rechecks.slice(0, 2), [false, true])
  assert.ok(rechecks.slice(2).every(recheck => !recheck), "installation and its follow-up reads never force a probe")
})

test("an unusable foreign command still offers OpenCode 2 beside it, never a repair", async () => {
  let installed = false
  const foreignInstallation = { path: "C:/winget/Links/opencode.exe", source: "winget" as const, packageId: "SST.opencode" }
  const service = new OpenCodeUpdateService(deps({
    resolveBinary: () => installed ? { path: "managed", label: "OpenCode", source: "managed" } : { path: foreignInstallation.path, label: "OpenCode", source: "path" },
    probeBinary: path => path === "managed" ? { valid: true, version: minimum } : { valid: false, error: "not a valid application" },
    inspectInstallation: () => ({ foreignInstallation }),
    upgradeBinary: async (_binary, target, options) => {
      assert.deepEqual(options, {})
      installed = true
      return { success: true, version: target }
    },
  }))
  const status = await service.getStatus()
  assert.equal(status.state, "error")
  assert.equal(status.canUpgrade, true)
  assert.deepEqual(status.foreignInstallation, foreignInstallation)
  assert.deepEqual(await service.upgrade(), { success: true, version: minimum })
  const after = await service.getStatus()
  assert.equal(after.installationSource, "managed")
  assert.equal(after.canUpgrade, false)
  assert.deepEqual(after.foreignInstallation, foreignInstallation, "the untouched older command remains reported")
})

test("coalesces overlapping installations and never downgrades a newer version", async () => {
  let upgrades = 0
  let version = "2.0.6"
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
  version = "2.1.999"
  assert.equal((await service.getStatus()).updateAvailable, false)
  assert.equal((await service.upgrade()).version, version)
  assert.equal(upgrades, 1)
})

test("stale daemon needs explicit restart; status and installation never restart it", async () => {
  let daemonVersion = "2.0.6", restarts = 0, reconnects = 0
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
    lifecycle: async () => ({ discover: async () => endpoint("2.0.6"), ensure: async () => endpoint(minimum),
      restart: async () => { restarts++; await gate; return endpoint(minimum) } }),
    reconnect: async () => { reconnects++ },
  }))
  const first = service.start(true), second = service.start(true)
  assert.equal(first, second)
  selected = "replacement"
  release()
  await assert.rejects(first, /selection changed/)
  assert.equal(restarts, 0, "a stale selection must be refused before stopping its daemon")
  assert.equal(reconnects, 0)
})

test("an unverified newer major is not blocked but cannot be downgraded by restart", async () => {
  const value: Endpoint = { url: "http://127.0.0.1:9876" }
  rememberRuntime(value, { version: "3.0.0", pid: 123, discovery: "info" })
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: minimum }),
    resolveLatestVersion: async () => minimum,
    lifecycle: async () => ({ discover: async () => value, ensure: async () => value,
      restart: async () => { assert.fail("must not restart a newer runtime") } }),
  }))
  assert.equal((await service.getStatus()).canUpgrade, false)
  assert.equal((await service.getStatus()).canRestart, false)
  assert.equal((await service.start()).serviceState, "ready")
  assert.equal((await service.getStatus()).versionAssessment, "untested")
  await assert.rejects(service.start(true), /cannot safely replace/)
})

test("optional upgrades retain explicit activation for an admitted but older daemon", async () => {
  let installed = minimum, daemon = minimum, restarts = 0
  const endpoint = () => {
    const value: Endpoint = { url: "http://127.0.0.1:9876" }
    rememberRuntime(value, { version: daemon, pid: 123, discovery: "info" })
    return value
  }
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: installed }), resolveLatestVersion: async () => "2.1.3",
    upgradeBinary: async () => { installed = "2.1.3"; return { success: true, version: installed } },
    lifecycle: async () => ({ discover: async () => endpoint(), ensure: async () => endpoint(),
      restart: async () => { restarts++; daemon = installed; return endpoint() } }),
  }))
  await service.upgrade()
  const available = await service.start()
  assert.equal(available.state, "ready")
  assert.equal(available.serviceState, "restart_available")
  assert.equal(available.canRestart, true)
  assert.equal(restarts, 0)
  assert.equal((await service.start(true)).serviceState, "ready")
  assert.equal(restarts, 1)
})

test("same-version troubleshooting restart is explicit for host and WSL; reload never restarts", async () => {
  for (const binaryPath of ["/fixture/opencode", "\\\\wsl.localhost\\Ubuntu\\usr\\bin\\opencode"]) {
    let pid = 123, restarts = 0, reloads = 0, reconnects = 0
    const endpoint = () => {
      const value: Endpoint = { url: "http://127.0.0.1:9876" }
      rememberRuntime(value, { version: minimum, pid, discovery: "info" })
      return value
    }
    const service = new OpenCodeUpdateService(deps({
      resolveBinary: () => ({ path: binaryPath, label: "Fixture" }),
      probeBinary: () => ({ valid: true, version: minimum }), resolveLatestVersion: async () => minimum,
      lifecycle: async () => ({ discover: async () => endpoint(), ensure: async () => { assert.fail("retain the running daemon") },
        restart: async () => { restarts++; pid++; return endpoint() } }),
      upgradeBinary: async () => { assert.fail("restart must not install a version") },
      reload: async () => { reloads++ }, reconnect: async () => { reconnects++ },
    }))
    const status = await service.getStatus()
    assert.equal(status.serviceState, "ready")
    assert.equal(status.updateAvailable, false)
    assert.equal(status.canRestart, true)
    assert.equal(status.canReload, true)
    await service.start()
    await service.reload()
    assert.equal(restarts, 0)
    assert.equal(pid, 123, "configuration reload preserves the process")
    assert.equal(reloads, 1)
    const restarted = await service.start(true)
    assert.equal(restarts, 1)
    assert.equal(pid, 124)
    assert.equal(reconnects, 2)
    assert.equal(restarted.serviceState, "ready")
    assert.equal(restarted.canRestart, true, "troubleshooting stays available after a restart")
  }
})

test("troubleshooting restart refuses unknown identity/builds and a newer daemon", async () => {
  for (const version of [undefined, "custom-build", "2.1.3"]) {
    const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
    if (version) rememberRuntime(endpoint, { version, pid: 123, discovery: "info" })
    const service = new OpenCodeUpdateService(deps({
      probeBinary: () => ({ valid: true, version: minimum }),
      lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => { assert.fail("no fallback start") },
        restart: async () => { assert.fail("must not stop an unverified or newer daemon") } }),
    }))
    assert.equal((await service.getStatus()).canRestart, false)
    await assert.rejects(service.start(true), /cannot safely replace/)
  }
})

test("same-version restart coalesces, excludes reload, and never retries a failed mutation", async () => {
  let restarts = 0, reconnects = 0
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
  rememberRuntime(endpoint, { version: minimum, pid: 123, discovery: "info" })
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: minimum }),
    lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => { assert.fail("no fallback start") },
      restart: async () => { restarts++; entered(); await gate; throw new Error("restart failed") } }),
    reconnect: async () => { reconnects++ },
  }))
  const first = service.start(true)
  assert.equal(service.start(true), first)
  await reached
  await assert.rejects(service.reload(), /action is in progress/)
  assert.equal(restarts, 1)
  release()
  await assert.rejects(first, /restart failed/)
  assert.equal(restarts, 1)
  assert.equal(reconnects, 0)
})

test("a lifecycle without restart cannot expose or silently emulate it", async () => {
  const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
  rememberRuntime(endpoint, { version: minimum, pid: 123, discovery: "info" })
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: minimum }),
    lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => { assert.fail("no fallback start") } }),
  }))
  assert.equal((await service.getStatus()).canRestart, false)
  await assert.rejects(service.start(true), /restart unavailable/)
})

test("explicit configuration reload is admitted, fenced and serialized with service actions", async () => {
  let selected = "/fixture/opencode", version = minimum, reloads = 0
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  const service = new OpenCodeUpdateService(deps({
    resolveBinary: () => ({ path: selected, label: "Fixture" }),
    probeBinary: () => ({ valid: true, version: minimum }),
    lifecycle: async () => ({ discover: async () => {
      const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
      rememberRuntime(endpoint, { version, pid: 123, discovery: "info" })
      return endpoint
    }, ensure: async () => { throw new Error("reload must not start a daemon") } }),
    reload: async (_binary, assertCurrent) => { entered(); await gate; assertCurrent(); reloads++ },
  }))
  assert.equal((await service.getStatus()).canReload, true)
  assert.equal(reloads, 0)
  const first = service.reload()
  assert.equal(service.reload(), first)
  await reached
  await assert.rejects(service.start(), /action is in progress/)
  selected = "/replacement/opencode"
  await assert.rejects(service.start(true), /action is in progress/, "changing executables cannot overlap the shared-daemon reload")
  await assert.rejects(service.reload(), /action is in progress/, "a different selection must not coalesce with the captured one")
  release()
  await assert.rejects(first, /selection changed/)
  assert.equal(reloads, 0)
  version = "2.0.6"
  await assert.rejects(service.reload(), /opencode_update_required/)
  assert.equal(reloads, 0)
})

test("an in-flight native reload holds shared-service authority across binary changes", async () => {
  let selected = "/fixture/a/opencode", restarts = 0
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
  rememberRuntime(endpoint, { version: minimum, pid: 123, discovery: "info" })
  const service = new OpenCodeUpdateService(deps({
    resolveBinary: () => ({ path: selected, label: "Fixture" }),
    probeBinary: () => ({ valid: true, version: "2.1.3" }),
    lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => endpoint,
      restart: async () => { restarts++; return endpoint } }),
    reload: async (_binary, assertCurrent) => { assertCurrent(); entered(); await gate },
  }))
  const first = service.reload()
  await reached
  selected = "/fixture/b/opencode"
  try {
    await assert.rejects(service.start(true), /action is in progress/)
    await assert.rejects(service.reload(), /action is in progress/)
    assert.equal(restarts, 0)
  } finally { release() }
  await assert.rejects(first, /selection changed/)
  await service.reload()
})

test("beta version comparison remains numeric", () => {
  assert.equal(compareOpenCodeVersionStrings("0.0.0-beta-10000", "0.0.0-beta-9999") > 0, true)
})

test("the native contract floor admits current and newer runtimes without a tested-version allowlist", async () => {
  for (const version of ["2.1.2", "2.1.3", "2.2.0", "3.0.0"]) {
    const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
    rememberRuntime(endpoint, { version, pid: 123, discovery: "info" })
    const service = new OpenCodeUpdateService(deps({
      probeBinary: () => ({ valid: true, version }), resolveLatestVersion: async () => "2.1.3",
      lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => { throw new Error("must retain daemon") } }),
    }))
    const status = await service.start()
    assert.equal(status.minimumVersion, "2.1.2")
    assert.equal(status.recommendedVersion, "2.1.2")
    assert.equal(status.state, "ready")
    assert.equal(status.serviceState, "ready")
    assert.equal(status.versionAssessment, version === "2.1.2" ? "tested" : "untested", "only the current recommendation is release-qualified")
    assert.equal(status.incompatibilityReason, undefined)
    assert.equal(status.canUpgrade, version === "2.1.2", "offer an optional upgrade below the target; never downgrade current or newer runtimes")
    assert.equal(status.canRestart, false)
  }
})

test("older daemons require native replay and correct Code Mode ordering without being started or replaced", async () => {
  for (const version of ["2.0.27", "2.0.32", "2.1.0", "2.1.1"]) {
    const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
    rememberRuntime(endpoint, { version, pid: 123, discovery: "info" })
    const service = new OpenCodeUpdateService(deps({
      probeBinary: () => ({ valid: true, version }), resolveLatestVersion: async () => minimum,
      lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => { throw new Error("must retain daemon") } }),
    }))
    const status = await service.getStatus()
    assert.equal(status.state, "update_required")
    assert.equal(status.incompatibilityReason, "native_contract")
    assert.equal(status.versionAssessment, "incompatible")
    // Admission refuses the daemon itself; it is never started, restarted or replaced implicitly.
    await assert.rejects(service.start(), /opencode_update_required.*Code Mode job ordering fixed in 2.1.2/)
  }
})

test("a current daemon remains usable through an older selected discovery CLI", async () => {
  const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
  rememberRuntime(endpoint, { version: minimum, pid: 123, discovery: "info" })
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: "2.0.3" }),
    lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => { throw new Error("must retain daemon") } }),
  }))
  assert.equal((await service.start()).state, "ready")
  assert.equal((await service.getStatus()).versionAssessment, "tested")
})

test("custom labels are unverified, not an update demand; optional reload follows capabilities", async () => {
  const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
  rememberRuntime(endpoint, { version: "custom-build", pid: 123, discovery: "info" })
  const service = new OpenCodeUpdateService(deps({
    probeBinary: () => ({ valid: true, version: "custom-build" }),
    inspectRuntime: async () => ({ reload: false }),
    lifecycle: async () => ({ discover: async () => endpoint, ensure: async () => { throw new Error("must retain daemon") } }),
    reload: async () => { throw new Error("unavailable operation must not be called") },
  }))
  const status = await service.start()
  assert.equal(status.state, "ready")
  assert.equal(status.serviceState, "ready")
  assert.equal(status.versionAssessment, "untested")
  assert.equal(status.canReload, false)
  assert.equal(status.canUpgrade, false)
  await assert.rejects(service.upgrade(), /custom OpenCode version/)
  await assert.rejects(service.reload(), /does not expose configuration reload/)
})

test("production stdout parsing preserves custom labels through discovery and activation", async () => {
  for (const [stdout, label] of [["custom-build\n", "custom-build"], ["opencode v2.1.2+custom-build\n", "2.1.2+custom-build"],
    ["opencode2 vendor-build\n", "vendor-build"], ["", "unknown"]]) {
    const endpoint: Endpoint = { url: "http://127.0.0.1:9876" }
    rememberRuntime(endpoint, { version: label!, pid: 123, discovery: "info" })
    let discoveries = 0, inspected = 0
    const service = new OpenCodeUpdateService(deps({
      probeBinary: () => probeBinaryVersion(process.execPath, () => ({ status: 0, stdout })),
      lifecycle: async () => ({ discover: async () => { discoveries++; return endpoint }, ensure: async () => { throw new Error("must retain daemon") } }),
      inspectRuntime: async () => { inspected++; return { reload: false } },
    }))
    const status = await service.start()
    assert.equal(status.currentVersion, label)
    assert.equal(status.state, "ready")
    assert.equal(status.versionAssessment, "untested")
    assert.equal(status.canUpgrade, false)
    assert.equal(status.canRestart, false)
    assert.ok(discoveries > 0 && inspected > 0, "successful custom labels reach authenticated contract inspection")
    await assert.rejects(service.upgrade(), /custom OpenCode version/)
  }
})
