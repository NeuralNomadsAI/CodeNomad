const fs = require("node:fs")
const path = require("node:path")
const { fileURLToPath } = require("node:url")
const { exactPath, readArtifact, refuse, sha256, verifyPe } = require("./native-host-artifacts.cjs")

const ABI = "codenomad.runtime.v1"
const WIRE = "CNHRv001"
const WINDOWS = { "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" }
const OTHER = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"])
const NATIVE_FILES = { supervisor: "supervisor.exe", binding: "runtime.node", fingerprint: "cargo-fingerprint.json" }
const NODE_FILES = ["service-broker.mjs", "owned-starter.mjs", "channel-codec.mjs"]
const MODULES = ["host-lifetime/native-manager-entry.js", "host-lifetime/backend-entry.js", "index.js", "workspaces/native-service-launcher.js"]
const plans = new WeakMap()
const MAX_NODE = 128 * 1024 * 1024
function keys(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length
    || names.some(name => !Object.hasOwn(value, name))) refuse("manifest-shape")
}
function digest(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse("manifest-digest"); return value }
function parseJson(bytes) { try { return JSON.parse(bytes.toString("utf8")) } catch { refuse("manifest-json") } }
function validateManifest(manifest, target) {
  keys(manifest, ["version", "target", "abi", "wire", "build", "node", "artifacts"])
  if (!WINDOWS[target] || manifest.version !== 1 || manifest.target !== target || manifest.abi !== ABI || manifest.wire !== WIRE) refuse("manifest-target-or-abi")
  keys(manifest.build, ["profile", "targetTriple", "features", "cargoLockSha256"])
  if (manifest.build.profile !== "release" || manifest.build.targetTriple !== WINDOWS[target]
    || !Array.isArray(manifest.build.features) || manifest.build.features.length) refuse("production-build-required")
  digest(manifest.build.cargoLockSha256)
  keys(manifest.node, ["version", "modules", "napi", "sha256"])
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.node.version) || !/^\d{1,4}$/.test(manifest.node.modules)
    || !/^\d{1,3}$/.test(manifest.node.napi) || Number(manifest.node.napi) < 8) refuse("node-runtime-contract")
  digest(manifest.node.sha256)
  keys(manifest.artifacts, Object.keys(NATIVE_FILES))
  for (const [name, file] of Object.entries(NATIVE_FILES)) {
    keys(manifest.artifacts[name], ["file", "sha256"])
    if (manifest.artifacts[name].file !== file) refuse("artifact-path-forbidden")
    digest(manifest.artifacts[name].sha256)
  }
  return manifest
}
function verifyNativeFiles(root, manifest) {
  const read = name => readArtifact(path.join(root, NATIVE_FILES[name]), manifest.artifacts[name].sha256)
  verifyPe(read("supervisor"), manifest.target)
  verifyPe(read("binding"), manifest.target, true)
  const fingerprint = parseJson(read("fingerprint"))
  // Consume the real Cargo fingerprint's selected features, not a permissive
  // product flag. This is trusted build metadata, never native execution proof.
  if (fingerprint.features !== "[]") refuse("fixture-build-fingerprint-forbidden")
}
/** Consume trusted release build outputs and a bundled-Node probe record. No
 * compilation, downloads, artifact renaming or native execution occurs here.
 * The returned manifest is packaging metadata, never native authority. */
