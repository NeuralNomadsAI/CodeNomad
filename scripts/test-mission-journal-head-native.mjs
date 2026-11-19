// Pass the absolute path to an OpenCode executable. Uses a private child and
// database containing only synthetic journal rows (no Mission or session RPC).
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"

const method = { input: { type: "object" }, output: { type: "object" } }
const rpc = { id: "fixture.mission-head", methods: { read: method }, events: {} }
await withProductRuntime(process.argv[2], async ({ root }) => {
  const directory = join(root, "journal-head")
  await mkdir(directory)
  const plugin = join(directory, "server.mjs")
  await build({ ...nativePluginBuild, stdin: { resolveDir: resolve("packages/server/src"), loader: "ts",
    contents: `
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { acquireNativeJournalRange } from "./opencode/missions/native-journal-range"
import { stableToken } from "./missions/receipt-identity"
export default Plugin.define({ id: "codenomad.missions", effect: ctx => {
  const missionID = "msn_fixture", id = "evt_fixture", { id: projectID, canonical } = ctx.location.project
  const key = "codenomad-missions/v2/" + stableToken(projectID + "\\0" + canonical, 24) + "/" + missionID + "/" + id
  return ctx.rpc.register(Rpc.define(${JSON.stringify(rpc)}), { read: input => Effect.gen(function* () {
    if (input.seed) yield* ctx.storage.set(key, { version:1, projectID, missionID, id, createdAt:1, type:"mission.updated",
      requestID: "fixture", expectedRevision:1, notesSpecified:false, objective:"alpha" })
    const range = yield* acquireNativeJournalRange(ctx)
    let objective, visits=0
    const result = yield* Effect.promise(() => range.readOrdered(missionID, batch => {
      visits += batch.length
      objective = batch[0].objective
    }, () => true, input.digest))
    if (input.save) yield* Effect.promise(() => range.saveDisplay(missionID, result.digest, '{"fixture":true}'))
    const display = yield* Effect.promise(() => range.readDisplay(missionID, () => id))
    return { ...result, key, visits, ...(objective === undefined ? {} : { objective }),
      ...(display ? { source: display.event?.objective, display: display.value } : {}) }
  }) }).pipe(Effect.asVoid)
} })
` }, outfile: plugin })
  await writeFile(join(directory, "package.json"), '{"type":"module","exports":{"./server":"./server.mjs"}}\n')
  return { plugins: [pathToFileURL(directory).href] }
}, async ({ client, root, env }) => {
  const location = { directory: root }
  const deadline = Date.now() + 15_000
  while (!(await client.plugin.list({ location })).data.some(entry => entry.id === "codenomad.missions" && entry.state.status === "active")) {
    assert.ok(Date.now() < deadline, "Private journal qualification plugin unavailable")
    await delay(100)
  }
  const read = input => client.rpc(rpc).read(input, { location })
  const first = await read({ seed: true, save: true })
  assert.equal(first.objective, "alpha")
  assert.match(first.digest, /\//, "native database must qualify the indexed path")
  assert.equal(first.display, '{"fixture":true}')
  assert.equal(first.source, "alpha")
  assert.equal((await read({ digest: first.digest })).visits, 0)
  const db = new DatabaseSync(env.OPENCODE_DB)
  try {
    const key = `plugin:${Buffer.from("codenomad.missions", "utf16le").swap16().toString("hex")}:${first.key}`
    assert.equal(db.prepare("UPDATE kv SET value=replace(value,'alpha','bravo') WHERE key=?").run(key).changes, 1)
  } finally { db.close() }
  const second = await read({ digest: first.digest })
  assert.notEqual(second.digest, first.digest)
  assert.equal(second.objective, "bravo")
  assert.equal(second.display, undefined, "external edits invalidate the persisted projection")
  console.log("Native transaction index observed a same-size external rewrite")
})
