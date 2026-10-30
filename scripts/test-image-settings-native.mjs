// Settings → Providers → Images against the native configuration contract and watcher.
// Usage: node --import tsx scripts/test-image-settings-native.mjs <absolute-cli>
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parse } from "jsonc-parser"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { ImageSettings } from "../packages/server/src/opencode/image-settings.ts"

let globalFile
await withProductRuntime(process.argv[2], async ({ configDirectory }) => {
  globalFile = path.join(configDirectory, "opencode.jsonc")
  await writeFile(globalFile, '{\n// retain fixture comment\n"experimental":{"subagent_depth":2}\n}\n')
}, async ({ client, root, connection }) => {
  await client.location.get({ location: { directory: root } })
  const manager = {
    get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
    ownsLocation: async (_id, location) => location.directory === root,
    getWorktreeIdentityForPath: async () => "fixture-root",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: {} })
  const settings = new ImageSettings(controls, manager), location = { directory: root }
  const until = async (predicate, message) => {
    const deadline = Date.now() + 30_000
    let snapshot = await settings.read("fixture", location)
    while (!predicate(snapshot) && Date.now() < deadline) { await delay(100); snapshot = await settings.read("fixture", location) }
    assert.ok(predicate(snapshot), message)
    return snapshot
  }

  const initial = await settings.read("fixture", location)
  assert.ok(initial.generation && initial.mediaStorage, "the runtime exposes both image settings")
  // OpenCode offers the image tool unless `experimental.image_generate` is `false`.
  assert.equal(initial.generation.global, true, "an unset image setting reads as on")
  assert.equal(initial.generation.effective, true)
  assert.ok(Array.isArray(initial.generation.models), "the native image-model catalog answers")
  await settings.update("fixture", location, { generation: "fixture/image-model#hd" })
  await until(snapshot => snapshot.generation.effective === "fixture/image-model#hd", "the native schema accepts a default model")
  assert.equal(initial.mediaStorage.effective, false)
  await settings.update("fixture", location, { mediaStorage: true })
  await until(snapshot => snapshot.mediaStorage.effective === true, "the native watcher applies media storage")
  const saved = await readFile(globalFile, "utf8")
  assert.match(saved, /retain fixture comment/)
  assert.deepEqual(parse(saved).experimental, { subagent_depth: 2, image_generate: { model: "fixture/image-model#hd" }, media_blob: true })

  await settings.update("fixture", location, { generation: false })
  await settings.update("fixture", location, { mediaStorage: false })
  await until(snapshot => snapshot.generation.effective === false && snapshot.mediaStorage.effective === false, "turning settings off applies natively")
  assert.deepEqual(parse(await readFile(globalFile, "utf8")).experimental, { subagent_depth: 2, image_generate: false, media_blob: false },
    "Off is written as an explicit false the native schema accepts")
  await settings.update("fixture", location, { generation: true })
  await until(snapshot => snapshot.generation.effective === true, "the native watcher applies image generation")
  await assert.rejects(settings.update("fixture", { directory: path.dirname(root) }, { mediaStorage: false }))

  // Layered Global documents: a new `experimental` object in the written opencode.jsonc would hide
  // opencode.json's whole object (subagent depth, todos), so the group is read-only and refuses writes.
  const lowerFile = path.join(path.dirname(globalFile), "opencode.json")
  await writeFile(lowerFile, '{"experimental":{"subagent_depth":7,"todo":true}}\n')
  await writeFile(globalFile, "{}\n")
  const blocked = await until(snapshot => snapshot.blockedBy?.path !== undefined, "the native layering is reported")
  assert.equal(path.resolve(blocked.blockedBy.path).toLowerCase(), path.resolve(lowerFile).toLowerCase())
  for (const change of [{ generation: true }, { mediaStorage: true }])
    await assert.rejects(settings.update("fixture", location, change), /hide inherited experimental/)
  assert.equal(await readFile(globalFile, "utf8"), "{}\n", "the masking write is refused")
  console.log("PASS native image settings: default-on generation, JSONC save, hot reload, reset, layered-Global refusal and foreign-location rejection")
})
