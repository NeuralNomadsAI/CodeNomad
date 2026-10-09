// Bounded, isolated production first-channel qualification. Never enables desktop.
// Host-lifetime evidence only; superseded as recurring-Missions acceptance by the simple
// native contract (dev-docs/MISSIONS_RECURRING_SIMPLE.md, scripts/test-recurring-simple-native.mjs).
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const nativeRoot = path.join(repo, "packages/native-host-lifetime")
const nodeCandidate = process.argv[2]
assert.equal(process.platform, "win32")
assert.ok(nodeCandidate && path.isAbsolute(nodeCandidate), "Pass an absolute pinned Node candidate path")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const parent = path.join(process.env.LOCALAPPDATA, "Temp/opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "recurring-continuity-native-"))
const evidence = { outcome: "FAILED", root, continuityQualified: false, desktopEnabled: false,
  signedMissionChildAuthorityQualified: false }
let stage = "pinned-node-candidate"
async function sourceSnapshot() {
  const files = ["Cargo.toml", "Cargo.lock", "tests/recurring_continuity.rs"]
  async function walk(relative) {
    for (const entry of await readdir(path.join(nativeRoot, relative), { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false)
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(name)
      else files.push(name)
    }
  }
  await walk("src")
  const records = []
  for (const file of files.sort()) records.push({ file: `packages/native-host-lifetime/${file}`,
    sha256: hash(await readFile(path.join(nativeRoot, file))) })
  for (const file of ["scripts/test-recurring-continuity-native.mjs", "scripts/host-lifetime-node-ipc/loader.mjs",
    "packages/server/src/host-lifetime/native-runtime-binding.ts"]) records.push({ file, sha256: hash(await readFile(path.join(repo, file))) })
  return { sha256: hash(JSON.stringify(records)), files: records }
}
function command(file, args, env, timeout = 120_000) {
  const result = spawnSync(file, args, { cwd: repo, env, timeout, windowsHide: true,
    shell: false, maxBuffer: 512 * 1024, encoding: "utf8" })
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "",
    error: result.error?.code }
}
try {
  evidence.sourceBefore = await sourceSnapshot()
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, "resources/win32-x64/manifest.json"), "utf8"))
  const pinned = `v${(await readFile(path.join(repo, ".node-version"), "utf8")).trim()}`
  const nodeBytes = await readFile(nodeCandidate)
  assert.equal(hash(nodeBytes), manifest.node.sha256)
  const probe = command(nodeCandidate, ["-p", "JSON.stringify({version:process.version,modules:process.versions.modules,napi:process.versions.napi})"], {}, 10_000)
  assert.equal(probe.status, 0)
  const contract = JSON.parse(probe.stdout)
  assert.deepEqual(contract, { version: pinned, modules: manifest.node.modules, napi: manifest.node.napi })
  const node = path.join(root, "node.exe")
  await copyFile(nodeCandidate, node)
  evidence.nodeCandidate = { file: nodeCandidate, ...contract, sha256: hash(nodeBytes), privateCopy: node }
  const target = path.join(root, "cargo-target")
  const env = { ...process.env, CARGO_TARGET_DIR: target }
  const cargo = ["--manifest-path", path.join(nativeRoot, "Cargo.toml"), "--locked", "--offline", "--release"]
  stage = "production-native-build"
  const build = command("cargo", ["build", ...cargo, "--lib", "--bin", "codenomad-host-supervisor"], env)
  await writeFile(path.join(root, "production-build.log"), `${build.stdout}\n${build.stderr}`)
  assert.equal(build.status, 0, "Private production build failed; see owned build receipt")
  const output = path.join(target, "release")
  const binding = path.join(root, "runtime.node")
  await copyFile(path.join(output, "codenomad_native_host_lifetime.dll"), binding)
  const fingerprints = await readdir(path.join(output, ".fingerprint"))
  const candidates = []
  for (const name of fingerprints.filter(name => name.startsWith("codenomad-native-host-lifetime-"))) {
    try {
      const file = path.join(output, ".fingerprint", name, "lib-codenomad_native_host_lifetime.json")
      const bytes = await readFile(file), record = JSON.parse(bytes)
      assert.equal(record.features, "[]")
      candidates.push({ file, sha256: hash(bytes), features: record.features })
    } catch (error) { if (error.code !== "ENOENT") throw error }
  }
  assert.equal(candidates.length, 1)
  evidence.nativeBuild = { profile: "release", features: [], target, fingerprint: candidates[0],
    cargoLockSha256: hash(await readFile(path.join(nativeRoot, "Cargo.lock"))),
    binding: { file: binding, sha256: hash(await readFile(binding)) },
    supervisor: { file: path.join(output, "codenomad-host-supervisor.exe"),
      sha256: hash(await readFile(path.join(output, "codenomad-host-supervisor.exe"))) } }
  stage = "production-addon-loader"
  const script = path.join(root, "loader-probe.mjs")
  await writeFile(script, `import assert from 'node:assert/strict';
import { NativeRuntimeBinding } from ${JSON.stringify(new URL("../packages/server/src/host-lifetime/native-runtime-binding.ts", import.meta.url).href)};
const binding = await NativeRuntimeBinding.load(${JSON.stringify(binding)}, ${JSON.stringify(evidence.nativeBuild.binding.sha256)});
NativeRuntimeBinding.assert(binding);
assert.equal(binding.production,true);
assert.equal(Object.hasOwn(binding.sdk,'fixtureAuthorizeNestedResponse'),false);
for(const name of ['openServicePeer','prepareServiceStarter','readServiceStarter','waitServiceStarter','killServiceStarter','finishServiceStarter','closeServiceStarter']) assert.equal(typeof binding.sdk[name],'function');
assert.throws(()=>binding.sdk.verifyMember({},process.pid,Buffer.alloc(32),Buffer.alloc(0)),/native-runtime-request-refused/);
console.log(JSON.stringify({productionBindingLoaded:true,fixtureExportsAbsent:true,serviceStarterExportsPresent:true,fabricatedSessionRejected:true,runtimeCapabilityOpened:false}));
`)
  const loader = command(node, ["--import", new URL("./host-lifetime-node-ipc/loader.mjs", import.meta.url).href, script], {}, 15_000)
  await writeFile(path.join(root, "loader-probe.log"), `${loader.stdout}\n${loader.stderr}`)
  assert.equal(loader.status, 0)
  evidence.loader = JSON.parse(loader.stdout)
  stage = "native-first-spawn-channel"
  const test = command("cargo", ["test", ...cargo, "--test", "recurring_continuity", "--", "--ignored", "--test-threads=1"],
    { ...env, RECURRING_CONTINUITY_ROOT: root, RECURRING_CONTINUITY_NODE: node })
  await writeFile(path.join(root, "native-first-channel.log"), `${test.stdout}\n${test.stderr}`)
  assert.equal(test.status, 0)
  evidence.firstChannel = JSON.parse(await readFile(path.join(root, "native-first-channel.json"), "utf8"))
  evidence.outcome = evidence.firstChannel.outcome
  evidence.notExecuted = ["supervisor-application-config", "production-NativeRuntimeCapability.open", "private-HostStorage-election",
    "full-index-backend-auth-bootstrap", "native-private-OpenCode-service-starter", "detach-reattach-no-UI",
    "authorized-workspace-environment-prompt", "actual-last-graphical-window-close", "packaged-Electron-Tauri-parity"]
  // Successful first channel is still NOT successful recurring-runtime proof.
  process.exitCode = 2
} catch (error) {
  evidence.failedStage = stage
  evidence.error = error.code || "qualification-command-or-contract-failed"
  process.exitCode = 1
} finally {
  // Preserve non-secret logs/artifacts. No shared service/state/credential access,
  // Task Scheduler, policy changes, pattern kills or installed desktop activation.
  evidence.sourceAfter = await sourceSnapshot()
  evidence.sourceUnchanged = evidence.sourceBefore?.sha256 === evidence.sourceAfter.sha256
  if (!evidence.sourceUnchanged) { evidence.outcome = "FAILED"; process.exitCode = 1 }
  await writeFile(path.join(root, "qualification.json"), JSON.stringify(evidence, null, 2))
  const { sourceBefore, sourceAfter, ...summary } = evidence
  console.log(JSON.stringify({ ...summary, sourceSha256: sourceAfter.sha256 }, null, 2))
}
