import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fixtureEnvironment, withProductRuntime } from "./native-product-fixture.mjs"

let version = "1.0.0", base
const archives = new Map()
const registry = createServer((req, res) => {
  if (req.url.startsWith("/fixture-plugin/-/")) {
    const archive = archives.get(req.url.split("/").at(-1))
    res.writeHead(archive ? 200 : 404, { "Content-Type": "application/octet-stream" }); res.end(archive); return
  }
  if (req.url.split("?")[0] !== "/fixture-plugin") { res.writeHead(404); res.end(); return }
  const versions = Object.fromEntries(["1.0.0", "1.1.0"].map(v => [v, { name: "fixture-plugin", version: v,
    dist: { tarball: `${base}/fixture-plugin/-/${v}.tgz` } }]))
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ name: "fixture-plugin", "dist-tags": { latest: version }, versions }))
})
await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve))
base = `http://127.0.0.1:${registry.address().port}`
try {
  await withProductRuntime(process.argv[2], async ({ root }) => {
    const env = await fixtureEnvironment(root)
    for (const key of ["BLENDER_SYSTEM_SCRIPTS", "BLENDER_SYSTEM_DATAFILES", "BLENDER_SYSTEM_PYTHON"]) {
      env[key] = path.join(root, key); await mkdir(env[key], { recursive: true })
    }
    await writeFile(path.join(root, ".npmrc"), `registry=${base}\naudit=false\nfund=false\n`)
    for (const v of ["1.0.0", "1.1.0"]) {
      const directory = path.join(root, v), pkg = path.join(directory, "package")
      await mkdir(pkg, { recursive: true })
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture-plugin", version: v, type: "module", exports: { ".": "./index.js" } }))
      await writeFile(path.join(pkg, "index.js"), 'export default { id: "fixture.package", setup() {} }\n')
      const tarball = path.join(root, `${v}.tgz`)
      await promisify(execFile)("tar", ["-czf", tarball, "-C", directory, "package"], { env, cwd: root, windowsHide: true, timeout: 5_000 })
      archives.set(`${v}.tgz`, await readFile(tarball))
    }
    return { plugins: ["fixture-plugin@latest"] }
  }, async ({ client, root, connection }) => {
    const location = { directory: root }
    await client.location.get({ location })
    const waitFor = async predicate => {
      const deadline = Date.now() + 60_000
      let info
      do {
        info = (await client.plugin.list({ location })).data.find(item => item.source.type === "package" && item.source.target === "fixture-plugin@latest")
        if (info && predicate(info)) return info
        await delay(100)
      } while (Date.now() < deadline)
      assert.fail(`Native package state did not settle: ${JSON.stringify(info)}`)
    }
    await waitFor(info => info.state.status === "active" && info.source.version === "1.0.0")
    version = "1.1.0"
    const checked = await client.plugin.check({ location, target: "fixture-plugin@latest" })
    assert.equal(checked.data.find(item => item.source.type === "package").source.outdated, true)
    await assert.rejects(client.plugin.update({ location, targets: ["not-in-inventory"] }))
    if (process.argv.includes("--authority")) {
      // This optional internal-service probe needs node --import tsx. No HTTP mutation surface.
      const { PluginControls } = await import("../packages/server/src/opencode/plugin-controls.ts")
      const { PluginPackages } = await import("../packages/server/src/opencode/plugin-packages.ts")
      const { NativeMutationUncertainError } = await import("../packages/server/src/opencode/native-mutation-authority.ts")
      let revoked = false, revokeAfterRead = false, revokeAfterUpdate = false, updates = 0
      const recorded = { ...connection, client: { ...client, plugin: { ...client.plugin, update: async (...args) => {
        updates++
        await client.plugin.update(...args)
        if (revokeAfterUpdate) revoked = true
      } } } }
      const manager = {
        get: () => ({}), getSharedServiceConnection: async () => recorded,
        ownsLocation: async (_id, candidate) => candidate.directory === root && candidate.workspaceID === undefined,
        getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
        getWorktreeIdentityForPath: async () => root,
        getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
        getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, directory) => directory,
      }
      const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } })
      const packages = new PluginPackages({ workspaceManager: manager, controls: { read: async (...args) => {
        const snapshot = await controls.read(...args)
        if (revokeAfterRead) revoked = true
        return snapshot
      } } })
      const authority = { async revalidate() {}, assertCurrent() { if (revoked) throw new Error("revoked authority") } }
      for (const reason of ["expired", "session", "digest", "connection", "stale mount"]) {
        await assert.rejects(packages.update("fixture", location, "fixture-plugin@latest", AbortSignal.timeout(10_000), {
          async revalidate() { throw new Error(reason) }, assertCurrent() {},
        }))
      }
      revokeAfterRead = true
      await assert.rejects(packages.update("fixture", location, "fixture-plugin@latest", AbortSignal.timeout(10_000), authority))
      assert.equal(updates, 0)
      assert.equal((await waitFor(info => info.state.status === "active")).source.version, "1.0.0")
      revoked = false; revokeAfterRead = false; revokeAfterUpdate = true
      await assert.rejects(packages.update("fixture", location, "fixture-plugin@latest", AbortSignal.timeout(10_000), authority), NativeMutationUncertainError)
      await waitFor(info => info.state.status === "active" && info.source.version === "1.1.0" && !info.source.updating)
      assert.equal(updates, 1, "uncertain submission is never replayed")
      revoked = false; revokeAfterUpdate = false
      await packages.update("fixture", location, "fixture-plugin@latest", AbortSignal.timeout(10_000), authority)
      await packages.update("fixture", location, "fixture-plugin@latest", AbortSignal.timeout(10_000))
      assert.equal(updates, 3, "valid authority and ordinary calls each submit once")
      console.log("PASS internal native package admission: real controls/client, refused authorities zero submissions, post-update revocation uncertain with real version change, valid/ordinary controls")
    }
    await client.plugin.update({ location, targets: ["fixture-plugin@latest"] })
    await waitFor(info => info.state.status === "active" && info.source.version === "1.1.0" && !info.source.updating)
    console.log("PASS isolated registry package check/update, unknown-target rejection and native live reload")
  })
} finally { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)) }
