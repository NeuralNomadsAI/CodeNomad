import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { NativeMissionAuthority, type AuthorityEffectAdapter } from "../authority-core"
import { authorityDigest, authorityIntentSchema, matchesAuthorityCompletion, matchesObservedLifecycle, type SignedAuthorityIntent } from "../authority-protocol"
import { MissionJournal } from "../journal"
import { CODENOMAD_MISSIONS_RPC } from "../rpc"
import { controlOperationID, controlReceiptID } from "../receipt-identity"
import { projectLifecycle } from "../lifecycle-model"
import type { MissionEvent } from "../model"
import { authorityReceiptReadSchema } from "../authority-receipt"
import { fixture, existingRootExecution } from "./test-fixture"

type Fixture = Awaited<ReturnType<typeof fixture>>
const snapshot = (f: Fixture) => new MissionJournal(f.storage, "test-project", f.project).snapshot()

async function setup(t: { after(callback: () => void | Promise<void>): void }) {
  const f = await fixture(); t.after(f.cleanup)
  let core: NativeMissionAuthority | undefined, stop: SignedAuthorityIntent | undefined, effects = 0
  const execute = NativeMissionAuthority.prototype.execute
  NativeMissionAuthority.prototype.execute = function(signed, adapter: AuthorityEffectAdapter, signal) {
    core = this
    const body = (signed as SignedAuthorityIntent).body
    if (body.method === "lifecycle" && body.payload.action === "stop") stop = structuredClone(signed as SignedAuthorityIntent)
    return execute.call(this, signed, { ...adapter, apply: async (...args) => { effects++; return adapter.apply(...args) } }, signal)
  }
  t.after(() => { NativeMissionAuthority.prototype.execute = execute })
  await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" }, "original-play")
  return { f, core: () => core!, stop: () => stop!, effects: () => effects }
}

test("bounded ACK revision floor comes from actual final target receipt and survives later journal events", () => {
  const intent = authorityIntentSchema.parse({ version: 1, policy: "codenomad.missions.authority/signed-v1", namespace: "00000000-0000-4000-8000-000000000000",
    authorityID: "authority", keyID: "key", profileID: "profile", executionHost: "host", projectID: "project", projectCanonical: "/owned",
    roots: [{ mode: "directory-only", directory: "/owned" }], missionID: "msn_owned", coordinatorSessionID: "ses_coordinator",
    requestID: "original-stop", expectedRevision: 1, epoch: 1, method: "lifecycle", payload: { action: "stop" } })
  const base = { version: 1 as const, missionID: intent.missionID, projectID: intent.projectID, createdAt: 1 }
  const operation = { ...base, id: controlOperationID(intent.missionID, intent.requestID), type: "mission.control-requested" as const,
    requestID: intent.requestID, expectedRevision: 1, action: "stop" as const,
    targets: ["ses_coordinator", "ses_actor"].map(sessionID => ({ sessionID, location: { directory: "/owned" } })) }
  const update = (id: string): MissionEvent => ({ ...base, id, type: "mission.updated", requestID: id, expectedRevision: 1, notesSpecified: false, objective: "Private event" })
  const ack = (sessionID: string): MissionEvent => ({ ...base, id: controlReceiptID(operation.id, sessionID), type: "mission.control-applied", operationID: operation.id, sessionID })
  const events = [update("evt_before"), operation, ack("ses_coordinator"), update("evt_interleaved"), ack("ses_actor"), update("evt_later")]
  const observation = { ...projectLifecycle(events), revision: events.length }
  assert.equal(observation.control!.completedRevision, 5)
  assert.equal(matchesObservedLifecycle(intent, { missionID: intent.missionID, operationID: operation.id, revision: 5 }, observation), true)
  assert.equal(matchesObservedLifecycle(intent, { missionID: intent.missionID, operationID: operation.id, revision: 6 }, observation), true)
  for (const revision of [1, 4, 7]) assert.equal(matchesObservedLifecycle(intent, { missionID: intent.missionID, operationID: operation.id, revision }, observation), false)
  assert.equal(projectLifecycle(events.filter(event => event.id !== controlReceiptID(operation.id, "ses_actor"))).control!.completedRevision, undefined)
})

