import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { WebSearchSettings } from "../packages/server/src/opencode/websearch-settings.ts"

let configurationDirectory
await withProductRuntime(process.argv[2], async ({ configDirectory }) => {
  configurationDirectory = configDirectory
  await writeFile(path.join(configDirectory, "opencode.jsonc"), '{\n// retain fixture comment\n"websearch":false\n}\n')
}, async ({ client, root }) => {
  await client.location.get({ location: { directory: root } })
  const connection = { client, assertCurrent() {} }
  const controls = new PluginControls({ workspaceManager: {
    get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
    ownsLocation: async (_id, location) => location.directory === root,
    getWorktreeIdentityForPath: async () => "fixture-root", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }, worktreeDeletionFence: { enter: () => () => {} }, logger: {} })
  const settings = new WebSearchSettings(controls), location = { directory: root }
  assert.equal((await settings.read("fixture", location)).effective, false)
  await settings.update("fixture", location, "global", "random")
  const deadline = Date.now() + 30_000
  while ((await settings.read("fixture", location)).effective !== "random" && Date.now() < deadline) await delay(100)
  assert.equal((await settings.read("fixture", location)).effective, "random", "Native watcher must apply global edits without location.reload")
  assert.match(await readFile(path.join(configurationDirectory, "opencode.jsonc"), "utf8"), /retain fixture comment/)
  await settings.update("fixture", location, "project", false)
  const project = (await settings.read("fixture", location)).scopes.find(item => item.scope === "project")
  assert.equal(project.selection, false)
  await settings.update("fixture", location, "project", null)
  assert.equal((await settings.read("fixture", location)).scopes.find(item => item.scope === "project").selection, null)
  await assert.rejects(settings.update("fixture", { directory: path.dirname(root) }, "global", false))
  console.log("PASS native global discovery/hot reload, scoped project persistence/reset and foreign-directory rejection")
})
