// node --import tsx scripts/test-service-supervision-binary-native.mjs OUTPUT_DIRECTORY
// Windows-only, real npm upgrade and Task Scheduler. Owns every service/task it
// creates; the personal registration is fingerprinted read-only before/after.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { acquireWindowsSupervision } from "../packages/server/src/host-lifetime/service-supervision-resolver.ts"
import { ServiceSupervisionSettings } from "../packages/server/src/host-lifetime/service-supervision-service.ts"
import { readSupervisionHealth } from "../packages/server/src/host-lifetime/service-supervision-health.ts"
import { readNativeScheduleIncarnation } from "../packages/server/src/opencode/missions/native-schedule-transport-identity.ts"
import { installSharedOpenCode, npmExecutable } from "../packages/server/src/opencode-update/shared-installation.ts"
import { bundledNpm } from "../packages/server/src/opencode-update/npm-runtime.ts"
import { OpenCodeUpdateService } from "../packages/server/src/opencode-update/service.ts"
import { rememberRuntime } from "../packages/server/src/opencode/compatibility/runtime.ts"
import { windowsStorageScript, verifyWindowsStorageEvidence } from "../packages/server/src/host-lifetime/windows-storage.ts"

assert.equal(process.platform, "win32")
const root = path.resolve(process.argv[2])
await mkdir(root, { recursive: false })
const shared = path.join(os.homedir(), ".local/state/opencode/service.json")
const fingerprint = async () => ({ sha256: createHash("sha256").update(await readFile(shared)).digest("hex"),
  LastWriteTimeUtc: (await stat(shared)).mtime.toISOString() })
