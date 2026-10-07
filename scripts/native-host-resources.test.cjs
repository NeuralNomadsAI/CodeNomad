const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { spawnSync } = require("node:child_process")
const test = require("node:test")
const { readArtifact, sha256, verifyPe } = require("./native-host-artifacts.cjs")
const { createNativeHostManifest, prepareNativeHostResources, stageNativeHostResources, verifyStagedNativeHostResources, verifyPackagedNativeRuntime } = require("./native-host-resources.cjs")
const { copyPackagedServerResources, stagePackagedServer } = require("./desktop-server-resources.cjs")
const tempBase = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir()
const repository = path.resolve(__dirname, "..")

// Synthetic PE/fingerprint data exercise resource validation, NEVER native
// qualification. No native target/addon is built, overwritten or launched.
function pe(target = "win32-x64", addon = false) {
  const bytes = Buffer.alloc(0x600)
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x4550, 0x80)
  bytes.writeUInt16LE(target === "win32-x64" ? 0x8664 : 0xaa64, 0x84)
  bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(0xf0, 0x94)
  bytes.writeUInt16LE(addon ? 0x2002 : 2, 0x96); bytes.writeUInt16LE(0x20b, 0x98)
  bytes.writeUInt32LE(0x1000, 0x194); bytes.writeUInt32LE(0x400, 0x198); bytes.writeUInt32LE(0x200, 0x19c)
  if (addon) {
    bytes.writeUInt32LE(0x1000, 0x108)
    bytes.writeUInt32LE(1, 0x218); bytes.writeUInt32LE(0x1040, 0x220)
    bytes.writeUInt32LE(0x1050, 0x240)
    bytes.write("napi_register_module_v1\0", 0x250)
  }
  return bytes
}
function fixture(t, target = "win32-x64") {
  const root = fs.mkdtempSync(path.join(tempBase, "native-resources-unit-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), server = path.join(root, "source-server")
  const native = path.join(workspace, "packages", "native-host-lifetime"), source = path.join(native, "resources", target)
  for (const directory of [source, path.join(native, "node"), path.join(server, "public"), path.join(server, "node_modules"), path.join(server, "dist", "host-lifetime"), path.join(server, "dist", "workspaces")])
    fs.mkdirSync(directory, { recursive: true })
  const lock = Buffer.from("synthetic cargo lock, not build evidence")
  fs.writeFileSync(path.join(native, "Cargo.lock"), lock)
  fs.writeFileSync(path.join(workspace, ".node-version"), process.version.slice(1))
  fs.writeFileSync(path.join(workspace, "package.json"), "{}")
  fs.writeFileSync(path.join(workspace, "package-lock.json"), JSON.stringify({ packages: { "packages/server": { dependencies: {} } } }))
  fs.writeFileSync(path.join(server, "package.json"), JSON.stringify({ type: "module" }))
  for (const file of ["service-broker.mjs", "owned-starter.mjs", "channel-codec.mjs"])
    fs.copyFileSync(path.join(repository, "packages", "native-host-lifetime", "node", file), path.join(native, "node", file))
  for (const module of ["host-lifetime/native-manager-entry.js", "host-lifetime/backend-entry.js", "index.js", "workspaces/native-service-launcher.js"])
    fs.writeFileSync(path.join(server, "dist", module), 'throw new Error("unit fixture must never start backend")\n')
  const artifacts = { "supervisor.exe": pe(target), "runtime.node": pe(target, true), "cargo-fingerprint.json": Buffer.from(JSON.stringify({ features: "[]", declared_features: '["fixtures"]' })) }
  for (const [name, bytes] of Object.entries(artifacts)) fs.writeFileSync(path.join(source, name), bytes)
  const manifest = { version: 1, target, abi: "codenomad.runtime.v1", wire: "CNHRv001",
    build: { profile: "release", targetTriple: target === "win32-x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc", features: [], cargoLockSha256: sha256(lock) },
    node: { version: process.version, modules: process.versions.modules, napi: process.versions.napi, sha256: sha256(pe(target)) },
    artifacts: Object.fromEntries([ ["supervisor", "supervisor.exe"], ["binding", "runtime.node"], ["fingerprint", "cargo-fingerprint.json"] ]
      .map(([name, file]) => [name, { file, sha256: sha256(artifacts[file]) }])) }
  const save = () => fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest))
  save()
  const prepare = () => prepareNativeHostResources({ workspaceRoot: workspace, serverRoot: server, target })
  return { root, workspace, server, native, source, manifest, save, prepare }
}

