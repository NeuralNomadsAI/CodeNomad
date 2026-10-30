// node scripts/test-native-mission-schedule-list.mjs <absolute-isolated-cli>
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFile } from "node:fs/promises"
import { build } from "esbuild"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { buildNativeScheduleFoundation } from "../packages/server/scripts/build-native-schedule-foundation.mjs"

const [cli] = process.argv.slice(2)
const method = { input: { type: "object" }, output: { type: "object" } }
const definition = { id: "codenomad.schedule-list-qualification", methods: {
  seed: method, scheduleRead: method, scheduleList: method,
}, events: {} }

await withProductRuntime(cli, async ({ root }) => {
  const directory = path.join(root, "qualification-plugin")
  const artifacts = await buildNativeScheduleFoundation(path.join(root, "artifacts"))
  const result = await build({ ...nativePluginBuild, metafile: true, outfile: path.join(directory, "index.mjs"),
    entryPoints: [fileURLToPath(new URL("../packages/server/src/opencode/missions/native-mission-schedule-list-native-fixture.ts", import.meta.url))] })
  assert(!Object.keys(result.metafile.inputs).some(file => /node_modules[/\\](effect|@opencode[/\\]plugin)[/\\]/.test(file)))
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "codenomad-schedule-list-qualification", version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }))
  return { plugins: [{ package: directory, options: artifacts }], experimental: { schedules: true } }
}, async ({ client, root, requests }) => {
  const info = await client.server.info()
  assert.equal(info.version, "2.2.3")
  const rpc = client.rpc(definition), options = { location: { directory: root }, signal: AbortSignal.timeout(20_000) }
  const seed = await rpc.seed({}, options)
  assert.equal(seed.count, 10); assert.equal(seed.tombstone, "display_01"); assert.equal(seed.armed, "display_08")
  assert.ok(Number.isSafeInteger(seed.principalDueAt) && seed.principalDueAt > Date.now())
  const first = await rpc.scheduleList({ limit: 8 }, options)
  assert.equal(first.schedules.length, 7, "The tombstone consumes one of the eight native page slots")
  assert.equal(first.next, "display_07")
  const second = await rpc.scheduleList({ after: first.next, limit: 8 }, options)
  assert.deepEqual(second.schedules.map(item => item.id), ["display_08", "display_09", "display_10"])
  assert.equal(second.next, undefined)
  const detail = await rpc.scheduleRead({ missionID: "display_08" }, options)
  assert.deepEqual(detail.document, second.schedules[0])
  assert.deepEqual(await rpc.scheduleList({ limit: 8 }, options), first, "Repeated reads preserve every document revision")
  for (const row of [...first.schedules, ...second.schedules]) {
    assert.equal(row.launchedCount, 0)
    assert.equal(row.checks.count, 0)
    assert.ok(Number.isSafeInteger(row.checks.since) && row.checks.since > 0 && row.checks.since <= Date.now())
    if (row.id === seed.armed) {
      assert.equal(row.state, "running"); assert.equal(row.observation.state, "known")
      assert.equal(row.observation.nextDueAt, seed.principalDueAt); assert.equal(row.observation.wakeCount, 0)
      assert.ok(row.availableActions.includes("pause"))
    } else {
      assert.equal(row.state, "paused"); assert.equal(row.firstPlayedAt, null)
      assert.equal(row.observation.state, "unarmed"); assert.equal(row.observation.nextDueAt, null)
      assert.ok(row.availableActions.includes("play"))
    }
    assert.ok(row.edit.structural)
  }
  await client.experimental.schedule.pause({ scheduleID: seed.principalID })
  const paused = await rpc.scheduleRead({ missionID: seed.armed }, options)
  assert.equal(paused.document.state, "running", "Desired state is preserved by a display read")
  assert.equal(paused.document.revision, detail.document.revision)
  assert.equal(paused.document.observation.nativeStatus, "paused")
  assert.equal(paused.document.observation.nextDueAt, null)
  await client.experimental.schedule.delete({ scheduleID: seed.principalID })
  const missing = await rpc.scheduleRead({ missionID: seed.armed }, options)
  assert.equal(missing.document.revision, detail.document.revision)
  assert.equal(missing.document.observation.state, "unknown", "A missing native row is never rearmed by a read")
  assert.equal(missing.document.observation.wakeCount, null)
  assert.equal(requests.length, 0, "Display qualification sends no model request")
  await writeFile(path.join(root, "schedule-list-receipt.json"), JSON.stringify({ version: info.version,
    first, second, detail, paused, missing, modelRequests: requests.length }, null, 2))
  console.log("PASS: real native RPC/storage.scan pagination, tombstone cursor, list/detail parity and mutation-free reads")
})
