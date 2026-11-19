// Isolated Git install and real native resolver/RPC; no user daemon or public registry.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"

let target, revision, repository
const git = (...args) => {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: repository, encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
  repository = path.join(root, "git-package")
  await mkdir(repository)
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "git-fixture-plugin", version: "1.2.3", type: "module", exports: "./index.js" }))
  await writeFile(path.join(repository, "index.js"), 'export default { id: "fixture.git", setup() {} }\n')
  git("init")
  git("add", ".")
  git("commit", "-m", "fixture")
  revision = git("rev-parse", "HEAD")
  target = `git+${pathToFileURL(repository).href}`
  const bundle = path.join(root, "versions.mjs")
  await build({ ...nativePluginBuild,
    entryPoints: [fileURLToPath(new URL("../packages/server/src/opencode/plugin-package-versions.ts", import.meta.url))], outfile: bundle,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } })
  const plugins = path.join(configDirectory, "plugins")
  await mkdir(plugins)
  await writeFile(path.join(plugins, "versions.ts"), `import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { registerPluginPackageVersions } from ${JSON.stringify(pathToFileURL(bundle).href)}
export default Plugin.define({ id: "fixture.versions", effect: ctx => Effect.asVoid(registerPluginPackageVersions(ctx)) })
`)
  return { plugins: [target] }
}, async ({ client, root, connection }) => {
  const location = { directory: root }
  await client.location.get({ location })
  const controls = new PluginControls({ workspaceManager: {
    get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async () => root, ownsLocation: async () => true,
    getWorktreeIdentityForPath: async () => "fixture", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } })
  const settle = async expected => {
    const deadline = Date.now() + 30_000
    do {
      const snapshot = await controls.read("fixture", location)
      const plugin = snapshot.runtime.find(entry => entry.id === "fixture.git")
      if (plugin?.source.version === expected) return plugin.source
      await delay(100)
    } while (Date.now() < deadline)
    assert.fail(`Git version did not settle to ${expected}`)
  }
  assert.deepEqual(await settle("1.2.3"), { type: "package", target, version: "1.2.3", revision })
  const native = (await client.plugin.list({ location })).data.find(entry => entry.id === "fixture.git")
  assert.equal(native.source.version, revision)
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "git-fixture-plugin", version: "1.2.4", type: "module", exports: "./index.js" }))
  git("add", ".")
  git("commit", "-m", "update")
  revision = git("rev-parse", "HEAD")
  const checked = await client.plugin.check({ location, target })
  assert.equal(checked.data.find(entry => entry.id === "fixture.git").source.outdated, true)
  await client.plugin.update({ location, targets: [target] })
  const updated = await settle("1.2.4")
  assert.equal(updated.revision, revision)
  console.log("PASS installed Git manifest version, native commit, unchanged check/update and refreshed display")
})
