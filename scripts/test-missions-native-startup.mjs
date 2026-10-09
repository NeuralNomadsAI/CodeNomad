// One read-copied artifact, private native managed service only. No product activation.
// Startup/claim probe from the superseded signed recurring model; simple recurring
// acceptance lives in scripts/test-recurring-simple-native.mjs.
// node scripts/test-missions-native-startup.mjs <absolute-cli> [--loader-only] [--bun <existing-bun>] [--claim-resume|--claim-timer|--claim-watcher]
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { startClaimProvider, runClaimResume } from "./missions-native-startup/claim-resume.mjs"
import { captureTimerGraph, runTimerScope } from "./missions-native-startup/timer-scope.mjs"
import { runWatcherScope } from "./missions-native-startup/watcher-scope.mjs"

const source = process.argv[2]
assert.ok(source && path.isAbsolute(source), "Pass an absolute existing CLI artifact; no PATH/default discovery")
const loaderOnly = process.argv.includes("--loader-only")
const claimTimer = process.argv.includes("--claim-timer")
const claimWatcher = process.argv.includes("--claim-watcher")
assert.ok(!claimTimer || !claimWatcher, "Separate lifetime probe modes")
const claimResume = claimTimer || claimWatcher || process.argv.includes("--claim-resume")
assert.ok(!claimResume || !loaderOnly, "Claim probe requires actual private managed service")
const bunArgument = process.argv.indexOf("--bun")
const bun = bunArgument === -1 ? undefined : process.argv[bunArgument + 1]
assert.ok(bunArgument === -1 || bun && path.isAbsolute(bun), "Bun control must be an explicit existing executable; never install/discover it")
const parent = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await realpath(await mkdtemp(path.join(parent, "missions-startup-")))
const nonce = randomUUID()
const fixtureDirectory = path.join(root, "fixture")
const cli = path.join(root, process.platform === "win32" ? "opencode.exe" : "opencode")
const exec = promisify(execFile)
const hash = value => createHash("sha256").update(value).digest("hex")
const evidence = { version: 1, scope: claimWatcher ? "one-artifact-native-standing-execution-hook-only" : claimTimer ? "one-artifact-native-plugin-timer-lifetime-only"
  : claimResume ? "one-artifact-native-claim-entry-only" : "one-artifact-native-startup-only", root, nonce,
  outcome: "running", productionEnabled: false, schedulerQualified: false, managedQualification: "not-tested",
  gates: [], pureLoader: [], managedCases: [],
  bunPreload: { pureLoader: null, managed: null, control: { status: "not-tested" }, result: "not-tested",
    documentation: ["https://bun.com/docs/runtime/environment-variables", "https://bun.com/docs/runtime#dependency--module-resolution"] },
  isolationContract: { roots: "packages/util/src/global-roots.ts:4-16 (XDG_STATE_HOME/opencode)",
    registration: "packages/cli/src/services/service-config.ts:29-31,85-115 (release service.json)",
    persistedEnv: "packages/client/src/service-contender.ts:18-21 (native spawn env merge)",
    configFile: null, namespace: "fixture-only; shared registration is never read" },
  future: { allCodeNomadProcessesClosed: null, authorizedColdRoots: null, singleWriterServiceIdentity: null,
    freshProfileAtDue: null, exactlyOnePassage: null, unknownAcknowledgementParked: null, permissionsAndInboxesPreserved: null } }
let stage = "copy", env, state, registrationFile, port, sentinel, sentinelBefore, provider

