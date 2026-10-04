// PRIVATE Windows evidence runner. Narrow runtime-Job/real IPC proof, NOT product enablement.
// No product host/daemon, installation, policy changes or production source edits.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readdir, readFile, rmdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const helpers = new URL("./host-lifetime-node-ipc/", import.meta.url)
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const evidence = { outcome: "FAILED", node: process.version, uv: process.versions.uv,
  combinedRuntimeNodeIpc: "not-qualified", independentLaunch: "not-qualified",
  desktopParity: "not-qualified" }
// Include untracked native sources as well. Generated build output isn't source.
const protectedRoots = ["packages/server/src", "packages/native-host-lifetime/src",
  "packages/native-host-lifetime/tests", "packages/native-host-lifetime/node", "scripts/host-lifetime-node-ipc", "packages/electron-app/electron",
  "packages/tauri-app/src-tauri/src"]
const protectedFiles = ["packages/native-host-lifetime/Cargo.toml", "packages/native-host-lifetime/Cargo.lock",
  "scripts/test-host-lifetime-node-ipc.mjs",
  "packages/server/package.json", "packages/electron-app/package.json",
  "packages/tauri-app/package.json", "packages/tauri-app/src-tauri/Cargo.toml", "package.json"]
async function snapshot() {
  const files = [...protectedFiles]
  async function walk(relative) {
    for (const entry of await readdir(path.join(repo, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error("source-link")
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) files.push(name)
    }
  }
  for (const root of protectedRoots) await walk(root)
  files.sort()
  const digest = createHash("sha256")
  for (const file of files) digest.update(`${file}\0${hash(await readFile(path.join(repo, file)))}\n`)
  return { files: files.length, sha256: digest.digest("hex") }
}
function run(file, args, cwd, env) {
  const result = spawnSync(file, args, { cwd, env, shell: false, windowsHide: true,
    timeout: 60_000, maxBuffer: 128 * 1024, encoding: "utf8" })
  if (result.error || result.status !== 0) throw new Error("private-command-failed")
  return result.stdout
}
function installedContract() {
  // Read installed executable's embedded JS. Do not call private IPC APIs or patch them.
  const natives = process.binding("natives")
  const probes = [
    ["child_process", ["function _forkChild(fd, serializationMode)", "new Pipe(PipeConstants.IPC)", "p.open(fd)"]],
    ["internal/child_process", ["NODE_CHANNEL_FD=${ipcFd}", "NODE_CHANNEL_SERIALIZATION_MODE=${serialization}",
      "new Pipe(PipeConstants.IPC)", "this._handle.spawn(options)", "setupChannel(this, ipc, serialization)"]],
    ["internal/process/pre_execution", ["delete process.env.NODE_CHANNEL_FD", "delete process.env.NODE_CHANNEL_SERIALIZATION_MODE",
      "require('child_process')._forkChild(fd, serializationMode)"]],
  ]
  return probes.map(([id, terms]) => {
    const source = natives[id]
    assert.equal(typeof source, "string")
    const lines = source.split("\n")
    return { module: id, sha256: hash(source), anchors: terms.map(term => {
      const line = lines.findIndex(value => value.includes(term)) + 1
      assert.ok(line > 0)
      return { term, line }
    }) }
  })
}
let root, before
let stage = "source-snapshot"
try {
  before = await snapshot()
  evidence.sourceBefore = before
  assert.equal(process.platform, "win32")
  assert.ok(path.isAbsolute(process.execPath))
  evidence.installedNodeContract = installedContract()
  root = await mkdtemp(path.join(process.env.LOCALAPPDATA, "Temp", "opencode", "host-node-ipc-"))
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  const loader = new URL("loader.mjs", helpers).href // Existing local TS compiler, no subprocess.
  stage = "direct-spawn-protocol-control"
  evidence.directSpawnProtocolControl = JSON.parse(run(process.execPath,
    ["--import", loader, fileURLToPath(new URL("protocol-control.ts", helpers)), root], repo, env))
  assert.equal(evidence.directSpawnProtocolControl.nativeContainment, false)
  stage = "flags-without-ipc-control"
  evidence.noIpcFlagsControl = JSON.parse(run(process.execPath,
    ["--import", loader, fileURLToPath(new URL("env-control.ts", helpers))], repo,
    { ...env, CODENOMAD_HOST_CHILD: "1", CODENOMAD_NATIVE_PARENT: "1" }))
  // Separate preexisting native tests use real production primitives/private Jobs.
  // They are NOT evidence that the Node IPC control was assigned before resume.
  stage = "separate-native-containment-tests"
  const native = run("cargo", ["test", "--locked", "--offline", "--features", "fixtures",
    "--", "--test-threads=1"], path.join(repo, "packages/native-host-lifetime"), process.env)
  const results = [...native.matchAll(/test result: ok\. (\d+) passed; 0 failed; (\d+) ignored/g)]
  assert.ok(results.length > 0)
  const passed = results.reduce((sum, match) => sum + Number(match[1]), 0)
  const ignored = results.reduce((sum, match) => sum + Number(match[2]), 0)
  assert.equal(ignored, 3) // No changing ignored positive gates into waivers.
  assert.ok(native.includes("manager_death_closes_running_job_during_slow_preparation_and_rejects_late_child ... ok"))
  assert.ok(native.includes("real_node_manager_crash_closes_backend_job_through_retained_native_handle_watch ... ok"))
  evidence.separateNativeContainmentControl = { passed, ignoredQualifications: ignored,
    productionPrimitives: true, combinedWithNodeIpc: false }
  stage = "combined-runtime-node-ipc"
  run("cargo", ["build", "--locked", "--offline", "--features", "fixtures", "--bin", "host-lifetime-fixture"],
    path.join(repo, "packages/native-host-lifetime"), process.env)
  evidence.combinedRuntimeProof = JSON.parse(run(process.execPath,
    [fileURLToPath(new URL("runtime-control.mjs", helpers)), root], repo, env))
  evidence.combinedRuntimeNodeIpc = "qualified-owned-nested-job-only"
  stage = "compiled-addon-sustained-wire"
  run("cargo", ["build", "--locked", "--offline", "--features", "fixtures", "--lib", "--bin", "host-lifetime-fixture"],
    path.join(repo, "packages/native-host-lifetime"), process.env)
  const nativeOutput = path.join(repo, "packages/native-host-lifetime/target/debug")
  await copyFile(path.join(nativeOutput, "codenomad_native_host_lifetime.dll"), path.join(nativeOutput, "codenomad_native_host_lifetime.node"))
  evidence.compiledAddonProof = JSON.parse(run(process.execPath,
    [fileURLToPath(new URL("addon-control.mjs", helpers)), root], repo, env))
  assert.equal(evidence.compiledAddonProof.abi, "codenomad.runtime.v1")
  assert.equal(evidence.compiledAddonProof.outsideBrokerSharedLauncherMock, true)
  assert.equal(evidence.compiledAddonProof.productManagerQualified, false)
  for (const key of ["nativeSuspendedStarterCounterproof", "singleUsePermitReplayRejected", "nativeOwnedStarterCancellation",
    "exactRequestDigestRejected", "expiredPermitRejected", "nativePermitScopeGenerationAndWireKeyRejected", "managerDeathKillsOnlyOwnedStarter", "nativeDeadlineKillsOwnedStarter", "nativePermitBackpressure"])
    assert.equal(evidence.compiledAddonProof[key], true)
  evidence.serviceImplementation = "compiled-native-permits-suspended-starter-and-owned-cancellation"
  evidence.serviceQualification = "outside-runtime-job-counterproof-only"
  stage = "compiled-service-request-failure-response"
  evidence.serviceResponseProof = JSON.parse(run(process.execPath,
    [fileURLToPath(new URL("service-response-control.mjs", helpers)), root], repo, env))
  assert.equal(evidence.serviceResponseProof.outcome, "PASSED_NARROW_SERVICE_RESPONSE_PROOF")
  assert.equal(evidence.serviceResponseProof.productQualified, false)
  assert.equal(evidence.serviceResponseProof.cases.length, 9)
  stage = "compiled-addon-stop-drain"
  evidence.compiledStopDrainProof = JSON.parse(run(process.execPath,
    [fileURLToPath(new URL("addon-control.mjs", helpers)), root, "drain"], repo, env))
  assert.equal(evidence.compiledStopDrainProof.stopAcknowledgementConsumed, true)
  stage = "compiled-addon-product-gate"
  evidence.compiledProductGateProof = JSON.parse(run(process.execPath,
    [fileURLToPath(new URL("addon-control.mjs", helpers)), root, "product-closed"], repo, env))
  assert.equal(evidence.compiledProductGateProof.productFactoryRefused, true)
  evidence.outcome = "PASSED_NARROW_RUNTIME_PROOF"
  evidence.remainingProductGates = ["independent-supervisor-launch", "private-storage-chain",
    "native-node-ipc-privacy-audit", "independent-service-peer-and-starter-all-jobs-qualification",
    "packaged-manager-and-desktop-integration", "packaged-electron-tauri-parity"]
  process.exitCode = 0
} catch {
  evidence.outcome = "FAILED"
  evidence.error = "private-proof-command-or-contract-failed"
  evidence.failedStage = stage
  process.exitCode = 1 // Never emit command output, assertion values, secrets or stacks.
} finally {
  try {
    const after = await snapshot()
    evidence.sourceAfter = after
    evidence.sourceUnchanged = before?.sha256 === after.sha256
    if (!evidence.sourceUnchanged) { evidence.outcome = "FAILED"; process.exitCode = 1 }
    // Auth fixture is bootstrap-only and must not persist even its private tokens.
    if (root) { assert.deepEqual(await readdir(root), []); await rmdir(root) }
  } catch { evidence.outcome = "FAILED"; evidence.error = "source-or-owned-fixture-cleanup-failed"; process.exitCode = 1 }
  console.log(JSON.stringify(evidence, null, 2))
}
