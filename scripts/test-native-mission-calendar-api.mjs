// node scripts/test-native-mission-calendar-api.mjs <absolute-isolated-cli> <plugin|core>
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { withProductRuntime } from "./native-product-fixture.mjs"

const [cli, expected] = process.argv.slice(2)
assert(["plugin", "core"].includes(expected), "Specify the expected calendar API")
const source = name => fileURLToPath(new URL(`../packages/server/src/opencode/missions/${name}.ts`, import.meta.url))
await withProductRuntime(cli, async ({ root, configDirectory }) => {
  const plugins = path.join(configDirectory, "plugins")
  await Promise.all([mkdir(plugins), mkdir(path.join(root, "project"))])
  const runtime = path.join(root, "calendar.mjs"), provider = path.join(root, "provider.mjs")
  await Promise.all([
    build({ ...nativePluginBuild, entryPoints: [source("native-schedule-calendar-native-fixture")], outfile: runtime }),
    build({ ...nativePluginBuild, entryPoints: [source("native-schedule-carrier-provider")], outfile: provider }),
  ])
  const artifact = async file => ({ file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") })
  const options = { runtime: await artifact(runtime), provider: await artifact(provider), logFile: path.join(root, "calendar-errors.log") }
  await writeFile(path.join(plugins, "calendar.ts"), `import plugin from ${JSON.stringify(pathToFileURL(runtime).href)}
export default { id: plugin.id, effect: ctx => plugin.effect({ ...ctx, options: ${JSON.stringify(options)} }) }\n`)
  await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({
    ...(expected === "plugin" ? { automations: true } : { experimental: { automations: true } }),
  }))
  return {}
}, async ({ client, root, requests }) => {
  const method = { input: { type: "object" }, output: { type: "object" } }
  const id = "codenomad.calendar-owner-qualification", location = { directory: path.join(root, "project") }, signal = AbortSignal.timeout(20_000)
  for (;;) {
    const catalog = await client.plugin.list({ location, signal })
    const plugin = catalog.data.find(plugin => plugin.id === id)
    if (plugin) { assert.equal(plugin.state.status, "active", JSON.stringify(plugin.state)); break }
    await delay(100, undefined, { signal })
  }
  const rpc = client.rpc({ id, methods: { methods: method, dst: method, off: method }, events: {} })
  const result = await rpc.methods({}, { location, signal })
  assert.deepEqual(result.publicCalls, expected === "plugin" ? { create: 4, list: 1, delete: 4 } : { create: 0, list: 0, delete: 0 })
  assert.equal(result.lostReply, expected === "plugin")
  assert.deepEqual(result.anchored.map(item => item.type), ["every", "every-phase", "in"])
  assert.equal(requests.length, 0)
  console.log(JSON.stringify({ version: (await client.server.info()).version, expected, ...result }, null, 2))
}, { service: true })