test("wire receipt parser shares applied lifecycle operation and revision semantics without requiring IDs on metadata methods", () => {
  const base = { version: 1, policy: "codenomad.missions.authority/signed-v1", namespace: "00000000-0000-4000-8000-000000000000",
    authorityID: "authority", keyID: "key", profileID: "profile", executionHost: "host", projectID: "project", projectCanonical: "/owned",
    roots: [{ mode: "directory-only", directory: "/owned" }], missionID: "msn_owned", coordinatorSessionID: "ses_coordinator",
    requestID: "original-stop", expectedRevision: 1, epoch: 1 }
  const intent = authorityIntentSchema.parse({ ...base, method: "lifecycle", payload: { action: "stop" } })
  const result = { missionID: intent.missionID, revision: 3, operationID: controlOperationID(intent.missionID, intent.requestID) }
  const wire = (completion: unknown) => ({ namespace: intent.namespace, projectID: intent.projectID, projectCanonical: intent.projectCanonical,
    receipt: { requestID: intent.requestID, digest: authorityDigest(intent), signerDigest: "0".repeat(64), provisioningGeneration: "generation", intent, completion } })
  assert.equal(authorityReceiptReadSchema.safeParse(wire({ outcome: "applied", result })).success, true)
  for (const bad of [{ ...result, operationID: "evt_prior_play" }, { missionID: result.missionID, revision: 3 },
    { missionID: result.missionID, operationID: result.operationID }, { ...result, revision: 1 }, { metadataOnly: true }]) {
    assert.equal(authorityReceiptReadSchema.safeParse(wire({ outcome: "applied", result: bad })).success, false)
  }
  for (const method of ["adopt", "revoke"] as const) {
    const metadataIntent = authorityIntentSchema.parse({ ...base, method, payload: {} })
    assert.equal(matchesAuthorityCompletion(metadataIntent, { outcome: "applied", result: { metadataOnly: true } }), true)
  }
})

function loseStopAck(f: Fixture) {
  const rpc = f.client.rpc.bind(f.client)
  f.client.rpc = (definition: { id: string }) => {
    const original = rpc(definition)
    return definition.id !== "codenomad.missions.authority" ? original : new Proxy(original, { get: (target, method) =>
      method !== "intent" ? target[method] : async (signed: SignedAuthorityIntent, options: unknown) => {
        const result = await target.intent(signed, options)
        if (signed.body.requestID === "original-stop") throw new Error("isolated lost Stop ACK")
        return result
      } })
  }
}

