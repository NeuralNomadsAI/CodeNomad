import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { stringify } from "yaml"
import { resolveConfigLocation } from "../config/location"
import { SettingsService } from "./service"
import { ProfileEnvironmentReadError, readAdmissionEnvironment } from "./admission-environment"
import { WorkspaceManager } from "../workspaces/manager"

async function fixture(t: TestContext, filename = "profile.yaml") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-admission-environment-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const location = resolveConfigLocation(path.join(root, filename))
  const logs: unknown[] = []
  const logger = { child: () => logger, warn: (...args: unknown[]) => logs.push(args), info: (...args: unknown[]) => logs.push(args) }
  await fs.writeFile(location.configYamlPath, stringify({ server: { environmentVariables: { PROFILE_VALUE: "initial" } } }))
  const settings = new SettingsService(location, undefined, logger as never)
  const write = (value: unknown) => fs.writeFile(location.configYamlPath, stringify(value))
  return { root, location, settings, write, logs }
}

function managerFor(settings: SettingsService, platform: NodeJS.Platform = "win32") {
  // Exercise the real send-preparation method, without connecting or launching a daemon.
  const manager = Object.create(WorkspaceManager.prototype) as WorkspaceManager
  Object.assign(manager, { options: { settings, platform }, workspaces: new Map([["owned", { status: "ready" }]]) })
  return manager
}

async function unavailable(operation: Promise<unknown>) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ProfileEnvironmentReadError)
    assert.equal(error.code, "PROFILE_ENVIRONMENT_UNAVAILABLE")
    assert.equal(error.message, "Profile environment is unavailable")
    assert.equal("cause" in error, false)
    assert.doesNotMatch(String(error.stack), /secret-value|secret-path|EACCES/)
    return true
  })
}

test("admission reads external edits/removals without updating the display cache", async t => {
  const { settings, write, location, logs } = await fixture(t)
  assert.deepEqual(settings.getOwner("config", "server").environmentVariables, { PROFILE_VALUE: "initial" })
  assert.deepEqual(await settings.readEnvironmentForAdmission(), { PROFILE_VALUE: "initial" })
  await write({ server: { environmentVariables: { PROFILE_VALUE: "external", ADDED: "new" } } })
  assert.deepEqual(await settings.readEnvironmentForAdmission(), { PROFILE_VALUE: "external", ADDED: "new" })
  assert.deepEqual(settings.getOwner("config", "server").environmentVariables, { PROFILE_VALUE: "initial" })
  await write({ server: { environmentVariables: {} } })
  assert.deepEqual(await settings.readEnvironmentForAdmission(), {})
  await write({ ui: { theme: "dark" } })
  assert.deepEqual(await settings.readEnvironmentForAdmission(), {})
  await fs.unlink(location.configYamlPath)
  assert.deepEqual(await settings.readEnvironmentForAdmission(), {})
  assert.deepEqual(logs, [])
})

test("only the exact configured canonical path is authoritative, with no state/JSON/default-path fallback", async t => {
  const { root, location, settings, logs } = await fixture(t, "custom-secret-path.yml")
  await fs.writeFile(path.join(root, "config.yaml"), "server:\n  environmentVariables:\n    OTHER_PROFILE: wrong\n")
  await fs.writeFile(location.stateYamlPath, "server:\n  environmentVariables:\n    FROM_STATE: wrong\n")
  await fs.writeFile(location.legacyJsonPath, JSON.stringify({ preferences: { environmentVariables: { FROM_JSON: "wrong" } } }))
  assert.deepEqual(await settings.readEnvironmentForAdmission(), { PROFILE_VALUE: "initial" })
  await fs.unlink(location.configYamlPath)
  assert.deepEqual(await settings.readEnvironmentForAdmission(), {})
  assert.deepEqual(logs, [])
})

