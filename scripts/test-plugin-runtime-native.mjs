// Explicit isolated CLI/bundle only; no shared service, real credentials or user storage.
import assert from "node:assert/strict"
import { readFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import { withProductRuntime } from "./native-product-fixture.mjs"

const bundle = process.argv[3] ?? fileURLToPath(new URL("../packages/server/dist/plugins/session-pruning/plugin.mjs", import.meta.url))
assert(path.isAbsolute(bundle), "Pass an absolute private bundle path")
const { installPruningPresence } = await tsImport("../packages/server/src/opencode/pruning-installation.ts", import.meta.url)
let closePresence
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    closePresence = await installPruningPresence(await readFile(bundle), { config: configDirectory, data: path.join(root, "presence") })
    return {}
  }, async ({ client, root, connection }) => {
    const location = { directory: root }
    await client.location.get({ location })
    const deadline = Date.now() + 15_000
    let plugin
    do {
      plugin = (await client.plugin.list({ location })).data.find(item => item.id === "codenomad-session-pruning" || item.source.type === "local" && item.state.status === "failed")
      if (plugin?.state.status === "failed") throw new Error(JSON.stringify(plugin))
      if (plugin?.state.status === "active") break
      await delay(50)
    } while (Date.now() < deadline)
    assert.equal(plugin?.state.status, "active", "Shipped plugin must load")
    const session = await client.session.create({ location })
    const form = await client.session.form.create({ sessionID: session.id, title: "Runtime contract fixture", fields: [{ key: "answer", type: "string" }] })
    const cold = path.join(root, "cold")
    await mkdir(cold)
    const url = new URL("/api/rpc/codenomad.pending-requests/snapshot", connection.endpoint.url)
    url.searchParams.set("location[directory]", root)
    const response = await connection.fetch(url, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`opencode:${connection.endpoint.auth.password}`).toString("base64")}` },
      body: JSON.stringify({ input: { directories: [root, cold] } }) })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const snapshot = JSON.parse(text).output
    assert.equal(snapshot.originDirectory, root)
    assert(snapshot.data.find(item => item.directory === root).locations.some(item => item.forms.some(item => item.id === form.id)))
    assert.deepEqual(snapshot.data.find(item => item.directory === cold).locations, [])
    await client.session.form.cancel({ sessionID: session.id, formID: form.id })
    console.log("PASS: native plugin loading, host Effect/Schema/RPC, existing-only pending snapshot and Form settlement")
  })
} finally { await closePresence?.() }
