// Plugins surface add/remove against a real isolated daemon and a loopback fake npm
// registry: a registry spec loads (version reported), an unknown package fails with a
// native `ref` (404), duplicates and stale removals are refused, and removal unloads
// the plugin while leaving the package cache in place.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parse } from "jsonc-parser"
import { startFakeNpmRegistry } from "./fixtures/fake-npm-registry.mjs"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { PluginSources } from "../packages/server/src/opencode/plugin-sources.ts"

// Every name but fixture-plugin, including the missing one, is unknown to this registry.
const registry = await startFakeNpmRegistry()
const { requested } = registry

let configDirectory
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory: directory }) => {
    configDirectory = directory
    const staging = path.join(root, "staging"), pkg = path.join(staging, "package")
    await mkdir(pkg, { recursive: true })
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0", type: "module", exports: { ".": "./index.js" } }))
    await writeFile(path.join(pkg, "index.js"), 'export default { id: "fixture.package", setup() {} }\n')
    const tarball = path.join(root, "1.0.0.tgz")
    const tar = spawnSync("tar", ["-czf", tarball, "-C", staging, "package"], { encoding: "utf8" })
    assert.equal(tar.status, 0, tar.stderr)
    registry.publish("fixture-plugin", "1.0.0", await readFile(tarball))
    await writeFile(path.join(directory, "opencode.jsonc"), '{\n  // fixture comment\n  "plugins": []\n}\n')
    return {}
  }, async ({ client, root, connection }) => {
    const location = { directory: root }
    await client.location.get({ location })
    const controls = new PluginControls({ workspaceManager: {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
      ownsLocation: async (_id, candidate) => candidate.directory === root,
      getWorktreeIdentityForPath: async () => "fixture-root", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
    }, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } })
    const sources = new PluginSources({ documents: controls, logger: { info() {} } })
    const settle = async (predicate, label) => {
      const deadline = Date.now() + 90_000
      let snapshot
      do {
        snapshot = await controls.read("fixture", location)
        if (predicate(snapshot)) return snapshot
        await delay(200)
      } while (Date.now() < deadline)
      assert.fail(`${label} did not settle: ${JSON.stringify(snapshot.runtime)}`)
    }
    const runtimeFor = (snapshot, target) => snapshot.runtime.find(entry => entry.source.type === "package" && entry.source.target === target)

    await sources.add("fixture", { location, scope: "global", spec: "fixture-plugin@1.0.0" })
    let snapshot = await settle(value => runtimeFor(value, "fixture-plugin@1.0.0")?.state.status === "active", "Registry install")
    assert.equal(runtimeFor(snapshot, "fixture-plugin@1.0.0").source.version, "1.0.0")
    assert.equal(snapshot.configured.sources.find(source => source.target === "fixture-plugin@1.0.0")?.pluginId, "fixture.package")
    assert.match(await readFile(path.join(configDirectory, "opencode.jsonc"), "utf8"), /fixture comment/)

    await assert.rejects(sources.add("fixture", { location, scope: "project", spec: "Fixture-Plugin@latest" }), error => error.code === "duplicate")

    await sources.add("fixture", { location, scope: "global", spec: "missing-plugin@1.0.0" })
    snapshot = await settle(value => runtimeFor(value, "missing-plugin@1.0.0")?.state.status === "failed", "Unknown package")
    const failed = runtimeFor(snapshot, "missing-plugin@1.0.0").state
    assert.match(failed.ref ?? "", /^err_/, `A failed install reports a native ref: ${JSON.stringify(failed)}`)
    assert.ok(requested.some(url => url.startsWith("/missing-plugin")), "The install reached the loopback registry only")

    const confirmed = await controls.read("fixture", location)
    const declared = confirmed.configured.sources.find(source => source.target === "fixture-plugin@1.0.0")
    const expectedRevision = confirmed.targets.find(target => target.scope === "global").expectedRevision
    await assert.rejects(sources.remove("fixture", { location, scope: "global", target: "fixture-plugin@1.0.0", entryIndex: declared.entryIndex + 1, expectedRevision }),
      error => error.code === "stale")
    await sources.remove("fixture", { location, scope: "global", target: declared.target, entryIndex: declared.entryIndex, expectedRevision })
    await settle(value => !runtimeFor(value, "fixture-plugin@1.0.0") && !value.runtime.some(entry => entry.id === "fixture.package"), "Removal")
    const plugins = parse(await readFile(path.join(configDirectory, "opencode.jsonc"), "utf8")).plugins
    assert.deepEqual(plugins, ["missing-plugin@1.0.0"], "removal deletes exactly the displayed entry")
    assert.ok(await containsPackage(root, "fixture-plugin"), "The native package cache is left in place")
    console.log("PASS native add (registry spec, version), 404 failure with ref, duplicate refusal, stale removal, removal unload with cache kept")
  }, { registry: registry.url })
} finally { await registry.close() }

async function containsPackage(directory, name, depth = 0) {
  if (depth > 8) return false
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return false }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "staging") continue
    const child = path.join(directory, entry.name)
    if (entry.name === name && path.basename(directory) === "node_modules") return true
    if (await containsPackage(child, name, depth + 1)) return true
  }
  return false
}