const result = { root, before: await fingerprint(), checks: [] }
const exec = promisify(execFile), node = process.execPath, npm = bundledNpm(node)
assert.ok(npm)
const psFile = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
const ps = async script => (await exec(psFile, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script, "utf16le").toString("base64")],
{ windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  env: { ...process.env, PSModulePath: path.join(path.dirname(psFile), "Modules") } })).stdout.trim()
const literal = value => `'${value.replaceAll("'", "''")}'`
await ps(`$u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.DirectorySecurity]::new();
  $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false); foreach($s in @($u,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
  $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }; Set-Acl -LiteralPath ${literal(root)} -AclObject $a`)
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  COMSPEC: path.join(process.env.SystemRoot, "System32/cmd.exe"), PATH: `${path.dirname(node)};${process.env.SystemRoot}/System32`,
  npm_config_prefix: path.join(root, "npm prefix"), npm_config_cache: path.join(root, "npm cache"),
  npm_config_userconfig: path.join(root, "npmrc"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
for (const [key, name] of Object.entries({ HOME: "home", USERPROFILE: "home", OPENCODE_TEST_HOME: "home",
  APPDATA: "appdata", LOCALAPPDATA: "localappdata", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state",
  XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", TEMP: "tmp", TMP: "tmp" })) {
  env[key] = path.join(root, name); await mkdir(env[key], { recursive: true })
}
const run = (file, args, timeout = 60000) => exec(file, args, { env, cwd: root, windowsHide: true, timeout, maxBuffer: 1024 * 1024 })
const binary = npmExecutable(env.npm_config_prefix), bootstrap = path.join(root, "cleanup controller.exe")
const registration = path.join(env.XDG_STATE_HOME, "opencode/service.json")
let selected = path.join(env.npm_config_prefix, "opencode.cmd"), scope, key, serviceMayExist = false
const health = () => readSupervisionHealth(registration)
async function until(read, predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  let value
  do { value = await read(); if (predicate(value)) return value; await setTimeout(400) } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
// Production's complete ancestor policy is kept intact. This test evaluates
// only the run-owned private leaf, qualifying native resources/upgrade mechanics.
const policy = { async verify(file, directory) {
  const entry = await lstat(file)
  assert.ok(!entry.isSymbolicLink() && (directory ? entry.isDirectory() : entry.isFile() && entry.nlink === 1))
  const evidence = JSON.parse(await ps(windowsStorageScript(file).script))
  evidence.entries = evidence.entries.slice(0, 1)
  verifyWindowsStorageEvidence(JSON.stringify(evidence), directory, 0, 256 * 1024 * 1024)
} }
const acquire = () => acquireWindowsSupervision({ selectedBinary: () => selected, environment: env,
  root: path.join(root, "supervision"), policy, artifactPolicy: policy })
const settings = new ServiceSupervisionSettings(acquire)
const status = async () => {
  try { return JSON.parse(await readFile(path.join(scope.store.directory, "windows-status.json"), "utf8")) }
  catch (error) { if (error.code === "ENOENT") return {}; throw error }
}
const recorded = name => { result.checks.push(name); console.log(name) }
try {
  await run(node, [npm, "install", "--global", "--prefix", env.npm_config_prefix, "--no-audit", "--no-fund",
    "--registry=https://registry.npmjs.org", "@opencode/cli@2.2.1"], 300000)
  await copyFile(binary, bootstrap)
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve))
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); assert.notEqual(port, 28894)
  await run(bootstrap, ["service", "set", "port", String(port)])
  scope = await acquire(); key = (await scope.store.read()).key
  assert.equal(scope.selectedTarget.binary, binary, "published npm shim resolves to the owned native image")
  serviceMayExist = true
  await settings.control({ serviceKey: key, requestID: randomUUID(), expectedRevision: 0, action: "on" }, () => {})
  let live = await until(health, value => value.state === "healthy", "initial 2.2.1")
  assert.equal(readNativeScheduleIncarnation(registration).version, "2.2.1")
  result.initial = live
  const alternate = path.join(root, "other executable with spaces.exe")
  await copyFile(binary, alternate); selected = alternate
  assert.equal((await settings.read()).desired, "on")
  assert.equal((await scope.store.read()).target.binary, binary, "profile selection alone preserves the published target")
  await settings.selectBinary()
  assert.equal((await scope.store.read()).target.binary, alternate)
  assert.deepEqual(await health(), live)
  recorded("absolute selection with spaces keeps healthy incumbent")
  selected = binary; await settings.selectBinary()
  const lock = path.join(env.npm_config_prefix, ".codenomad-opencode-install.lock")
  await writeFile(lock, "isolated installation in progress")
  await run(bootstrap, ["service", "stop"])
  await until(health, value => value.state === "absent", "stopped under installation lock")
  const firstFailure = await until(status, value => value.cause === "start-failed" && value.retryAt, "install backoff")
  await setTimeout(7000)
  assert.equal((await health()).state, "absent")
  const nextFailure = await status()
  assert.notEqual(nextFailure.lastAttemptAt, firstFailure.lastAttemptAt)
  assert.ok(Date.parse(nextFailure.retryAt) > Date.parse(nextFailure.lastAttemptAt))
  await rm(lock)
  live = await until(health, value => value.state === "healthy", "unlocked automatic recovery")
  recorded("installation lock waits with bounded backoff, then recovers without backend control")
  const hidden = `${binary}.qualification-hidden`
  await rename(binary, hidden)
  await run(bootstrap, ["service", "stop"])
  await until(health, value => value.state === "absent", "missing executable")
  await until(status, value => value.cause === "start-failed" && value.retryAt, "missing backoff")
  await writeFile(binary, "partial installation")
  await setTimeout(7000)
  assert.equal((await health()).state, "absent")
  await rm(binary); await rename(hidden, binary)
  live = await until(health, value => value.state === "healthy", "complete image recovery")
  recorded("missing and partial executable never launch a PATH fallback")
  const packageFile = path.resolve(binary, "../../package.json"), packageBytes = await readFile(packageFile)
  await writeFile(packageFile, JSON.stringify({ name: "changed-provenance", bin: { opencode: "./bin/opencode.exe" } }))
  await run(bootstrap, ["service", "stop"])
  await until(health, value => value.state === "absent", "provenance refusal")
  await until(status, value => value.cause === "start-failed" && value.retryAt, "provenance backoff")
  await setTimeout(4000); assert.equal((await health()).state, "absent")
  await writeFile(packageFile, packageBytes)
  live = await until(health, value => value.state === "healthy", "provenance restoration")
  recorded("changed package provenance refuses spawn until exact restoration")
  const beforeUpgrade = await health(), beforeIdentity = readNativeScheduleIncarnation(registration)
  await installSharedOpenCode("2.2.3", { home: env.HOME, env, node, npm, registerPath: async () => {},
    probe: async file => ({ valid: true, version: (await run(file, ["--version"])).stdout.trim().replace(/^opencode2? v?/, "") }) })
  assert.deepEqual(await health(), beforeUpgrade)
  assert.deepEqual(readNativeScheduleIncarnation(registration), beforeIdentity)
  recorded("real native npm upgrade 2.2.1 to 2.2.3 preserves healthy PID/id")
  await run(bootstrap, ["service", "stop"])
  const externalRecovery = await until(health, value => value.state === "healthy" && value.id !== beforeUpgrade.id,
    "external native upgrade recovery without publication")
  assert.equal(readNativeScheduleIncarnation(registration).version, "2.2.3")
  recorded("complete same-package native upgrade recovers automatically with CodeNomad closed")
  await settings.selectBinary()
  assert.deepEqual(await health(), externalRecovery)
  const installed = (await run(binary, ["--version"])).stdout.trim()
  assert.match(installed, /2\.2\.3$/)
  result.upgrade = { from: beforeIdentity.version, installed, unchangedIncarnation: true }
  recorded("explicit post-install publication preserves the recovered incarnation")
  const endpoint = async () => {
    const value = await health()
    if (value.state !== "healthy") return undefined
    const identity = readNativeScheduleIncarnation(registration), target = { url: identity.url }
    rememberRuntime(target, { version: identity.version, pid: identity.pid, discovery: "info" }); return target
  }
  const updater = new OpenCodeUpdateService({ resolveBinary: () => ({ path: selected, label: "isolated" }),
    probeBinary: async file => ({ valid: true, version: (await run(file, ["--version"])).stdout.trim().replace(/^opencode2? v?/, "") }),
    resolveLatestVersion: async () => "2.2.3", canUpgradeBinary: () => false, upgradeBinary: async () => { throw new Error() },
    inspectRuntime: async () => ({ reload: true }), publishSupervisionTarget: check => settings.selectBinary(check),
    lifecycle: async () => ({ discover: endpoint, ensure: endpoint, restart: async () => {
      const current = await scope.store.read()
      assert.equal(current.target.binary, selected)
      assert.equal(current.target.sha256, (await acquire()).selectedTarget.sha256)
      await run(bootstrap, ["service", "stop"])
      await run(binary, ["service", "start"])
      await until(health, value => value.state === "healthy" && value.id !== externalRecovery.id, "explicit new incarnation")
      return endpoint()
    } }),
  })
  await updater.start(true)
  assert.equal(readNativeScheduleIncarnation(registration).version, "2.2.3")
  result.restarted = await health()
  recorded("explicit restart sees published target before stop and adopts 2.2.3")
  const manifest = await scope.store.read()
  const concurrent = await Promise.allSettled([scope.store.control({ action: "off", requestID: randomUUID(), expectedRevision: manifest.revision }),
    scope.store.control({ action: "select-binary", requestID: randomUUID(), expectedRevision: manifest.revision, target: { ...manifest.target, binary: alternate } })])
  assert.equal(concurrent.filter(item => item.status === "fulfilled").length, 1)
  assert.equal((await scope.store.read()).revision, manifest.revision + 1)
  recorded("concurrent OFF/selection has exactly one revision winner")
  result.success = true
} catch (error) {
  result.failure = { name: error.name, message: error.message }; throw error
} finally {
  if (scope) {
    // Fence any incomplete selection before removing the owned task resources.
    const beforeOff = await scope.store.read()
    const off = await scope.store.control({ action: "off", requestID: randomUUID(), expectedRevision: beforeOff.revision })
    await scope.adapter.reconcile(off.revision)
  }
  if (serviceMayExist) { await run(bootstrap, ["service", "stop"]); await until(health, value => value.state === "absent", "cleanup exit") }
  if (key) {
    const tasks = await ps(`ConvertTo-Json -InputObject @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'CodeNomad-OpenCode-${key}-*' } | Select-Object -ExpandProperty TaskName) -Compress`)
    assert.deepEqual(JSON.parse(tasks), []); result.tasksRemoved = true
  }
  result.after = await fingerprint(); assert.deepEqual(result.after, result.before)
  result.sharedRegistrationUnchanged = true
  await writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
