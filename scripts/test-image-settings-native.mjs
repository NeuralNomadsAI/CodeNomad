// Settings → Providers → Images against the native configuration contract and watcher.
// Usage: node --import tsx scripts/test-image-settings-native.mjs <absolute-cli> [--expect-supported]
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parse } from "jsonc-parser"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { ImageSettings } from "../packages/server/src/opencode/image-settings.ts"

const expectSupported = process.argv.includes("--expect-supported")
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
  if (expectSupported) assert.ok(initial.generation && initial.mediaStorage, "the latest runtime exposes both image settings")
  const before = await readFile(globalFile, "utf8")
  for (const [present, change] of [[initial.generation, { generation: true }], [initial.mediaStorage, { mediaStorage: true }]]) {
    if (!present) await assert.rejects(settings.update("fixture", location, change), /no such image setting/)
  }
  assert.equal(await readFile(globalFile, "utf8"), before, "a setting the runtime lacks is never written")
  const expected = { subagent_depth: 2 }

  if (initial.generation) {
    assert.equal(initial.generation.global, false)
    assert.ok(Array.isArray(initial.generation.models), "the native image-model catalog answers")
    await settings.update("fixture", location, { generation: true })
    await until(snapshot => snapshot.generation.effective === true, "the native watcher applies image generation")
    await settings.update("fixture", location, { generation: "fixture/image-model#hd" })
    await until(snapshot => snapshot.generation.effective === "fixture/image-model#hd", "the native schema accepts a default model")
    expected.image_generate = { model: "fixture/image-model#hd" }
  }
  if (initial.mediaStorage) {
    assert.equal(initial.mediaStorage.effective, false)
    await settings.update("fixture", location, { mediaStorage: true })
    await until(snapshot => snapshot.mediaStorage.effective === true, "the native watcher applies media storage")
    expected.media_blob = true
  }
  const saved = await readFile(globalFile, "utf8")
  assert.match(saved, /retain fixture comment/)
  assert.deepEqual(parse(saved).experimental, expected)

  if (initial.generation) await settings.update("fixture", location, { generation: false })
  if (initial.mediaStorage) await settings.update("fixture", location, { mediaStorage: false })
  await until(snapshot => !snapshot.generation?.effective && !snapshot.mediaStorage?.effective, "turning settings off applies natively")
  assert.deepEqual(parse(await readFile(globalFile, "utf8")).experimental, {
    subagent_depth: 2, ...(initial.generation ? { image_generate: false } : {}), ...(initial.mediaStorage ? { media_blob: false } : {}),
  }, "Off is written as an explicit false the native schema accepts")
  await assert.rejects(settings.update("fixture", { directory: path.dirname(root) }, { mediaStorage: false }))

  // Layered Global documents: a new `experimental` object in the written opencode.jsonc would hide
  // opencode.json's whole object (subagent depth, todos), so the group is read-only and refuses writes.
  if (initial.generation || initial.mediaStorage) {
    const lowerFile = path.join(path.dirname(globalFile), "opencode.json")
    await writeFile(lowerFile, '{"experimental":{"subagent_depth":7,"todo":true}}\n')
    await writeFile(globalFile, "{}\n")
    const blocked = await until(snapshot => snapshot.blockedBy?.path !== undefined, "the native layering is reported")
    assert.equal(path.resolve(blocked.blockedBy.path).toLowerCase(), path.resolve(lowerFile).toLowerCase())
    for (const change of [initial.generation && { generation: true }, initial.mediaStorage && { mediaStorage: true }].filter(Boolean))
      await assert.rejects(settings.update("fixture", location, change), /hide inherited experimental/)
    assert.equal(await readFile(globalFile, "utf8"), "{}\n", "the masking write is refused")
  }
  console.log(`PASS native image settings (generation: ${Boolean(initial.generation)}, media storage: ${Boolean(initial.mediaStorage)}): `
    + "contract detection, JSONC save, hot reload, reset, layered-Global refusal, unsupported-key refusal and foreign-location rejection")
})