test("manifest producer consumes exact artifact/Node evidence without building or modifying inputs", t => {
  const f = fixture(t), nodeFile = path.join(f.root, "node.exe")
  fs.writeFileSync(nodeFile, pe())
  const options = { artifactRoot: f.source, target: "win32-x64", cargoLockFile: path.join(f.native, "Cargo.lock"), nodeFile,
    nodeEvidence: { target: "win32-x64", ...f.manifest.node } }
  const before = fs.readFileSync(path.join(f.source, "manifest.json"))
  assert.deepEqual(createNativeHostManifest(options), f.manifest)
  assert.deepEqual(fs.readFileSync(path.join(f.source, "manifest.json")), before)
  assert.throws(() => createNativeHostManifest({ ...options, nodeEvidence: { ...options.nodeEvidence, target: "win32-arm64" } }), /node-evidence-target/)
  assert.throws(() => createNativeHostManifest({ ...options, nodeEvidence: { ...options.nodeEvidence, sha256: "0".repeat(64) } }), /artifact-digest-mismatch/)
})

for (const target of ["win32-x64", "win32-arm64"]) test(`shared ${target} package retains exact artifacts and executable trusted entries`, t => {
  const f = fixture(t, target)
  stageNativeHostResources(f.prepare(), f.server)
  const manifests = []
  for (const host of ["electron", "tauri"]) {
    const dest = path.join(f.root, host, "server")
    copyPackagedServerResources({ serverRoot: f.server, serverDest: dest })
    const manifest = verifyStagedNativeHostResources(dest)
    manifests.push(fs.readFileSync(path.join(dest, "native-host", "manifest.json")))
    assert.equal(manifest.qualification, "resource-integrity-only")
    assert.equal(manifest.persistentLaunch, "disabled")
    assert.equal(manifest.opencodeRuntime, "unqualified")
    for (const role of ["manager", "broker"]) {
      const entry = fs.readFileSync(path.join(dest, "native-host", `${role}-entry.mjs`), "utf8")
      assert.match(entry, role === "manager" ? /await loadAndRunNativeRuntimeManager\(trusted.bindingFile/ : /await runNativeServiceBroker\(trusted.bindingFile/)
      assert.doesNotMatch(entry, /process\.env|process\.argv\[/)
    }
  }
  assert.deepEqual(manifests[0], manifests[1])
})

for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) test(`${target} explicitly records unsupported native lifetime without changing ordinary server resources`, t => {
  const f = fixture(t)
  const plan = prepareNativeHostResources({ workspaceRoot: f.workspace, serverRoot: f.server, target })
  stageNativeHostResources(plan, f.server)
  const manifest = verifyStagedNativeHostResources(f.server)
  assert.equal(manifest.qualification, "unavailable")
  assert.equal(manifest.persistentLaunch, "disabled")
  assert.deepEqual(fs.readdirSync(path.join(f.server, "native-host")), ["manifest.json"])
})

test("unprovisioned Windows ARM64 packages ordinary resources with lifetime explicitly disabled", t => {
  const f = fixture(t)
  const plan = prepareNativeHostResources({ workspaceRoot: f.workspace, serverRoot: f.server, target: "win32-arm64" })
  stageNativeHostResources(plan, f.server)
  for (const host of ["electron", "tauri"]) {
    const dest = path.join(f.root, host, "server")
    copyPackagedServerResources({ serverRoot: f.server, serverDest: dest })
    const manifest = verifyStagedNativeHostResources(dest)
    assert.equal(manifest.target, "win32-arm64")
    assert.equal(manifest.qualification, "unavailable")
    assert.equal(manifest.persistentLaunch, "disabled")
    assert.deepEqual(fs.readdirSync(path.join(dest, "native-host")), ["manifest.json"])
  }
})

test("an existing but incomplete ARM64 resource directory still fails closed", t => {
  const f = fixture(t, "win32-arm64")
  fs.unlinkSync(path.join(f.source, "manifest.json"))
  assert.throws(f.prepare, /ENOENT/)
})

const manifestFaults = {
  "wrong target": f => { f.manifest.target = "win32-arm64" },
  "wrong ABI": f => { f.manifest.abi = "fake.runtime.v1" },
  "wrong wire": f => { f.manifest.wire = "fakewire" },
  "unknown fields": f => { f.manifest.allowFixture = false },
  "debug build": f => { f.manifest.build.profile = "debug" },
  "fixture feature": f => { f.manifest.build.features = ["fixtures"] },
  "wrong triple": f => { f.manifest.build.targetTriple = "aarch64-pc-windows-msvc" },
  "cargo lock": f => { f.manifest.build.cargoLockSha256 = "0".repeat(64) },
  "node pin": f => { f.manifest.node.version = "v0.0.0" },
  "node ABI": f => { f.manifest.node.napi = "7" },
  "invalid digest": f => { f.manifest.artifacts.binding.sha256 = "bad" },
  "parent path": f => { f.manifest.artifacts.binding.file = "../runtime.node" },
  "absolute path": f => { f.manifest.artifacts.binding.file = path.join(f.source, "runtime.node") },
}
for (const [name, fault] of Object.entries(manifestFaults)) test(`rejects manifest ${name}`, t => {
  const f = fixture(t); fault(f); f.save()
  assert.throws(f.prepare, /Native host resources:/)
})

for (const file of ["manifest.json", "supervisor.exe", "runtime.node", "cargo-fingerprint.json"]) test(`missing ${file} refuses before npm or package replacement`, t => {
  const f = fixture(t)
  fs.unlinkSync(path.join(f.source, file))
  const before = fs.readdirSync(f.root).sort()
  assert.throws(() => stagePackagedServer({ workspaceRoot: f.workspace, serverRoot: f.server, target: "win32-x64" }), /ENOENT/)
  assert.deepEqual(fs.readdirSync(f.root).sort(), before)
})

test("rejects actual fixture fingerprint even when manifest declares no features", t => {
  const f = fixture(t), bytes = Buffer.from(JSON.stringify({ features: '["fixtures"]' }))
  fs.writeFileSync(path.join(f.source, "cargo-fingerprint.json"), bytes)
  f.manifest.artifacts.fingerprint.sha256 = sha256(bytes); f.save()
  assert.throws(f.prepare, /fixture-build-fingerprint-forbidden/)
})
test("rejects fixture-only bytes even with a matching digest and empty fingerprint", t => {
  const f = fixture(t), bytes = pe("win32-x64", true)
  bytes.write("fixtureAuthorizeNestedResponse", 0x400)
  fs.writeFileSync(path.join(f.source, "runtime.node"), bytes)
  f.manifest.artifacts.binding.sha256 = sha256(bytes); f.save()
  assert.throws(f.prepare, /fixture-artifact-forbidden/)
})
test("rejects missing N-API export and incorrect PE architecture/kind", () => {
  const bytes = pe("win32-x64", true); bytes.write("not_a_napi_export______\0", 0x250)
  assert.throws(() => verifyPe(bytes, "win32-x64", true), /napi-export-missing/)
  assert.throws(() => verifyPe(pe("win32-arm64", true), "win32-x64", true), /pe-target-mismatch/)
  assert.throws(() => verifyPe(pe(), "win32-x64", true), /pe-kind-mismatch/)
  assert.throws(() => verifyPe(Buffer.from("text .node"), "win32-x64", true), /invalid-pe/)
})
test("rejects changed source artifact between preparation and staging", t => {
  const f = fixture(t), plan = f.prepare()
  fs.appendFileSync(path.join(f.source, "runtime.node"), "changed")
  assert.throws(() => stageNativeHostResources(plan, f.server), /artifact-digest-mismatch/)
})
test("rejects unprepared structural plan and unsupported target", t => {
  const f = fixture(t)
  assert.throws(() => stageNativeHostResources({ target: "win32-x64", unavailable: "pretend" }, f.server), /prepared-resource-plan-required/)
  assert.throws(() => prepareNativeHostResources({ workspaceRoot: f.workspace, serverRoot: f.server, target: "freebsd-x64" }), /unsupported-target/)
  const plan = f.prepare()
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Reflect.set(plan, "unavailable", "pretend"), false)
  assert.deepEqual(Object.keys(plan), ["target"])
})
test("unexpected staged fixture artifacts cannot enter either desktop package", t => {
  const f = fixture(t)
  stageNativeHostResources(f.prepare(), f.server)
  fs.writeFileSync(path.join(f.server, "native-host", "host-lifetime-fixture.exe"), pe())
  assert.throws(() => verifyStagedNativeHostResources(f.server), /unexpected-native-artifacts/)
})
test("rewriting an entry and its manifest digest does not bypass the fixed invocation template", t => {
  const f = fixture(t)
  stageNativeHostResources(f.prepare(), f.server)
  const root = path.join(f.server, "native-host"), manifest = verifyStagedNativeHostResources(f.server)
  const bytes = Buffer.from("// silently substitute another entry\n")
  fs.writeFileSync(path.join(root, "manager-entry.mjs"), bytes)
  manifest.entries["manager-entry.mjs"] = sha256(bytes)
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest))
  assert.throws(() => verifyStagedNativeHostResources(f.server), /entry-contract-mismatch/)
})
test("rejects hard-linked artifact without reading its declared digest as authority", t => {
  const f = fixture(t), file = path.join(f.source, "runtime.node")
  fs.linkSync(file, path.join(f.root, "linked.node"))
  assert.throws(f.prepare, /unsafe-artifact-type/)
})
test("bounded reads refuse oversized artifacts and invalid JSON without executing input", t => {
  const f = fixture(t), file = path.join(f.source, "manifest.json")
  assert.throws(() => readArtifact(file, undefined, 1), /unsafe-artifact-read/)
  fs.writeFileSync(file, "not-json")
  assert.throws(f.prepare, /manifest-json/)
})
test("rejects redirected directory ancestors", t => {
  const f = fixture(t), source = f.source, moved = path.join(f.root, "moved-native")
  fs.renameSync(source, moved)
  fs.symlinkSync(moved, source, process.platform === "win32" ? "junction" : "dir")
  assert.throws(f.prepare, /linked-path|redirected-path/)
})