function inside(base, candidate) {
  const relative = path.relative(base, candidate)
  return path.isAbsolute(candidate) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function privateEnvironment(home) {
  // Allowlist instead of carrying credentials, Git config, loader options or daemon selectors.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|WINDIR|ComSpec|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)))
  return { ...clean, PATH: process.platform === "win32" ? path.join(process.env.SystemRoot, "System32") : "/usr/bin:/bin",
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData"), LOCALAPPDATA: path.join(home, "LocalAppData"),
    OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: path.join(home, "config"), OPENCODE_DB: path.join(home, "fixture.db"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_DATA_HOME: path.join(home, ".local/share"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_RUNTIME_DIR: path.join(home, "runtime"),
    TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp"), TMPDIR: path.join(home, "tmp"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, ".cache/bun-transpiler"), DO_NOT_TRACK: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", snapshots: false }),
    NATIVE_STARTUP_ROOT: root, NATIVE_STARTUP_NONCE: nonce }
}
async function directories(environment) {
  for (const key of ["APPDATA", "LOCALAPPDATA", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
    "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TEMP"]) await mkdir(environment[key], { recursive: true })
}
async function digest(file) {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest("hex")
}
async function run(args, environment = env, executable = cli, timeout = 25_000) {
  try {
    const value = await exec(executable, args, { cwd: root, env: environment, timeout, windowsHide: true, maxBuffer: 128 * 1024 })
    return { code: 0, stdout: value.stdout.trim(), stderr: value.stderr }
  } catch (error) {
    // Raw command output can contain native credentials. Never persist or print it.
    const text = `${error.stdout || ""}\n${error.stderr || ""}`
    return { code: typeof error.code === "number" ? error.code : null, stdout: "", stderr: "",
      reason: error.killed ? "command-timeout" : /job|breakaway|independent launch/i.test(text) ? "native-job-or-launch-refusal"
        : /unknown.*option|unrecognized.*option|unexpected.*argument/i.test(text) ? "cli-argument-refused"
        : typeof error.code === "string" ? error.code : "native-command-refused" }
  }
}
async function successful(args) {
  const result = await run(args)
  if (result.code !== 0) throw Object.assign(new Error("Private CLI command failed"), { code: result.reason })
  return result.stdout
}
async function marker(file) {
  try {
    assert.ok((await stat(file)).size <= 128 * 1024, "Bounded nonce marker")
    return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => {
      const entry = JSON.parse(line)
      assert.equal(entry.nonce, nonce)
      assert.ok(Number.isInteger(entry.pid) && entry.pid > 0)
      return entry
    })
  } catch (error) { if (error.code === "ENOENT") return []; throw error }
}
async function freePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve) })
  const selected = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return selected
}
async function registration() {
  assert.ok(registrationFile && inside(root, registrationFile))
  try { return JSON.parse(await readFile(registrationFile, "utf8")) }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error }
}
async function connected() {
  const record = await registration()
  assert.ok(record && Number.isInteger(record.pid) && record.pid > 0, "Owned registration exists")
  assert.match(record.id, /^[a-f0-9-]{36}$/, "Native managed incarnation identity exists")
  const url = new URL(record.url)
  assert.equal(url.hostname, "127.0.0.1")
  assert.equal(url.port, String(port))
  const endpoint = await Service.discover({ file: registrationFile }) // explicit file, never default discovery
  assert.equal(endpoint?.url, record.url)
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const info = await client.server.info({ signal: AbortSignal.timeout(5_000) })
  assert.equal(info.pid, record.pid)
  return { client, snapshot: { pid: info.pid, version: info.version, id: record.id ?? null, url: record.url } }
}
async function guard(expected) {
  // These actual read-only CLI paths precede EVERY managed start/restart/config mutation.
  const paths = {}
  for (const key of ["home", "config", "state", "data", "cache", "db"]) {
    paths[key] = await successful(["debug", "paths", key])
    assert.ok(inside(root, paths[key]), `Actual CLI ${key} path must be private`)
  }
  assert.equal(path.resolve(paths.state), path.resolve(state))
  assert.equal(path.resolve(paths.state), path.resolve(env.XDG_STATE_HOME, "opencode"), "Actual state matches source's native registration root")
  assert.equal(path.resolve(paths.config), path.resolve(env.OPENCODE_CONFIG_DIR))
  assert.equal(path.resolve(paths.db), path.resolve(env.OPENCODE_DB))
  const status = await successful(["service", "status"])
  if (expected === "stopped") {
    assert.equal(status, "stopped", "Native status must not identify an external service")
    assert.equal(await registration(), undefined, "No preexisting registration in this new fixture")
  } else {
    assert.equal(status, expected.url)
    const current = await connected()
    assert.deepEqual(current.snapshot, expected, "Exact owned service before restart/cleanup")
  }
  return { paths, status, registrationFile }
}
async function configure(key, value) {
  await guard("stopped")
  await successful(["service", "set", "env", key, "--", value])
  assert.equal(await successful(["service", "get", "env", key]), value, "Native persisted env readback")
}
async function stopOwned() {
  const record = await registration()
  if (record) {
    const current = await connected()
    await guard(current.snapshot)
    await successful(["service", "stop"])
  }
  const after = await guard("stopped")
  evidence.cleanup = { confirmed: true, ...after }
}
async function startSentinel() {
  const home = path.join(root, "sentinel")
  const environment = privateEnvironment(home)
  await directories(environment)
  const password = randomUUID(), sentinelPort = await freePort()
  environment.OPENCODE_SERVER_PASSWORD = password
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(sentinelPort)], {
    cwd: home, env: environment, windowsHide: true, stdio: "ignore" })
  const done = new Promise(resolve => child.once("close", resolve))
  let failure
  child.once("error", error => { failure = error.code })
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${sentinelPort}`,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) break
    try {
      const info = await client.server.info({ signal: AbortSignal.timeout(1_000) })
      assert.equal(info.pid, child.pid)
      return { child, done, client, snapshot: { pid: info.pid, version: info.version } }
    } catch { await delay(100) }
  }
  child.kill()
  await Promise.race([done, delay(5_000)])
  throw Object.assign(new Error("Private sentinel unavailable"), { code: failure || "sentinel-launch-refused" })
}
async function nativeCase(mode, options, optionsEnv = "NODE_OPTIONS") {
  stage = `managed-${mode}`
  const file = path.join(root, "markers", `managed-${mode}.jsonl`)
  const persistedNonce = randomUUID()
  const hashKey = optionsEnv === "BUN_OPTIONS" ? "bunOptionsHash" : "nodeOptionsHash"
  // Keep the two runtime mechanisms separate, including when persisted config survives restart.
  for (const [key, value] of Object.entries({ NODE_OPTIONS: optionsEnv === "NODE_OPTIONS" ? options : "",
    BUN_OPTIONS: optionsEnv === "BUN_OPTIONS" ? options : "", NATIVE_STARTUP_MARKER: file,
    NATIVE_STARTUP_PHASE: mode, NATIVE_STARTUP_PERSISTED_NONCE: persistedNonce })) await configure(key, value)
  const result = { mode, optionsEnv, persistedEnvReadback: true, persistedNonce, [hashKey]: hash(options), starts: [],
    globalPlugin: { observationMs: 2_000, scope: "observed-window-only; not a boot-completion guarantee", coldBoot: [], afterLocation: [] } }
  evidence.managedCases.push(result)
  if (optionsEnv === "BUN_OPTIONS") evidence.bunPreload.managed = result
  for (const operation of ["start", "restart"]) {
    const previous = result.starts.at(-1)?.service
    await guard(operation === "start" ? "stopped" : previous)
    const launch = await run(["service", operation])
    if (launch.code !== 0) { result.status = "managed-launch-unqualified"; result.launchReason = launch.reason; return }
    const running = await connected()
    if (previous) {
      assert.notEqual(running.snapshot.pid, previous.pid, "Actual managed restart changes PID")
      assert.notEqual(running.snapshot.id, previous.id, "Actual managed restart changes native incarnation")
    }
    // Global status/info reads only; do NOT request a Location during this window.
    await delay(2_000)
    const cold = (await marker(file)).filter(entry => entry.pid === running.snapshot.pid)
    const hits = cold.filter(entry => entry.kind === mode)
    const start = { operation, service: running.snapshot, loaderHits: hits.length,
      oncePerIncarnation: hits.length === 1,
      loaderAligned: hits.length === 1 && hits.every(entry => path.resolve(entry.execPath) === path.resolve(cli)
        && entry.persistedNonce === persistedNonce && entry[hashKey] === hash(options)
        && entry.fixtureRoot === root && entry.stateRoot === env.XDG_STATE_HOME
        && entry.configRoot === env.OPENCODE_CONFIG_DIR && entry.database === env.OPENCODE_DB),
      loaderRuntime: hits.length ? { node: hits[0].nodeVersion, bun: hits[0].bunVersion } : null,
      ...(optionsEnv === "BUN_OPTIONS" ? { bunPreloadHit: hits.length > 0, bunPreloadMiss: hits.length === 0 } : {}) }
    result.starts.push(start)
    result.globalPlugin.coldBoot.push({ operation, servicePID: running.snapshot.pid,
      moduleHits: cold.filter(entry => entry.kind === "global-plugin-module").length,
      setupHits: cold.filter(entry => entry.kind === "global-plugin-setup").length })
    const location = { directory: path.join(root, "project") }
    const deadline = Date.now() + 15_000
    let active = false
    while (Date.now() < deadline && !active) {
      const plugins = await running.client.plugin.list({ location }, { signal: AbortSignal.timeout(5_000) })
      active = plugins.data.some(plugin => plugin.id === "missions.native-startup-fixture" && plugin.state.status === "active")
      if (!active) await delay(100)
    }
    assert.equal(active, true, "Real global plugin loads on explicit owned Location demand")
    const setups = (await marker(file)).filter(entry => entry.pid === running.snapshot.pid && entry.kind === "global-plugin-setup")
    assert.ok(setups.length > 0 && setups.every(entry => entry.persistedNonce === persistedNonce
      && entry[hashKey] === hash(options) && path.resolve(entry.execPath) === path.resolve(cli)),
    "Persisted native service env reaches the read-copied artifact's actual plugin process")
    result.globalPlugin.afterLocation.push({ operation, setupHits: setups.length, pid: running.snapshot.pid,
      persistedEnvHonored: true, runtime: { node: setups[0].nodeVersion, bun: setups[0].bunVersion },
      directories: setups.map(entry => entry.directory) })
  }
  result.status = result.starts.every(start => start.loaderAligned) ? "preload-qualified-for-start-and-restart"
    : result.starts.every(start => start.loaderHits === 0) ? "artifact-preload-unsupported" : "loader-identity-unqualified"
  if (optionsEnv === "BUN_OPTIONS") evidence.bunPreload.result = result.status === "artifact-preload-unsupported"
    ? "compiled-artifact-bun-preload-miss" : result.status
}

async function bunControl(options) {
  stage = "bun-control"
  const control = evidence.bunPreload.control
  if (!bun) { control.status = "no-explicit-installed-bun"; return }
  control.source = await realpath(bun)
  control.sha256 = await digest(bun)
  const version = await run(["--version"], env, bun)
  control.version = /^\d+\.\d+\.\d+$/.test(version.stdout) ? version.stdout : null
  const actual = evidence.bunPreload.managed?.globalPlugin.afterLocation[0]?.runtime.bun
  control.artifactRuntime = actual ?? null
  if (!actual || actual !== control.version) {
    control.status = actual ? "installed-bun-version-mismatch-control-skipped" : "artifact-runtime-unobserved-control-skipped"
    control.sourceUnchanged = await digest(bun) === control.sha256
    return
  }
  const file = path.join(root, "markers", "control-bun-preload.jsonl")
  const result = await run(["--no-install", "--no-env-file", "-e", ""], { ...env, BUN_OPTIONS: options,
    NATIVE_STARTUP_MARKER: file, NATIVE_STARTUP_PHASE: "control-bun-preload" }, bun)
  const hits = (await marker(file)).filter(entry => entry.kind === "bun-preload")
  control.exitCode = result.code
  control.loaderHits = hits.length
  control.aligned = hits.length === 1 && hits[0].bunVersion === actual
    && path.resolve(hits[0].execPath) === path.resolve(control.source) && hits[0].bunOptionsHash === hash(options)
  control.status = result.code === 0 && control.aligned ? "same-version-bun-positive-control-hit" : "same-version-bun-control-unqualified"
  control.sourceUnchanged = await digest(bun) === control.sha256
  assert.equal(control.sourceUnchanged, true)
  assert.equal(control.status, "same-version-bun-positive-control-hit", "Existing same-version Bun must execute the positive control")
}

try {
  assert.ok(inside(await realpath(parent), root))
  evidence.artifact = { source: await realpath(source), sha256: await digest(source), privateCopy: cli }
  await copyFile(source, cli)
  assert.equal(await digest(cli), evidence.artifact.sha256)
  env = privateEnvironment(root)
  await directories(env)
  await mkdir(fixtureDirectory)
  await mkdir(path.join(root, "markers"))
  await mkdir(path.join(root, "project"))
  if (claimResume) {
    await mkdir(path.join(root, "idle-project"))
    provider = await startClaimProvider(nonce)
  }
  for (const name of ["emit.cjs", "preload.cjs", "preload.mjs", "bun-preload.mjs", "global-plugin.mjs", "claim-plugin.mjs"])
    await copyFile(fileURLToPath(new URL(`./missions-native-startup/${name}`, import.meta.url)), path.join(fixtureDirectory, name))
  await writeFile(path.join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify({ update: "disable", snapshots: false,
    ...(provider?.config ?? {}),
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      ...(claimResume ? [{ action: "fixture_hold", resource: nonce, effect: "allow" }] : [])], plugins: [fixtureDirectory] }))
  // Standard supported directory plugin entry; no package installation/imports.
  if (claimTimer || claimWatcher) {
    const { build } = await import("esbuild")
    const effectPackage = JSON.parse(await readFile(fileURLToPath(import.meta.resolve("effect/package.json")), "utf8"))
    evidence.timerFixtureBuild = { effectVersion: effectPackage.version, sourceTagEffectVersion: "4.0.0-rc.112",
      dependencies: "existing-checkout-read-only; no-install", privateOutput: path.join(fixtureDirectory, "index.mjs") }
    assert.equal(effectPackage.version, "4.0.0-rc.112", "Fixture matches the exact source tag's Effect catalog")
    await build({ entryPoints: [fileURLToPath(new URL(`./missions-native-startup/${claimWatcher ? "watcher" : "timer"}-plugin.mjs`, import.meta.url))],
      outfile: path.join(fixtureDirectory, "index.mjs"), bundle: true, platform: "node", format: "esm", target: "es2022" })
  } else await writeFile(path.join(fixtureDirectory, "index.mjs"), `export { default } from "./${claimResume ? "claim-plugin" : "global-plugin"}.mjs"\n`)
  const authoredSources = claimWatcher ? ["watcher-plugin.mjs", "watcher-scope.mjs", "claim-plugin.mjs", "emit.cjs"]
    : claimTimer ? ["timer-plugin.mjs", "timer-scope.mjs", "claim-plugin.mjs", "emit.cjs"]
    : [claimResume ? "claim-plugin.mjs" : "global-plugin.mjs", "emit.cjs"]
  const sourceFingerprints = await Promise.all(authoredSources.map(async name => ({ name,
    sha256: await digest(fileURLToPath(new URL(`./missions-native-startup/${name}`, import.meta.url))) })))
  const entrypoint = path.join(fixtureDirectory, "index.mjs")
  const fingerprints = JSON.stringify({ purpose: "fixture-module-identity-only-not-authority", sources: sourceFingerprints })
  await writeFile(path.join(fixtureDirectory, "module-fingerprints.json"), fingerprints)
  evidence.fixtureModules = { entrypoint, entrypointURL: pathToFileURL(entrypoint).href, entrypointSHA256: await digest(entrypoint),
    sourceFingerprintSHA256: hash(fingerprints), authoredSources: sourceFingerprints,
    nativeCacheRevision: "not-exposed; fixture-hashes-not-native-cache-version" }
  stage = "artifact-version"
  const version = (await successful(["--version"])).match(/^(?:opencode v)?(\d+\.\d+\.\d+)$/)
  assert.ok(version, "This fixture uses the existing release-channel service.json contract")
  evidence.artifact.version = version[1]
  const options = { import: `--import=${pathToFileURL(path.join(fixtureDirectory, "preload.mjs")).href}`,
    require: `--require=${JSON.stringify(path.join(fixtureDirectory, "preload.cjs").replaceAll("\\", "/"))}` }
  for (const [mode, nodeOptions] of claimResume ? [] : Object.entries(options)) {
    stage = `pure-${mode}`
    const file = path.join(root, "markers", `pure-${mode}.jsonl`)
    const isolated = { ...env, NODE_OPTIONS: nodeOptions, NATIVE_STARTUP_MARKER: file, NATIVE_STARTUP_PHASE: `pure-${mode}` }
    const result = await run(["--version"], isolated)
    const entries = await marker(file)
    const controlFile = path.join(root, "markers", `control-${mode}.jsonl`)
    // Node handles --version before preloads; execute an empty main for the control.
    const control = await run(["-e", ""], { ...isolated, NATIVE_STARTUP_MARKER: controlFile }, process.execPath)
    assert.equal(control.code, 0)
    assert.equal((await marker(controlFile)).filter(entry => entry.kind === mode).length, 1, "Loader control really executes")
    evidence.pureLoader.push({ mode, exitCode: result.code, reason: result.reason ?? null, loaderHits: entries.length,
      aligned: entries.length > 0 && entries.every(entry => path.resolve(entry.execPath) === path.resolve(cli)),
      controlHit: true, outcome: entries.length ? "loader-hit" : result.code === 0 ? "artifact-ignored-preload" : "artifact-rejected-preload" })
  }
  const bunOptions = `--preload ${JSON.stringify(path.join(fixtureDirectory, "bun-preload.mjs").replaceAll("\\", "/"))}`
  if (!claimResume) {
    stage = "pure-bun-preload"
    const bunFile = path.join(root, "markers", "pure-bun-preload.jsonl")
    const directBun = await run(["--version"], { ...env, BUN_OPTIONS: bunOptions,
      NATIVE_STARTUP_MARKER: bunFile, NATIVE_STARTUP_PHASE: "pure-bun-preload" })
    const bunEntries = await marker(bunFile)
    evidence.bunPreload.pureLoader = { exitCode: directBun.code, reason: directBun.reason ?? null,
      bunOptionsHash: hash(bunOptions), loaderHits: bunEntries.length,
      bunPreloadHit: bunEntries.length > 0, bunPreloadMiss: bunEntries.length === 0,
      aligned: bunEntries.length === 1 && bunEntries[0].kind === "bun-preload"
        && path.resolve(bunEntries[0].execPath) === path.resolve(cli) && bunEntries[0].bunOptionsHash === hash(bunOptions),
      runtime: bunEntries.length ? { node: bunEntries[0].nodeVersion, bun: bunEntries[0].bunVersion } : null }
  }
  if (loaderOnly) { evidence.outcome = "loader-only-managed-not-tested"; evidence.managedQualification = "not-tested" }
  else {
    stage = "readonly-native-registration-isolation"
    // Derive service storage from the actual CLI, then verify all paths and stopped status before mutation.
    state = await successful(["debug", "paths", "state"])
    assert.ok(inside(root, state))
    assert.equal(path.resolve(state), path.resolve(env.XDG_STATE_HOME, "opencode"))
    registrationFile = path.join(state, "service.json")
    evidence.isolationContract.configFile = path.join(env.OPENCODE_CONFIG_DIR, "service.json")
    evidence.isolation = await guard("stopped")
    evidence.gates.push("actual-cli-private-home-config-state-data-cache-db-and-stopped-registration")
    port = await freePort()
    await guard("stopped")
    await successful(["service", "set", "port", String(port)])
    assert.equal(await successful(["service", "get", "port"]), String(port))
    await guard("stopped")
    await successful(["service", "set", "hostname", "127.0.0.1"])
    assert.equal(await successful(["service", "get", "hostname"]), "127.0.0.1")
    stage = "separate-owned-sentinel"
    sentinel = await startSentinel()
    sentinelBefore = sentinel.snapshot
    evidence.externalService = { scope: "separate-fixture-owned-sentinel-not-user-daemon", before: sentinelBefore }
    if (claimResume) {
      stage = "native-claim-resume"
      const claim = await runClaimResume({ root, nonce, env, provider, evidence, guard, successful, connected, configure, marker,
        beforeResumeSettlement: claimTimer ? captureTimerGraph : undefined,
        observeBeforeResumeModel: claimWatcher ? runWatcherScope : undefined })
      if (claimTimer) {
        stage = "native-plugin-timer-scope"
        await runTimerScope({ ...claim, marker, guard, successful, connected, provider, evidence })
      }
    } else {
      for (const [mode, nodeOptions] of Object.entries(options)) {
        await nativeCase(mode, nodeOptions)
        await stopOwned()
        if (evidence.managedCases.at(-1).status === "managed-launch-unqualified") break
      }
      if (!evidence.managedCases.some(item => item.status === "managed-launch-unqualified")) {
        await nativeCase("bun-preload", bunOptions, "BUN_OPTIONS")
        await stopOwned()
        await bunControl(bunOptions)
      }
      // Node misses are retained as distinct results, never used to veto or infer Bun support.
      evidence.outcome = evidence.managedCases.some(item => item.status === "managed-launch-unqualified")
        ? "managed-launch-unqualified" : evidence.bunPreload.result
      evidence.managedQualification = evidence.outcome
    }
  }
} catch (error) {
  evidence.outcome = "probe-unqualified"
  evidence.managedQualification = "unqualified"
  evidence.failedStage = stage
  evidence.reason = typeof error.code === "string" ? error.code : "fixture-contract-or-isolation-refused"
  process.exitCode = 1
} finally {
  // Release only the bounded fake-model response before native cleanup, never another prompt.
  provider?.release()
  if (registrationFile && port) {
    try { await stopOwned() }
    catch { evidence.cleanup = { confirmed: false, reason: "owned-cleanup-unconfirmed" }; process.exitCode = 1 }
  }
  if (sentinel) {
    try {
      const after = await sentinel.client.server.info({ signal: AbortSignal.timeout(5_000) })
      assert.deepEqual({ pid: after.pid, version: after.version }, sentinelBefore)
      evidence.externalService.after = { pid: after.pid, version: after.version }
      evidence.externalService.preserved = true
    } catch { evidence.externalService.preserved = false; process.exitCode = 1 }
    sentinel.child.kill()
    const closed = await Promise.race([sentinel.done.then(() => true), delay(5_000).then(() => false)])
    evidence.externalService.ownedSentinelClosed = closed
    if (!closed) process.exitCode = 1
  }
  if (provider) {
    await provider.stop()
    evidence.claimProviderClosed = true
  }
  if (evidence.artifact) {
    evidence.artifact.sourceUnchanged = await digest(source) === evidence.artifact.sha256
    evidence.artifact.copyUnchanged = await digest(cli) === evidence.artifact.sha256
    if (!evidence.artifact.sourceUnchanged || !evidence.artifact.copyUnchanged) process.exitCode = 1
  }
  if (evidence.fixtureModules) {
    evidence.fixtureModules.entrypointUnchanged = await digest(evidence.fixtureModules.entrypoint) === evidence.fixtureModules.entrypointSHA256
    if (!evidence.fixtureModules.entrypointUnchanged) process.exitCode = 1
  }
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
}
