// node scripts/test-native-mission-preparation.mjs <absolute-isolated-cli>
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFile } from "node:fs/promises"
import { build } from "esbuild"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
const [cli] = process.argv.slice(2)
const method = { input: { type: "object" }, output: { type: "object" } }
const definition = { id: "codenomad.preparation-qualification", methods: { create: method, configure: method, read: method, play: method }, events: {} }
await withProductRuntime(cli, async ({ root }) => {
  const directory = path.join(root, "qualification-plugin")
  await build({ ...nativePluginBuild, outfile: path.join(directory, "index.mjs"),
    entryPoints: [fileURLToPath(new URL("../packages/server/src/opencode/missions/native-mission-preparation-native-fixture.ts", import.meta.url))] })
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "codenomad-preparation-qualification", version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }))
  return { plugins: [directory], agents: { preparation_coordinator: { mode: "all", description: "Private preparation qualification", prompt: "Reply briefly, use no tools." } } }
}, async ({ client, root, requests }) => {
  const info = await client.server.info(); assert.equal(info.version, "2.2.3")
  const rpc = client.rpc(definition), options = { location: { directory: root }, signal: AbortSignal.timeout(30000) }
  const created = (await rpc.create({ requestID: "private_creation" }, options)).mission
  const original = await rpc.read({ missionID: created.id }, options), binding = original.document.oneTime
  const configuration = { ...original.document.configuration, title: "Edited private preparation", objective: "Edited private instructions",
    template: "delivery", taskMode: "independent", profiles: { coordinator: { agent: "preparation_coordinator", model: { providerID: "fixture", id: "fixture", variant: "default" } },
      roles: { developer: { agent: "build", model: { providerID: "fixture", id: "fixture" } } } } }
  const input = { missionID: created.id, requestID: "private_edit", expectedRevision: original.document.revision, configuration }
  await assert.rejects(rpc.configure({ ...input, loseNativeACK: true }, options))
  const partial = await rpc.read({ missionID: created.id }, options)
  assert.equal(partial.document.preparation.pending, true)
  assert.equal(partial.document.preparation.attempted, true)
  const replacement = partial.document.preparation.coordinatorSessionID
  const native = await client.session.get({ sessionID: replacement })
  assert.equal(native.agent, "preparation_coordinator"); assert.deepEqual(native.model, configuration.profiles.coordinator.model)
  assert.equal(requests.length, 0, "Create and edit never request a model")
  const edited = (await rpc.configure(input, options)).document
  assert.equal(edited.preparation.pending, false); assert.equal(edited.oneTime.coordinatorSessionID, replacement)
  assert.deepEqual({ ...edited.oneTime, coordinatorSessionID: binding.coordinatorSessionID }, binding)
  assert.deepEqual((await rpc.configure(input, options)).document, edited, "lost response replay remains exactly idempotent")
   let snapshot = (await rpc.read({ missionID: created.id }, options)).snapshot
   assert.equal(snapshot.missions.length, 1); assert.equal(snapshot.missions[0].coordinatorSessionId, replacement)
   const followed = await client.session.create({ title: "Private followed context", location: { directory: root }, agent: "preparation_coordinator" })
   await client.session.prompt({ sessionID: followed.id, text: "Frozen private followed context at Play" })
   await client.session.wait({ sessionID: followed.id }, { signal: AbortSignal.timeout(30000) })
   const sourceRequests = requests.length
   const scheduled = (await rpc.configure({ missionID: created.id, requestID: "private_scheduled", expectedRevision: edited.revision,
     configuration: { ...configuration, profileID: "fixture", executionHost: "fixture", watchedConversationIDs: [followed.id],
       template: "custom", profiles: { coordinator: configuration.profiles.coordinator, roles: { specialist: configuration.profiles.coordinator } },
       launch: { ...configuration.launch, timing: { kind: "every", intervalMs: 900000 } } } }, options)).document
   const immediate = (await rpc.configure({ missionID: created.id, requestID: "private_immediate", expectedRevision: scheduled.revision,
     configuration: { ...configuration, watchedConversationIDs: [followed.id] } }, options)).document
   assert.equal(immediate.id, created.id); assert.equal(immediate.firstPlayedAt, null)
   assert.equal(requests.length, sourceRequests, "source selection and conversion never request a model")
   snapshot = (await rpc.read({ missionID: created.id }, options)).snapshot
   const playInput = { missionID: created.id, requestID: "private_play", expectedRevision: snapshot.missions[0].revision }
   await assert.rejects(rpc.play({ ...playInput, loseAdmissionACK: true }, options))
   const lostAdmission = (await rpc.read({ missionID: created.id }, options)).document
   assert.equal(lostAdmission.oneTime.firstPlay.admittedAt, null)
   const originalFrozen = lostAdmission.oneTime.firstPlay.inputText
   await client.session.prompt({ sessionID: followed.id, text: "New source text after lost first-Play ACK" })
   await client.session.wait({ sessionID: followed.id }, { signal: AbortSignal.timeout(30000) })
   const played = (await rpc.play(playInput, options)).mission
   const playedCoordinator = immediate.oneTime.coordinatorSessionID
   assert.equal(played.document.launchedCount, 1); assert.equal(played.coordinatorSessionId, playedCoordinator)
   const frozen = (await rpc.read({ missionID: created.id }, options)).document.oneTime.firstPlay.inputText
   assert.equal(frozen, originalFrozen); assert.doesNotMatch(frozen, /New source text after/)
   assert.match(frozen, /Frozen private followed context at Play/)
   assert.match(frozen, /untrusted source data/)
   await rpc.play({ missionID: created.id, requestID: "private_play", expectedRevision: snapshot.missions[0].revision }, options)
   const admission = await client.session.inbox.list({ sessionID: playedCoordinator })
   const context = await client.session.context({ sessionID: playedCoordinator })
  assert.ok(admission.some(item => item.id === played.document.firstPlay.messageID)
    || context.some(item => item.id === played.document.firstPlay.messageID), "Play admits the original new-coordinator input")
   const originalInput = [...admission, ...context].find(item => item.id === played.document.firstPlay.messageID)
   assert.equal(originalInput.text ?? originalInput.payload?.text, frozen)
   assert.equal((await client.session.get({ sessionID: playedCoordinator })).agent, "preparation_coordinator")
   assert.deepEqual((await client.session.get({ sessionID: playedCoordinator })).model, configuration.profiles.coordinator.model)
  assert.equal((await client.session.context({ sessionID: binding.coordinatorSessionID })).length, 0, "the original remains empty")
   await writeFile(path.join(root, "preparation-receipt.json"), JSON.stringify({ version: info.version, created, original, partial, edited, scheduled, immediate, lostAdmission, played, frozen, admission, context }, null, 2))
   console.log("PASS: private native preparation, conversion with followed context, lost creation/admission ACK, frozen exact replay, and Play with new profiles")
})
