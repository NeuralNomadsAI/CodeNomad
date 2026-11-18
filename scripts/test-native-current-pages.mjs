// Explicit isolated CLI only; deterministic storage seeds, no provider/model calls.
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFile } from "node:fs/promises"
import { build } from "esbuild"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { tsImport } from "tsx/esm/api"

const [cli] = process.argv.slice(2), method = { input: { type: "object" }, output: { type: "object" } }
const definition = { id: "codenomad.current-display-qualification", methods: { seed: method }, events: {} }
const { CODENOMAD_MISSIONS_RPC } = await tsImport("../packages/server/src/missions/rpc.ts", import.meta.url)
await withProductRuntime(cli, async ({ root }) => {
  const directory = path.join(root, "current-display-plugin")
  const result = await build({ ...nativePluginBuild, metafile: true, outfile: path.join(directory, "index.mjs"),
    entryPoints: [fileURLToPath(new URL("../packages/server/src/opencode/missions/native-current-pages-native-fixture.ts", import.meta.url))] })
  assert(!Object.keys(result.metafile.inputs).some(file => /node_modules[/\\](effect|@opencode[/\\]plugin)[/\\]/.test(file)))
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "current-display-qualification", version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }))
  return { plugins: [{ package: directory }] }
}, async ({ client, root, requests }) => {
  const version = (await client.server.info()).version
  assert.equal(version, "2.2.3")
  const rpc = client.rpc(CODENOMAD_MISSIONS_RPC), options = { location: { directory: root }, signal: AbortSignal.timeout(90000) }
  const seed = await client.rpc(definition).seed({}, options), receipts = []
  for (const selected of seed.schedules) {
    const identity = await rpc.recurrenceCurrent(selected, options)
    assert.equal(identity.mission, undefined); assert.equal(identity.source.owner, selected.owner)
    assert.ok(Buffer.byteLength(JSON.stringify(identity)) <= 65536)
    const read = async (selector, body) => {
      let cursor, digest, text = []
      do {
        const result = await rpc.recurrenceCurrentPage({ source: identity.source, selector: { ...selector, ...(cursor ? { cursor } : {}) }, ...(body ? { body } : {}) }, options)
        assert.equal(result.available, true); assert.deepEqual(result.passage, identity.source)
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536)
        digest ??= result.page.digest; assert.equal(result.page.digest, digest)
        for (const piece of result.page.pieces) { assert.equal(piece.offset, text[piece.index]?.length ?? 0); text[piece.index] = (text[piece.index] ?? "") + piece.text }
        cursor = result.page.next
      } while (cursor)
      return text.map(value => JSON.parse(value))
    }
    const missionID = identity.source.missionID
    const [header] = await read({ source: "mission", missionID, header: true })
    assert.equal(header.tasks.page.total, seed.tasks); assert.equal(header.root.tasks, undefined)
    const [last] = await read({ source: "tasks", task: { missionID, offset: 50, order: header.tasks.page.order } })
    assert.equal(last.tasks.length, seed.tasks - 50)
    const task = last.tasks.at(-1), [body] = await read({ source: "mission", missionID, field: "body", window: { offset: 0 } },
      { missionID, kind: "task", taskKey: task.key, field: "brief", offset: 0 })
    assert.equal(task.key, "wide-body")
    assert.equal(body.content.characters, 20000); assert.ok(body.content.text.startsWith("\u0001")); assert.ok(body.content.next > 0)
    let text = body.content.text, next = body.content.next
    while (next !== undefined) {
      const [continued] = await read({ source: "mission", missionID, field: "body", window: { offset: 0 } },
        { missionID, kind: "task", taskKey: task.key, field: "brief", offset: next, digest: body.content.digest })
      text += continued.content.text; next = continued.content.next
    }
    assert.equal(text, "\u0001".repeat(20000))
    await assert.rejects(rpc.recurrenceCurrentPage({ source: { ...identity.source, digest: "z".repeat(43) }, selector: { source: "mission", missionID, header: true } }, options))
    assert.deepEqual(await rpc.recurrenceCurrent(selected, options), identity, "reads preserve the owner and original passage")
    const legacy = await rpc.recurrenceCurrentContent({ ...selected, passageID: identity.passageID, kind: "overview", section: "objective" }, options)
    assert.equal(legacy.sourceText, "Exact display"); assert.ok(Buffer.byteLength(JSON.stringify(legacy)) <= 65536)
    receipts.push({ owner: selected.owner, identity, headerBytes: Buffer.byteLength(JSON.stringify(header)), tasks: seed.tasks, bodyCharacters: 20000 })
  }
  assert.equal(requests.length, 0)
  await writeFile(path.join(root, "current-display-receipt.json"), JSON.stringify({ version, receipts, modelRequests: requests.length }, null, 2))
  console.log("PASS: daily and scheduled current native Effect graphs, bounded headers/tasks/bodies, exact continuations, source refusal and zero model requests")
})
