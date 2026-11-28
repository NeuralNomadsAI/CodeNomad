// Run against the installed CLI in an isolated foreground server, never the shared service.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { installDesktopPluginPresence } from "../packages/server/src/opencode/desktop-plugin-installation.ts"
import { withProductRuntime } from "./native-product-fixture.mjs"

const pluginId = "codenomad.missions"
const directoryOf = file => fileURLToPath(new URL(`../packages/server/dist/plugins/missions/${file}`, import.meta.url))
const original = '{\n  // unrelated user settings\n  "username": "fixture"\n}\n'
let config, dispose
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    config = path.join(configDirectory, "opencode.jsonc")
    await writeFile(config, original)
    dispose = await installDesktopPluginPresence("missions", await readFile(directoryOf("plugin.mjs")),
      { config: configDirectory, data: path.join(root, "presence") })
    return {}
  }, async ({ client, root, connection, requests }) => {
    const directory = path.join(root, "project")
    const otherDirectory = path.join(root, "other-project")
    await mkdir(directory)
    await mkdir(otherDirectory)
    const location = { directory }
    const controls = new PluginControls({ workspaceManager: {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id, value) => value === directory ? directory : undefined,
      ownsLocation: async (_id, candidate) => candidate.directory === directory,
      getWorktreeIdentityForPath: async () => "fixture-root", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
    }, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } })
    const { id: sessionID } = await client.session.create({ location })
    const until = async (check, label) => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const result = await check()
        if (result) return result
        await delay(100)
      }
      assert.fail(label)
    }
    const checkTools = async (text, enabled) => {
      const cursor = requests.length
      await client.session.prompt({ sessionID, text })
      const request = await until(() => requests.slice(cursor)
        .find(request => request.tools?.length && request.messages?.some(message => message.role === "user" && JSON.stringify(message.content).includes(text))),
      `Existing session did not reach the test provider: ${text}`)
      assert.equal(request.tools?.some(tool => tool.function?.name?.startsWith("mission_")) ?? false, enabled, text)
    }
    const settle = enabled => until(async () => {
      const [snapshot, other] = await Promise.all([controls.read("fixture", location), client.plugin.list({ location: { directory: otherDirectory } })])
      const control = snapshot.controls.find(item => item.id === pluginId)
      const otherPlugin = other.data.find(item => item.id === pluginId)
      return control?.managedBy === "codenomad" && (control.effective !== "disabled") === enabled
        && (enabled ? control.runtime?.state.status === "active" && otherPlugin?.state.status === "active"
          : !control.runtime && !otherPlugin)
    }, `Native Missions activation did not settle to ${enabled}`)
    const activate = enabled => controls.mutate("fixture", { location, pluginId, scope: "global", enabled, managedBy: "codenomad" })
    await settle(true)
    await checkTools("Missions enabled, before disable", true)
    assert.equal((await activate(false)).reloadPending, true)
    assert.match(await readFile(config, "utf8"), /"-codenomad\.missions"/)
    await settle(false)
    await checkTools("Missions disabled in the same session", false)
    assert.equal((await activate(true)).reloadPending, true)
    await settle(true)
    await checkTools("Missions enabled again in the same session", true)
    const updated = await readFile(config, "utf8")
    assert.deepEqual(parse(updated).plugins, [pluginId])
    assert.match(updated, /\/\/ unrelated user settings/)
    assert.match(updated, /"username": "fixture"/)
    console.log("PASS: native hot disable/re-enable removes/restores Mission tools in an existing session")
  })
} finally { await dispose?.() }