for (const file of ["runtime.node", "node/service-broker.mjs", "manager-entry.mjs", "broker-entry.mjs", "../dist/index.js"]) test(`changed staged ${file} refuses before deleting existing destination`, t => {
  const f = fixture(t)
  stageNativeHostResources(f.prepare(), f.server)
  fs.appendFileSync(path.join(f.server, "native-host", file), "tampered")
  const dest = path.join(f.root, "destination")
  fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, "preserved.txt"), "original")
  assert.throws(() => copyPackagedServerResources({ serverRoot: f.server, serverDest: dest }), /Native host resources:/)
  assert.equal(fs.readFileSync(path.join(dest, "preserved.txt"), "utf8"), "original")
})
test("a declared unavailable Windows contract cannot bypass missing artifacts", t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.server, "native-host"))
  fs.writeFileSync(path.join(f.server, "native-host", "manifest.json"), JSON.stringify({ version: 1, target: "win32-x64",
    qualification: "unavailable", reason: "native-platform-not-implemented", persistentLaunch: "disabled" }))
  assert.throws(() => verifyStagedNativeHostResources(f.server), /unsupported-contract/)
})
test("packaged runtime refuses a missing Node and a different actual executable without loading native code", t => {
  const f = fixture(t)
  stageNativeHostResources(f.prepare(), f.server)
  const { entries, ...contract } = verifyStagedNativeHostResources(f.server)
  const entry = pathToFileURL(path.join(f.server, "native-host", "manager-entry.mjs")).href
  assert.throws(() => verifyPackagedNativeRuntime(entry, contract), /ENOENT/)
  const nodeRoot = path.join(f.root, "node", "win32-x64")
  fs.mkdirSync(nodeRoot, { recursive: true }); fs.writeFileSync(path.join(nodeRoot, "node.exe"), pe())
  assert.throws(() => verifyPackagedNativeRuntime(entry, contract), /packaged-node-runtime-mismatch/)
})
for (const role of ["manager", "broker"]) test(`generated ${role} entry is executable and rejects argv/config flags before native startup`, t => {
  const f = fixture(t)
  stageNativeHostResources(f.prepare(), f.server)
  const entry = path.join(f.server, "native-host", `${role}-entry.mjs`)
  const result = spawnSync(process.execPath, [entry, "--binding", "secret-never-printed"], {
    cwd: f.root, env: { ...process.env, CODENOMAD_NATIVE_PARENT: "1" }, encoding: "utf8", timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, `native-packaged-${role}-refused\n`)
})
for (const role of ["manager", "broker"]) test(`generated ${role} verification cannot be replaced through CJS cache or extension hooks`, t => {
  const f = fixture(t)
  stageNativeHostResources(f.prepare(), f.server)
  const root = path.join(f.server, "native-host"), entry = path.join(root, `${role}-entry.mjs`)
  const source = `import { createRequire, Module } from 'node:module';
    const require = createRequire(import.meta.url); let calls = 0;
    const files = ${JSON.stringify([path.join(root, "native-host-resources.cjs"), path.join(root, "native-host-artifacts.cjs")])};
    const bait = { verifyPackagedNativeRuntime(){ calls++; throw Error('bait'); } };
    for(const file of files) require.cache[file] = { exports: bait };
    const hook = () => { calls++; }; Module._extensions['.cjs'] = hook;
    process.on('exit', () => {
      if(calls || files.some(file => require.cache[file].exports !== bait) || Module._extensions['.cjs'] !== hook) process.exitCode = 8;
      else process.stdout.write('checks-not-substituted');
    });
    process.argv = [process.execPath, ${JSON.stringify(entry)}];
    await import(${JSON.stringify(pathToFileURL(entry).href)});`
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: f.root, encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "checks-not-substituted")
  assert.equal(result.stderr, `native-packaged-${role}-refused\n`)
})
test("broker cannot accept cached/extension-hook JS exports for a hash-matching nonnative .node", t => {
  const f = fixture(t), binding = path.join(f.root, "bait.node"), bytes = Buffer.from("not a native addon")
  fs.writeFileSync(binding, bytes)
  const broker = pathToFileURL(path.join(repository, "packages", "native-host-lifetime", "node", "service-broker.mjs")).href
  const source = `import { createRequire, Module } from 'node:module';
    import { runNativeServiceBroker } from ${JSON.stringify(broker)};
    const require = createRequire(import.meta.url), file = ${JSON.stringify(binding)};
    let calls = 0; const bait = { abi:'codenomad.runtime.v1', openServicePeer(){ calls++; throw Error('bait') } };
    require.cache[file] = { exports: bait }; const hook = () => { calls++; }; Module._extensions['.node'] = hook;
    try { await runNativeServiceBroker(file, ${JSON.stringify(sha256(bytes))}); process.exit(9); } catch {}
    if(calls || require.cache[file].exports !== bait || Module._extensions['.node'] !== hook) process.exit(8);
    process.stdout.write('native-loader-refused');`
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: f.root, encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "native-loader-refused")
})

test("missing staged contract refuses without replacing the destination", t => {
  const f = fixture(t), dest = path.join(f.root, "old-server")
  fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, "sentinel"), "kept")
  assert.throws(() => copyPackagedServerResources({ serverRoot: f.server, serverDest: dest }), /ENOENT/)
  assert.equal(fs.readFileSync(path.join(dest, "sentinel"), "utf8"), "kept")
})