function createNativeHostManifest({ artifactRoot, target, cargoLockFile, nodeFile, nodeEvidence }) {
  if (!WINDOWS[target]) refuse("unsupported-target")
  keys(nodeEvidence, ["target", "version", "modules", "napi", "sha256"])
  if (nodeEvidence.target !== target) refuse("node-evidence-target")
  const node = readArtifact(nodeFile, digest(nodeEvidence.sha256), MAX_NODE)
  verifyPe(node, target)
  const artifacts = Object.fromEntries(Object.entries(NATIVE_FILES).map(([name, file]) => [name,
    { file, sha256: sha256(readArtifact(path.join(artifactRoot, file))) }]))
  const manifest = validateManifest({ version: 1, target, abi: ABI, wire: WIRE,
    build: { profile: "release", targetTriple: WINDOWS[target], features: [], cargoLockSha256: sha256(readArtifact(cargoLockFile)) },
    node: { version: nodeEvidence.version, modules: nodeEvidence.modules, napi: nodeEvidence.napi, sha256: nodeEvidence.sha256 }, artifacts }, target)
  verifyNativeFiles(artifactRoot, manifest)
  return manifest
}
function distDigest(root) {
  exactPath(root, true)
  const records = []
  let visited = 0
  const excluded = new Set(["codenomad-server", "opencode-config", "opencode-config-template", "opencode-config.js"])
  function walk(directory, prefix = "", depth = 0) {
    if (depth > 64) refuse("server-dist-bound-exceeded")
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!prefix && excluded.has(item.name) || /\.test\.js$/.test(item.name)) continue
      if (++visited > 8192) refuse("server-dist-bound-exceeded")
      const relative = `${prefix}${item.name}`, file = path.join(directory, item.name)
      if (item.isDirectory()) { exactPath(file, true); walk(file, `${relative}/`, depth + 1) }
      else records.push(`${relative}\0${sha256(readArtifact(file))}\n`)
    }
  }
  walk(root)
  return sha256(Buffer.from(records.join("")))
}
function prepareNativeHostResources({ workspaceRoot, serverRoot, target }) {
  if (!WINDOWS[target] && !OTHER.has(target)) refuse("unsupported-target")
  let plan
  const source = path.join(workspaceRoot, "packages", "native-host-lifetime", "resources", target)
  if (!WINDOWS[target] || target === "win32-arm64" && !fs.lstatSync(source, { throwIfNoEntry: false }))
    plan = { target, unavailable: "native-platform-not-implemented" }
  else {
    const manifest = validateManifest(parseJson(readArtifact(path.join(source, "manifest.json"), undefined, 8192)), target)
    if (manifest.node.version !== `v${fs.readFileSync(path.join(workspaceRoot, ".node-version"), "utf8").trim()}`) refuse("bundled-node-version-mismatch")
    if (manifest.build.cargoLockSha256 !== sha256(readArtifact(path.join(workspaceRoot, "packages", "native-host-lifetime", "Cargo.lock")))) refuse("cargo-lock-mismatch")
    verifyNativeFiles(source, manifest)
    for (const module of MODULES) readArtifact(path.join(serverRoot, "dist", module))
    const helpers = new Map()
    for (const file of NODE_FILES) helpers.set(`node/${file}`, readArtifact(path.join(workspaceRoot, "packages", "native-host-lifetime", "node", file)))
    helpers.set("native-host-resources.cjs", readArtifact(__filename))
    helpers.set("native-host-artifacts.cjs", readArtifact(path.join(__dirname, "native-host-artifacts.cjs")))
    const files = Object.fromEntries([...helpers].map(([file, bytes]) => [file, sha256(bytes)]))
    plan = { target, source, helpers, contract: { version: 1, target, abi: ABI, wire: WIRE,
      qualification: "resource-integrity-only", persistentLaunch: "disabled", opencodeRuntime: "unqualified",
      native: manifest, files, serverDistSha256: distDigest(path.join(serverRoot, "dist")) } }
  }
  const token = Object.freeze({ target })
  plans.set(token, plan)
  return token
}
function entrySource(role, contract) {
  return `// Generated trusted package entry. No argv/env/profile binding resolution.
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { Module, createRequire } from "node:module"
import { fileURLToPath } from "node:url"
const contract = ${JSON.stringify(contract)}
try {
  if (process.argv.length !== 2) throw new Error()
  const compile = (name, artifacts) => {
    const file = fileURLToPath(new URL(name, import.meta.url))
    const bytes = readFileSync(file)
    if (createHash("sha256").update(bytes).digest("hex") !== contract.files[name]) throw new Error()
    const fresh = new Module(file)
    fresh.filename = file
    const builtins = createRequire(import.meta.url)
    fresh.require = id => {
      if (id === "./native-host-artifacts.cjs" && artifacts) return artifacts
      if (id.startsWith("node:")) return builtins(id)
      throw new Error()
    }
    fresh._compile(bytes.toString("utf8"), file)
    return fresh.exports
  }
  // Fresh private modules: cached exports and extension hooks cannot substitute
  // integrity verification. No global cache entries or hooks are overwritten.
  const artifacts = compile("native-host-artifacts.cjs")
  const { verifyPackagedNativeRuntime } = compile("native-host-resources.cjs", artifacts)
  const trusted = verifyPackagedNativeRuntime(import.meta.url, contract)
  ${role === "manager" ? 'const { loadAndRunNativeRuntimeManager } = await import("../dist/host-lifetime/native-manager-entry.js")\n  await loadAndRunNativeRuntimeManager(trusted.bindingFile, trusted.bindingSha256)' : 'const { runNativeServiceBroker } = await import("./node/service-broker.mjs")\n  await runNativeServiceBroker(trusted.bindingFile, trusted.bindingSha256, trusted.launcher)'}
} catch {
  // Never print bootstrap/native/config/env errors.
  process.stderr.write("native-packaged-${role}-refused\\n")
  process.exit(1)
}
`
}
function stageNativeHostResources(token, serverRoot) {
  const plan = plans.get(token)
  if (!plan) refuse("prepared-resource-plan-required")
  const root = path.join(serverRoot, "native-host")
  fs.mkdirSync(root, { recursive: false })
  if (plan.unavailable) {
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ version: 1, target: plan.target,
      qualification: "unavailable", reason: plan.unavailable, persistentLaunch: "disabled" }))
    return
  }
  verifyNativeFiles(plan.source, plan.contract.native)
  if (distDigest(path.join(serverRoot, "dist")) !== plan.contract.serverDistSha256) refuse("server-dist-changed")
  for (const file of Object.values(NATIVE_FILES)) fs.copyFileSync(path.join(plan.source, file), path.join(root, file), fs.constants.COPYFILE_EXCL)
  for (const [file, bytes] of plan.helpers) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), bytes, { flag: "wx" })
  }
  const entries = {}
  for (const role of ["manager", "broker"]) {
    const file = `${role}-entry.mjs`, bytes = Buffer.from(entrySource(role, plan.contract))
    fs.writeFileSync(path.join(root, file), bytes, { flag: "wx" })
    entries[file] = sha256(bytes)
  }
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ ...plan.contract, entries }), { flag: "wx" })
  verifyStagedNativeHostResources(serverRoot)
}
function verifyContract(root, contract) {
  keys(contract, ["version", "target", "abi", "wire", "qualification", "persistentLaunch", "opencodeRuntime", "native", "files", "serverDistSha256"])
  if (contract.version !== 1 || contract.abi !== ABI || contract.wire !== WIRE || contract.qualification !== "resource-integrity-only"
    || contract.persistentLaunch !== "disabled" || contract.opencodeRuntime !== "unqualified") refuse("unqualified-contract")
  validateManifest(contract.native, contract.target)
  verifyNativeFiles(root, contract.native)
  keys(contract.files, [...NODE_FILES.map(file => `node/${file}`), "native-host-resources.cjs", "native-host-artifacts.cjs"])
  for (const [file, expected] of Object.entries(contract.files)) readArtifact(path.join(root, file), digest(expected))
  if (distDigest(path.join(path.dirname(root), "dist")) !== digest(contract.serverDistSha256)) refuse("server-dist-changed")
}
function verifyStagedNativeHostResources(serverRoot) {
  const root = path.join(serverRoot, "native-host")
  const manifest = parseJson(readArtifact(path.join(root, "manifest.json"), undefined, 32768))
  if (manifest.qualification === "unavailable") {
    keys(manifest, ["version", "target", "qualification", "reason", "persistentLaunch"])
    if (manifest.version !== 1 || !(OTHER.has(manifest.target) || manifest.target === "win32-arm64") || manifest.reason !== "native-platform-not-implemented" || manifest.persistentLaunch !== "disabled") refuse("unsupported-contract")
    if (fs.readdirSync(root).length !== 1) refuse("unexpected-native-artifacts")
    return manifest
  }
  verifyInventory(root)
  const { entries, ...contract } = manifest
  verifyContract(root, contract)
  keys(entries, ["manager-entry.mjs", "broker-entry.mjs"])
  for (const role of ["manager", "broker"]) {
    const file = `${role}-entry.mjs`, bytes = readArtifact(path.join(root, file), digest(entries[file]))
    if (!bytes.equals(Buffer.from(entrySource(role, contract)))) refuse("entry-contract-mismatch")
  }
  return manifest
}
function verifyInventory(root) {
  const allowed = new Set([...Object.values(NATIVE_FILES), ...NODE_FILES.map(file => `node/${file}`),
    "native-host-resources.cjs", "native-host-artifacts.cjs", "manifest.json", "manager-entry.mjs", "broker-entry.mjs"])
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.name === "node" && item.isDirectory()) {
      exactPath(path.join(root, "node"), true)
      for (const child of fs.readdirSync(path.join(root, "node"))) {
        if (!allowed.delete(`node/${child}`)) refuse("unexpected-native-artifacts")
      }
    } else if (!allowed.delete(item.name)) refuse("unexpected-native-artifacts")
  }
  if (allowed.size) refuse("missing-native-artifacts")
}
function verifyPackagedNativeRuntime(entryUrl, contract) {
  const entry = fileURLToPath(entryUrl), root = path.dirname(entry)
  exactPath(entry)
  if (!["manager-entry.mjs", "broker-entry.mjs"].includes(path.basename(entry))) refuse("entry-path")
  verifyInventory(root)
  verifyContract(root, contract)
  const node = path.join(path.dirname(path.dirname(root)), "node", contract.target, "node.exe")
  const expected = contract.native.node
  verifyPe(readArtifact(node, expected.sha256, MAX_NODE), contract.target)
  exactPath(process.execPath)
  if (process.execPath.toLowerCase() !== node.toLowerCase() || `${process.platform}-${process.arch}` !== contract.target
    || process.version !== expected.version || process.versions.modules !== expected.modules || process.versions.napi !== expected.napi
    || process.release.name !== "node" || typeof process.getBuiltinModule !== "function") refuse("packaged-node-runtime-mismatch")
  // Resource matching is NOT native qualification; callers still have to open
  // the genuine inherited private native session before any backend can start.
  const launcherModule = path.join(path.dirname(root), "dist", "workspaces", "native-service-launcher.js")
  return { bindingFile: path.join(root, NATIVE_FILES.binding), bindingSha256: contract.native.artifacts.binding.sha256,
    launcher: { launcherModule, launcherSha256: sha256(readArtifact(launcherModule)) } }
}

module.exports = { createNativeHostManifest, prepareNativeHostResources, stageNativeHostResources, verifyStagedNativeHostResources, verifyPackagedNativeRuntime }
