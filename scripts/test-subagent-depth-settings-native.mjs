// Private native schema + production document admission; no reload or shared service.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { SubagentDepthSettings } from "../packages/server/src/opencode/subagent-depth-settings.ts"

await withProductRuntime(process.argv[2], async ({ configDirectory }) => {
  await writeFile(path.join(configDirectory, "opencode.jsonc"), '{"experimental":{"subagent_depth":2}}\n')
}, async ({ client, root, connection }) => {
  await client.location.get({ location: { directory: root } })
  const manager = {
    get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
    ownsLocation: async (_id, location) => location.directory === root,
    getWorktreeIdentityForPath: async () => "private-fixture-root",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }
  const controls = new PluginControls({ workspaceManager: manager,
    worktreeDeletionFence: { enter: () => () => {} }, logger: {} })
  const settings = new SubagentDepthSettings(controls, manager), location = { directory: root }
  const initial = await settings.read("fixture", location)
  assert.equal(initial.capability.minimum, 0)
  assert.equal(initial.effectiveDepth, 2)
  const file = initial.project.path
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{\n// retain private comment\n"experimental":{"foreign":true},"shell":"keep"\n}\n')
  for (const value of [0, 1, 3]) {
    const before = await settings.read("fixture", location)
    await settings.update("fixture", location, value, before.project.expectation)
    const saved = await readFile(file, "utf8")
    assert.match(saved, /retain private comment/)
    assert.deepEqual(parse(saved).experimental, { foreign: true, subagent_depth: value })
    assert.equal(parse(saved).shell, "keep")
    await assert.rejects(settings.update("fixture", location, 2, before.project.expectation), /changed/)
  }
  const fresh = await settings.read("fixture", location)
  await settings.update("fixture", location, null, fresh.project.expectation)
  assert.deepEqual(parse(await readFile(file, "utf8")).experimental, { foreign: true })
  await assert.rejects(settings.update("fixture", { directory: path.dirname(root) }, 1, fresh.project.expectation))
  console.log("PASS actual native depth capability, project JSONC save/reset, original-draft conflicts and foreign-location rejection")
  console.log("NOT QUALIFIED: depth-0 execution semantics or watcher activation; fixture intentionally disables project discovery")
})