test("directory, YAML and legacy JSON location inputs use the resolved canonical path", async t => {
  const { root } = await fixture(t)
  for (const input of [root, path.join(root, "named.yml"), path.join(root, "legacy.json")]) {
    const location = resolveConfigLocation(input)
    await fs.writeFile(location.configYamlPath, "server:\n  environmentVariables:\n    VALUE: correct\n")
    assert.deepEqual(await readAdmissionEnvironment(location), { VALUE: "correct" })
  }
})

test("successful reads return independent snapshots and reflect persisted preferences patches", async t => {
  const { settings } = await fixture(t)
  settings.mergePatchOwner("config", "server", { environmentVariables: { PROFILE_VALUE: "patched", EMPTY: "" } })
  const first = await settings.readEnvironmentForAdmission()
  first.PROFILE_VALUE = "local mutation"
  assert.deepEqual(await settings.readEnvironmentForAdmission(), { PROFILE_VALUE: "patched", EMPTY: "" })
  settings.mergePatchOwner("config", "server", { environmentVariables: { PROFILE_VALUE: null } })
  assert.deepEqual(await settings.readEnvironmentForAdmission(), { EMPTY: "" })
})

test("startup migration of legacy preferences still supplies canonical admission values", async t => {
  const { location } = await fixture(t)
  await fs.writeFile(location.configYamlPath, stringify({ preferences: { environmentVariables: { MIGRATED: "correct" } } }))
  const logger = { child: () => logger, warn() {}, info() {} }
  const settings = new SettingsService(location, undefined, logger as never)
  assert.deepEqual(await settings.readEnvironmentForAdmission(), { MIGRATED: "correct" })
})

test("invalid YAML/shape/variables fail closed and never reflect parser details or log secrets", async t => {
  const { settings, location, write, logs } = await fixture(t)
  settings.getOwner("config", "server") // Prime the old cache to prove it cannot be a fallback.
  const invalid = [
    "server:\n  environmentVariables: [secret-value\n",
    "server: {}\nserver: secret-value\n",
    "- secret-value\n",
    "null\n",
    "",
    "server: !unknown secret-value\n",
  ]
  for (const content of invalid) {
    await fs.writeFile(location.configYamlPath, content)
    await unavailable(settings.readEnvironmentForAdmission())
  }
  for (const value of [
    { server: null },
    { server: { environmentVariables: null } },
    { server: { environmentVariables: ["secret-value"] } },
    { server: { environmentVariables: { VALUE: 42 } } },
    { server: { environmentVariables: { "BAD=KEY": "secret-value" } } },
    { server: { environmentVariables: { "": "secret-value" } } },
    { server: { environmentVariables: { VALUE: "secret-value\0" } } },
    { preferences: { environmentVariables: { VALUE: "secret-value" } } },
  ]) {
    await write(value)
    await unavailable(settings.readEnvironmentForAdmission())
  }
  await fs.writeFile(location.configYamlPath, Buffer.from([0xff, 0xfe, 0x80]))
  await unavailable(settings.readEnvironmentForAdmission())
  assert.deepEqual(logs, [])
})

test("oversized files, including growth after stat, and alias expansion are bounded", async t => {
  const { settings, location, logs } = await fixture(t)
  await fs.writeFile(location.configYamlPath, `#${"x".repeat(1024 * 1024)}`)
  await unavailable(settings.readEnvironmentForAdmission())
  const open = fs.open
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    const stat = await handle.stat()
    t.mock.method(handle, "stat", async () => ({ ...stat, size: 1, isFile: () => true }))
    return handle
  })
  await unavailable(settings.readEnvironmentForAdmission())
  t.mock.restoreAll()
  await fs.writeFile(location.configYamlPath, "a: &a [secret-value]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nserver: {}\n")
  await unavailable(settings.readEnvironmentForAdmission())
  assert.deepEqual(logs, [])
})