for (const damage of ["prior-play", "missing-operation", "old-revision", "correct-operation-pending", "wrong-action", "wrong-request"] as const) {
  test(`canonical signed Stop ${damage} completion cannot hide uncertainty, rewrite bytes or clear protected pending`, async t => {
    const s = await setup(t), { f } = s
    const completed = damage === "wrong-action" || damage === "wrong-request"
    if (completed) loseStopAck(f)
    else f.failStop()
    await assert.rejects(f.action("lifecycle", { action: "stop" }, "original-stop"))
    const doc = await f.nativeStore.read(), stop = doc.receipts.find(item => item.requestID === "original-stop")!
    const play = doc.receipts.find(item => item.requestID === "original-play")!
    const key = [...f.storage.data.keys()].find(key => key.startsWith("codenomad-missions/authority-v2/project/"))!
    const raw = structuredClone(f.storage.data.get(key)) as any
    const mission = (await snapshot(f)).missions[0]
    let result: any = { missionID: stop.intent.missionID, revision: mission.revision, operationID: controlOperationID(stop.intent.missionID, stop.requestID) }
    if (damage === "prior-play") result = structuredClone(play.completion!.result)
    if (damage === "missing-operation") delete result.operationID
    if (damage === "old-revision") result.revision = (play.completion!.result as any).revision
    raw.receipts.find((item: any) => item.requestID === stop.requestID).completion = { outcome: "applied", result }
    f.storage.data.set(key, raw)
    if (completed) {
      const journalEntry = [...f.storage.data].find(([, value]) => (value as any).id === mission.control!.id)!
      const changed = structuredClone(journalEntry[1]) as any
      if (damage === "wrong-action") changed.action = "pause"
      else changed.requestID = "unrelated-original-request"
      f.storage.data.set(journalEntry[0], changed)
    }
    const bytes = JSON.stringify([...f.storage.data]), protectedBytes = await readFile(f.recordFile), host = (await f.authority.read())!
    const effects = s.effects(), counts = { ...f.counts }, writes = f.storage.writes
    for (const read of [() => s.core().state(stop.intent.missionID), () => s.core().readReceipt({ intent: stop.intent, digest: stop.digest }),
      () => s.core().execute(s.stop(), { apply: async () => assert.fail("corrupt completion replayed") }, f.signal),
      () => f.native.read(stop.intent), () => f.authority.accept(f.request, host.pendingDigest!, host.revision)]) await assert.rejects(read())
    assert.equal((await f.authority.read())!.pendingDigest, host.pendingDigest)
    assert.equal((await f.authority.read())!.revision, host.revision)
    assert.deepEqual(await readFile(f.recordFile), protectedBytes)
    assert.equal(JSON.stringify([...f.storage.data]), bytes)
    assert.equal(f.storage.writes, writes); assert.equal(s.effects(), effects)
    for (const name of ["interrupts", "prompts", "synthetics", "environments", "creates"] as const) assert.equal(f.counts[name], counts[name])
    assert.equal(raw.grants[0].state, "revoked"); assert.equal(raw.grants[0].sendsEnabled, false)
    assert.equal(raw.terminals[0].state, "stopped"); await f.deps.familyClaims[0].claim.assertCurrent()
    if (!completed) {
      const control = (await snapshot(f)).missions[0].control!
      assert.equal(control.id, controlOperationID(stop.intent.missionID, stop.requestID)); assert.equal(control.requestID, "original-stop")
      assert.deepEqual(control.pending, ["ses_test_coordinator"])
    }
    assert.equal(authorityDigest(stop.intent), stop.digest)
  })
}

test("honest failed Stop stays uncertain and exact retry never replays native interruption", async t => {
  const s = await setup(t), { f } = s; f.failStop()
  await assert.rejects(f.action("lifecycle", { action: "stop" }, "original-stop"))
  const signed = s.stop(), host = (await f.authority.read())!, counts = { ...f.counts }
  assert.deepEqual((await s.core().state(signed.body.missionID)).pendingRequestIDs, ["original-stop"])
  assert.equal((await s.core().execute(signed, { apply: async () => assert.fail("pending Stop replayed") }, f.signal)).receipt.completion, undefined)
  await assert.rejects(f.authority.accept(f.request, host.pendingDigest!, host.revision))
  assert.equal((await f.authority.read())!.pendingDigest, host.pendingDigest)
  assert.equal(f.counts.interrupts, counts.interrupts)
})

test("canonical partial Stop retains its original protected reservation after one genuine target ACK and one failure", async t => {
  const s = await setup(t), { f } = s
  const missionID = (await snapshot(f)).missions[0].id
  await f.runTool("delegate", { missionID, taskKey: "worker", title: "Worker", brief: "Private work", role: "worker",
    blockedBy: [], targetSessionID: "ses_test_actor", delivery: "queue", ...existingRootExecution() })
  const interrupt = f.client.session.interrupt
  f.client.session.interrupt = async (input: { sessionID: string }) => {
    if (input.sessionID === "ses_test_actor") { f.counts.interrupts++; throw new Error("isolated actor interrupt failure") }
    return interrupt(input)
  }
  await assert.rejects(f.action("lifecycle", { action: "stop" }, "original-stop"))
  const operation = (await snapshot(f)).missions[0].control!, signed = s.stop(), host = (await f.authority.read())!
  assert.deepEqual(operation.pending, ["ses_test_actor"]); assert.equal(operation.completedRevision, undefined)
  const observation = await f.native.read(signed.body)
  assert.equal(observation.operation.receipt.completion, undefined)
  assert.deepEqual(observation.pendingRequestIDs, ["original-stop"])
  const counts = { ...f.counts }, effects = s.effects(), bytes = await readFile(f.recordFile)
  await assert.rejects(f.authority.accept(f.request, host.pendingDigest!, host.revision))
  assert.equal((await f.authority.read())!.pendingDigest, host.pendingDigest)
  assert.equal((await s.core().execute(signed, { apply: async () => assert.fail("partial Stop replayed") }, f.signal)).receipt.completion, undefined)
  assert.deepEqual(await readFile(f.recordFile), bytes); assert.equal(s.effects(), effects)
  for (const name of ["interrupts", "prompts", "synthetics", "environments", "creates"] as const) assert.equal(f.counts[name], counts[name])
})

