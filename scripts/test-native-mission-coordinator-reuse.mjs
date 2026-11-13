// node scripts/test-native-mission-coordinator-reuse.mjs <absolute-isolated-cli>
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"

const [cli] = process.argv.slice(2), method = { input: { type: "object" }, output: { type: "object" } }
const definition = { id: "codenomad.coordinator-qualification", methods: { begin: method, finish: method, read: method, probe: method, watermark: method,
  sameTime: method, backgroundStart: method, backgroundState: method, backgroundRelease: method }, events: {} }
await withProductRuntime(cli, async ({ root }) => {
  const directory = path.join(root, "qualification-plugin")
  await build({ ...nativePluginBuild, outfile: path.join(directory, "index.mjs"),
    entryPoints: [fileURLToPath(new URL("../packages/server/src/opencode/missions/native-scheduled-coordinator-native-fixture.ts", import.meta.url))] })
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "codenomad-reuse-qualification", version: "1.0.0", type: "module", exports: "./index.mjs" }))
  return { plugins: [directory], experimental: { subagent_depth: 3 }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    agents: { reuse_coordinator: { mode: "all", description: "Private reuse qualification", prompt: "Reply briefly, use no tools." },
      reuse_worker: { mode: "all", description: "Private inherited worker", prompt: "Reply briefly." } } }
}, async ({ client, root, requests }) => {
  const rpc = client.rpc(definition), options = { location: { directory: root }, signal: AbortSignal.timeout(120_000) }
  const until = async check => {
    for (const end = Date.now() + 30_000; Date.now() < end;) { const value = await check(); if (value) return value; await delay(50) }
    throw Error("Private native background deadline")
  }
  const permissions = [{ action: "shell", resource: "*", effect: "deny" }]
  const selected = await client.session.create({ location: { directory: root }, title: "Existing private work", agent: "build", permissions,
    metadata: { unrelated: "preserve", "codenomad.mission": { missionID: "other_mission", kind: "coordinator", role: "coordinator", version: 1 } } })
  await client.session.prompt({ sessionID: selected.id, text: "Earlier private work" })
  await client.session.wait({ sessionID: selected.id }, { signal: AbortSignal.timeout(30_000) })
  const historical = await client.session.create({ parentID: selected.id, location: { directory: root }, agent: "build", title: "Historical child" })
  await rpc.backgroundStart({ sessionID: historical.id }, options)
  await client.session.prompt({ sessionID: historical.id, text: "Earlier child work" })
  const inherited = await until(async () => { const state = await rpc.backgroundState({ sessionID: historical.id }, options); return state.last?.type === "idle" && state.childID ? state : undefined })
  const old = await client.session.context({ sessionID: selected.id }), firstRequest = { sessionID: selected.id, requestID: "first" }
  await assert.rejects(rpc.begin({ ...firstRequest, loseACK: true }, options))
  const attempted = (await rpc.read({}, options)).document
  assert.equal(attempted.pending.admissionAttempted, true)
  const first = await rpc.begin(firstRequest, options)
  assert.equal(first.admission.kind, "admitted"); assert.equal(first.document.launchedCount, 1)
  assert.ok(first.document.pending.coordinatorBaseline.find(row => row[0] === historical.id)[3], "idle parent with native background delivery keeps its existing input")
  await client.session.wait({ sessionID: selected.id }, { signal: AbortSignal.timeout(30_000) })
  assert.equal((await rpc.probe({}, options)).settled, false, "a pending native background result prevents settlement")
  await rpc.backgroundRelease({ failedResume: true }, options)
  const failedInherited = await until(async () => { const result = await rpc.probe({}, options); return result.outcome === "failed" ? result : undefined })
  const helper = await client.session.create({ parentID: selected.id, location: { directory: root }, agent: "build", title: "New child" })
  await client.session.prompt({ sessionID: helper.id, text: "First current helper input" })
  await client.session.wait({ sessionID: helper.id }, { signal: AbortSignal.timeout(30_000) })
  const entry = (await client.session.get({ sessionID: helper.id })).metadata["codenomad.passage-input"]
  assert.equal(entry.passageID, first.document.pending.id)
  await client.session.prompt({ sessionID: helper.id, text: "Later current helper input" })
  await client.session.wait({ sessionID: helper.id }, { signal: AbortSignal.timeout(30_000) })
  assert.deepEqual((await client.session.get({ sessionID: helper.id })).metadata["codenomad.passage-input"], entry)
  const completed = await rpc.finish({}, options)
  await rpc.backgroundStart({ sessionID: historical.id }, options)
  await client.session.prompt({ sessionID: historical.id, text: "Another inherited background task" })
  await until(async () => { const state = await rpc.backgroundState({ sessionID: historical.id }, options); return state.last?.type === "idle" && state.childID ? state : undefined })
  const second = await rpc.begin({ sessionID: selected.id, requestID: "second" }, options)
  assert.equal(second.document.pending.coordinatorSessionID, selected.id)
  assert.notEqual(second.document.pending.messageID, first.document.pending.messageID)
  assert.notEqual(second.document.pending.missionID, first.document.pending.missionID)
  await client.session.wait({ sessionID: selected.id }, { signal: AbortSignal.timeout(30_000) })
  await rpc.backgroundRelease({}, options)
  const successfulInherited = await until(async () => { const result = await rpc.probe({}, options); return result.outcome === "ended-without-report" ? result : undefined })
  const finished = await rpc.finish({}, options)
  assert.equal(finished.document.history.length, 2); assert.equal(finished.document.successfulCount, 2)
  assert.equal(completed.snapshot.missions[0].summary, "Native passage 1 delivered")
  assert.equal(finished.snapshot.missions[0].summary, "Native passage 2 delivered")
  const adopted = await client.session.get({ sessionID: selected.id }), context = await client.session.context({ sessionID: selected.id })
  assert.equal(adopted.title, selected.title); assert.deepEqual(adopted.permissions, selected.permissions)
  assert.equal(adopted.metadata.unrelated, "preserve"); assert.equal(adopted.agent, "reuse_coordinator")
  assert.deepEqual(adopted.model, { providerID: "fixture", id: "fixture", variant: "default" })
  assert.ok(old.every(message => context.some(item => item.id === message.id)))
  for (const receipt of finished.document.history) {
    assert.equal(context.filter(item => item.id === receipt.messageID).length, 1)
    assert.ok(receipt.settlementProof)
  }
  assert.equal(requests.length, 13, "two native background cycles, old root work, two passages and helper inputs, without duplicate original turns")
  const clock = await rpc.sameTime({ sessionID: historical.id }, options)
  assert.equal(clock.first.updated, clock.second.updated, "actual native updates can share a recency timestamp")
  assert.ok(clock.second.sequence > clock.first.sequence, "native aggregate sequence advances independently of the clock")
  const third = await rpc.begin({ sessionID: selected.id, requestID: "third" }, options)
  await client.session.wait({ sessionID: selected.id }, { signal: AbortSignal.timeout(30_000) })
  await client.session.prompt({ sessionID: helper.id, text: "First third-passage input" })
  await client.session.wait({ sessionID: helper.id }, { signal: AbortSignal.timeout(30_000) })
  const thirdEntry = (await client.session.get({ sessionID: helper.id })).metadata["codenomad.passage-input"]
  assert.equal(thirdEntry.passageID, third.document.pending.id)
  const beforeRevert = await rpc.watermark({ sessionID: helper.id }, options)
  await client.session.revert.stage({ sessionID: helper.id, messageID: thirdEntry.messageID, files: false })
  await client.session.revert.commit({ sessionID: helper.id })
  const afterRevert = await rpc.watermark({ sessionID: helper.id }, options)
  assert.ok(afterRevert.sequence > beforeRevert.sequence, "retention/reset preserves the native aggregate watermark")
  await client.session.prompt({ sessionID: helper.id, text: "Later input after native revert" })
  await client.session.wait({ sessionID: helper.id }, { signal: AbortSignal.timeout(30_000) })
  assert.deepEqual((await client.session.get({ sessionID: helper.id })).metadata["codenomad.passage-input"], thirdEntry)
  assert.equal((await rpc.probe({}, options)).settled, false, "a later native input cannot replace a pruned first owned input")
  assert.equal((await rpc.read({}, options)).document.pending.id, third.document.pending.id)
  await writeFile(path.join(root, "coordinator-reuse-receipt.json"), JSON.stringify({ version: (await client.server.info()).version,
    selected, attempted, first, completed, second, finished, adopted, context, clock, third, beforeRevert, afterRevert,
    inherited, failedInherited, successfulInherited }, null, 2))
  console.log("PASS: native adoption, inherited background success/failure, preserved work, isolated passages, lost ACK, child entries, fixed clock and prune/reset uncertainty")
}, { service: true })