test("unreadable files and non-files do not become empty defaults", async t => {
  const { settings, location, logs } = await fixture(t)
  const open = fs.open
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === location.configYamlPath) throw Object.assign(new Error("secret-value secret-path"), { code: "EACCES" })
    return open(...args)
  })
  await unavailable(settings.readEnvironmentForAdmission())
  t.mock.restoreAll()
  await fs.unlink(location.configYamlPath)
  await fs.mkdir(location.configYamlPath)
  await unavailable(settings.readEnvironmentForAdmission())
  assert.deepEqual(logs, [])
})

test("cancelled and slow file reads refuse admission; late handles are closed", async t => {
  const { settings, location } = await fixture(t)
  const controller = new AbortController()
  controller.abort(new Error("secret-value"))
  await unavailable(settings.readEnvironmentForAdmission(controller.signal))
  const open = fs.open
  const handle = await open(location.configYamlPath, "r")
  let release!: (handle: Awaited<ReturnType<typeof fs.open>>) => void
  t.mock.method(fs, "open", () => new Promise(resolve => { release = resolve }))
  const operation = settings.readEnvironmentForAdmission()
  await unavailable(operation)
  release(handle)
  // Let the late read's finally close the descriptor, without admitting anything.
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(handle.stat(), /closed/)
})

test("native preparation builds a fresh full Windows snapshot and restores removed overrides", async t => {
  const { settings, write } = await fixture(t)
  const manager = managerFor(settings)
  const existing = process.env.CODENOMAD_TEST_ADMISSION_BASE
  process.env.CODENOMAD_TEST_ADMISSION_BASE = "host-base"
  t.after(() => {
    if (existing === undefined) delete process.env.CODENOMAD_TEST_ADMISSION_BASE
    else process.env.CODENOMAD_TEST_ADMISSION_BASE = existing
  })
  await write({ server: { environmentVariables: {
    codenomad_test_admission_base: "override", PROVIDER_API_KEY: "intended", opencode_db: "excluded",
    xdg_state_home: "excluded", CODENOMAD_BOOTSTRAP_TOKEN: "excluded", opencode_password: "excluded",
  } } })
  const snapshot = await manager.getSessionEnvironment("owned")
  assert.equal(snapshot.codenomad_test_admission_base, "override")
  assert.equal(snapshot.CODENOMAD_TEST_ADMISSION_BASE, undefined)
  assert.equal(snapshot.PROVIDER_API_KEY, "intended")
  assert.equal(snapshot.opencode_db, undefined)
  assert.equal(snapshot.xdg_state_home, undefined)
  assert.equal(snapshot.CODENOMAD_BOOTSTRAP_TOKEN, undefined)
  assert.equal(snapshot.opencode_password, undefined)
  const baseline = await manager.getSessionEnvironment("owned")
  await write({ server: { environmentVariables: {} } })
  const restored = await manager.getSessionEnvironment("owned")
  assert.equal(restored.CODENOMAD_TEST_ADMISSION_BASE, "host-base")
  assert.equal(restored.codenomad_test_admission_base, undefined)
  assert.equal(baseline.codenomad_test_admission_base, "override")
})

test("failed fresh read prevents execution-host environment construction and both native calls", async t => {
  const { settings, location, logs } = await fixture(t)
  const manager = managerFor(settings)
  const reads: string[] = []
  Object.assign(manager, { workspaces: new Map([["owned", { status: "ready", wslDistro: "must-not-launch" }]]) })
  let environmentCalls = 0
  let promptCalls = 0
  const admit = async () => {
    const variables = await manager.getSessionEnvironment("owned")
    environmentCalls += 1
    reads.push(...Object.keys(variables))
    promptCalls += 1
  }
  await fs.writeFile(location.configYamlPath, "server:\n  environmentVariables: [secret-value\n")
  await unavailable(admit())
  assert.equal(environmentCalls, 0)
  assert.equal(promptCalls, 0)
  assert.deepEqual(reads, [])
  assert.deepEqual(logs, [])
})