test("completed Stop with lost ACK accepts after a real late report advances the map revision, then permits map-only Delete", async t => {
  const s = await setup(t), { f } = s
  await f.runTool("delegate", { missionID: (await snapshot(f)).missions[0].id, taskKey: "worker", title: "Worker",
    brief: "Private task", role: "worker", blockedBy: [], targetSessionID: "ses_test_actor", delivery: "queue", ...existingRootExecution() })
  loseStopAck(f)
  await assert.rejects(f.action("lifecycle", { action: "stop" }, "original-stop"))
  const stop = (await f.nativeStore.read()).receipts.find(item => item.requestID === "original-stop")!, result = stop.completion!.result as any
  const before = (await snapshot(f)).missions[0], effects = s.effects(), counts = { ...f.counts }
  assert.deepEqual(before.control!.pending, [])
  await f.runTool("report", { missionID: before.id, taskKey: "worker", outcome: "completed", summary: "Late private result", evidence: [], next: [], final: false }, "ses_test_actor")
  const after = (await snapshot(f)).missions[0]
  assert(after.revision > result.revision); assert.equal(after.status, "stopped")
  const observed = await f.native.read(stop.intent)
  assert.equal(observed.revision, after.revision)
  const host = (await f.authority.read())!
  assert.equal((await f.authority.accept(f.request, host.pendingDigest!, host.revision)).pendingDigest, null)
  assert.equal(s.effects(), effects)
  for (const name of ["interrupts", "prompts", "synthetics", "environments", "creates"] as const) assert.equal(f.counts[name], counts[name])
  await f.action("delete", { deleteManagedSessions: false }, "settled-map-delete")
  assert.equal((await snapshot(f)).missions.length, 0)
})

for (const perturbation of ["missing-control", "unstable-control-vector"] as const) {
  test(`canonical reader rejects ${perturbation} even when receipt/state/live revision remain unchanged`, async t => {
    const s = await setup(t), { f } = s; loseStopAck(f)
    await assert.rejects(f.action("lifecycle", { action: "stop" }, "original-stop"))
    const stop = (await f.nativeStore.read()).receipts.find(item => item.requestID === "original-stop")!
    const rpc = f.client.rpc.bind(f.client); let snapshots = 0
    f.client.rpc = (definition: { id: string }) => {
      const original = rpc(definition)
      if (definition.id !== CODENOMAD_MISSIONS_RPC.id) return original
      return new Proxy(original, { get: (target, method) => method !== "snapshot" ? target[method] : async (...args: unknown[]) => {
        const result = structuredClone(await target.snapshot(...args)); snapshots++
        if (perturbation === "missing-control") delete result.missions[0].control
        else if (snapshots % 2 === 0) result.missions[0].control.pending = ["ses_test_coordinator"]
        return result
      } })
    }
    const host = (await f.authority.read())!, bytes = await readFile(f.recordFile), data = JSON.stringify([...f.storage.data]), effects = s.effects(), interrupts = f.counts.interrupts
    await assert.rejects(f.native.read(stop.intent))
    await assert.rejects(f.authority.accept(f.request, host.pendingDigest!, host.revision))
    assert.deepEqual(await readFile(f.recordFile), bytes); assert.equal(JSON.stringify([...f.storage.data]), data)
    assert.equal(s.effects(), effects); assert.equal(f.counts.interrupts, interrupts)
  })
}
