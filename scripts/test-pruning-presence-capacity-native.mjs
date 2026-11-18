// Build the pruning bundle first. Uses an owned daemon/home/DB, never the user's service.
// node --import tsx scripts/test-pruning-presence-capacity-native.mjs ABSOLUTE_CLI
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { tsImport } from "tsx/esm/api"
import { withProductRuntime } from "./native-product-fixture.mjs"

const { installPruningPresence } = await tsImport("../packages/server/src/opencode/pruning-installation.ts", import.meta.url)
const { awaitNativePlugin } = await tsImport("../packages/server/src/opencode/plugin-activation.ts", import.meta.url)
const { locationRequestOptions } = await tsImport("../packages/server/src/opencode/compatibility/location.ts", import.meta.url)
const bundle = await readFile(new URL("../packages/server/dist/plugins/session-pruning/plugin.mjs", import.meta.url))
let presence, directory, sentinel
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    const data = path.join(root, "codenomad")
    directory = path.join(data, "session-pruning", "presence")
    await mkdir(directory, { recursive: true })
    for (let i = 0; i < 445; i++) {
      const file = path.join(directory, `${randomUUID()}.lease`)
      await writeFile(file, "historical backend")
      await utimes(file, new Date(0), new Date(0))
      sentinel ??= file
    }
    presence = await installPruningPresence(bundle, { config: configDirectory, data })
    return {}
  }, async ({ root, client, requests }) => {
    const location = { directory: root }, options = locationRequestOptions(location)
    const signal = AbortSignal.timeout(5_000)
    await awaitNativePlugin(client, "codenomad-session-pruning", location, signal)
    await presence.prepare(root, signal, () => {})
    const catalogue = await client.plugin.list({ location }, options)
    assert.equal(catalogue.data.find(item => item.id === "codenomad-session-pruning")?.state.status, "active")
    const session = await client.session.create({ title: "Presence capacity fixture", location }, options)
    const outline = (await client.rpc.call({ rpcID: "codenomad.session-pruning", method: "outlineLayout",
      input: { sessionID: session.id }, location }, options)).output
    assert.equal(outline.status, "outline", JSON.stringify(outline))
    const pending = (await client.rpc.call({ rpcID: "codenomad.pending-requests", method: "snapshot",
      input: { directories: [root] }, location }, options)).output
    assert.equal(pending.originDirectory, root)
    assert.equal(pending.data[0].status, "complete")
    assert.equal(await readFile(sentinel, "utf8"), "historical backend")
    assert.equal((await readdir(directory)).filter(name => name.endsWith(".lease")).length, 446)
    assert.equal(requests.length, 0, "plugin activation and both reads make no provider calls")
    console.log("PASS: built pruning plugin active with 445 historical leases; fresh readiness, outlineLayout and loaded-only pending snapshot succeed")
  })
} finally { await presence?.() }
