import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { McpCodeMode } from "../packages/server/src/opencode/mcp-code-mode.ts"

let file
await withProductRuntime(process.argv[2], async ({ configDirectory }) => {
  file = path.join(configDirectory, "opencode.jsonc")
  await writeFile(file, '{// retain\n"mcp":{"servers":{"fixture":{"type":"local","command":["unused-disabled-fixture"],"disabled":true}}}}')
}, async ({ client, root }) => {
  const location = { directory: root }
  await client.location.get({ location })
  const controls = new PluginControls({ workspaceManager: {
    get: () => ({}), getSharedServiceConnection: async () => ({ client, assertCurrent() {} }),
    getServiceDirectoryForPath: async (_id, directory) => directory === root ? root : undefined,
    ownsLocation: async (_id, location) => location.directory === root,
    getWorktreeIdentityForPath: async () => "fixture-root", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }, worktreeDeletionFence: { enter: () => () => {} }, logger: {} })
  const settings = new McpCodeMode(controls)
  for (const mode of [false, true, null]) {
    await settings.update("fixture", location, "global", "fixture", mode)
    const deadline = Date.now() + 30_000
    while ((await settings.read("fixture", location))[0]?.effective !== (mode !== false) && Date.now() < deadline) await delay(100)
    const entry = (await settings.read("fixture", location))[0]
    assert.equal(entry.effective, mode !== false)
    assert.equal(entry.scopes[0].mode, mode)
  }
  const text = await readFile(file, "utf8")
  assert.match(text, /retain/); assert.match(text, /unused-disabled-fixture/); assert.match(text, /"disabled":\s*true/)
  assert.equal(text.includes("codemode"), false)
  await assert.rejects(settings.update("fixture", location, "project", "fixture", false), /not configured/)
  await assert.rejects(settings.update("fixture", { directory: path.dirname(root) }, "global", "fixture", false))
  console.log("PASS native MCP tri-state source edits, hot reload, untouched connection config and source/ownership rejection")
})
