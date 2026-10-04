import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { MissionJournal } from "../journal"
import { createCanonicalDurableMissionsHost } from "./factory"
import { fixture, syntheticAcknowledgement } from "./test-fixture"
import { controlResumeAdmissionID } from "../receipt-identity"
import { FamilyAuthorityStore } from "../../workspaces/family-authority-claim"
import { structuralTestPolicy } from "../host-authority/test-fixture"
import path from "node:path"

test("real file/core/plugin/route composition creates prepared mission, adopts then separately plays existing coordinator", async t => {
  const f = await fixture(); t.after(f.cleanup)
  const created = await f.create()
  assert.equal(created.epoch, 0); assert.equal(created.mirror, null)
  assert.equal(f.counts.synthetics, 0); assert.equal(f.counts.creates, 0)
  const journal = new MissionJournal(f.storage, "test-project", f.project)
  assert.equal((await journal.snapshot()).missions[0].runState, "prepared")
  const adopted = await f.action("adopt", {})
  assert.equal(adopted.epoch, 1); assert.equal(adopted.mirror!.sendsEnabled, false)
  assert.equal(f.counts.synthetics, 0)
  const running = await f.action("lifecycle", { action: "start" })
  assert.equal(running.mirror!.sendsEnabled, true)
  assert.equal(f.counts.environments, 1); assert.equal(f.counts.synthetics, 1)
  assert.equal(f.sessions.get("ses_test_coordinator")!.agent, "build")
  assert.equal(f.sessions.get("ses_test_coordinator")!.location.directory, f.project)
  assert(f.counts.receipts >= 12, "exact readonly native receipt rereads, not response-cache completion")
  const operation = (await journal.snapshot()).missions[0].control!
  const receipt = operation.receipts![0]
  assert.equal(receipt.acknowledgementState, "known")
  const ack = receipt.nativeAcknowledgement!
  assert.equal(ack.disposition, "start-admitted")
  if (ack.disposition !== "start-admitted") assert.fail("Play must retain native admission")
  assert.equal(ack.admission.id, controlResumeAdmissionID(operation.id, "ses_test_coordinator"))
  assert.equal(ack.admission.sessionID, "ses_test_coordinator")
  assert.equal(ack.admission.delivery, "queue")
  assert.deepEqual(ack.admission.payload.metadata, { "codenomad.mission": {
    version: 1, missionID: operation.missionID, kind: "lifecycle", operationID: operation.id,
  } })
  await f.authority.assertHostGrant(running.mirror!)
})

test("fake synthetic ACK copies only public received fields and never fills missing correlation", () => {
  const input = { sessionID: "ses_fixture", id: "msg_fixture", text: "Received text", description: "Received description",
    delivery: "queue" as const, metadata: { source: { exact: true } } }
  const ack = syntheticAcknowledgement(input)
  assert.deepEqual(ack, { id: input.id, sessionID: input.sessionID, time: { created: 100 }, type: "synthetic", delivery: "queue",
    payload: { text: input.text, description: input.description, metadata: input.metadata } })
  input.metadata.source.exact = false
  assert.deepEqual(ack.payload.metadata, { source: { exact: true } })
  assert.deepEqual(syntheticAcknowledgement({ sessionID: input.sessionID, id: input.id, text: input.text, delivery: "queue" }).payload, { text: input.text })
  assert.throws(() => syntheticAcknowledgement({ sessionID: input.sessionID, text: input.text, delivery: "queue" }), /explicit synthetic ID/)
})

test("canonical Stop persists exact interrupted:false without inventing native work suspension", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const interrupt = f.client.session.interrupt
  f.client.session.interrupt = async (...args: unknown[]) => { await interrupt(...args); return { interrupted: false } }
  await f.action("lifecycle", { action: "stop" })
  const operation = (await new MissionJournal(f.storage, "test-project", f.project).snapshot()).missions[0].control!
  assert.deepEqual(operation.pending, [])
  const ack = operation.receipts![0].nativeAcknowledgement!
  assert.equal(ack.disposition, "interrupt-observed")
  if (ack.disposition !== "interrupt-observed") assert.fail("Stop must retain interrupt observation")
  assert.deepEqual(ack.interrupt, { interrupted: false }); assert.deepEqual(ack.cancellations, [])
  assert.equal(f.counts.interrupts, 1); assert.equal(f.counts.synthetics, 0); assert.equal(f.counts.environments, 0)
})

test("native-host factory unavailable/async proof cannot return a usable host or expose routes", async t => {
  const f = await fixture(); t.after(f.cleanup)
  await assert.rejects(createCanonicalDurableMissionsHost({ ...f.deps, nativeHost: { async open() { throw new Error("real RuntimeSession unavailable") } } }), /trust-unavailable/)
  await assert.rejects(createCanonicalDurableMissionsHost({ ...f.deps, nativeHost: { async open() { return { ...f.channel, assertCurrent: (() => Promise.resolve(true)) as never } } } }), /policy-unqualified/)
  assert.equal(f.counts.creates, 0); assert.equal(f.counts.synthetics, 0)
})

test("signer generation changes during canonical environment preparation prevent environment and Play effect", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  f.setEnvironmentPreparation(() => f.changeGeneration())
  await assert.rejects(f.action("lifecycle", { action: "start" }))
  assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
  const state = await f.nativeStore.read()
  assert(state.receipts.some(receipt => receipt.intent.method === "lifecycle" && !receipt.completion))
  assert.equal(state.grants[0].sendsEnabled, false)
})

test("native proof/family capability loss after canonical environment write prevents synthetic effect", async t => {
  for (const fault of ["proof", "family"] as const) {
    const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
    f.setEnvironmentWrite(async () => { if (fault === "proof") f.loseNative(); else f.loseClaim() })
    await assert.rejects(f.action("lifecycle", { action: "start" }))
    assert.equal(f.counts.environments, 1); assert.equal(f.counts.synthetics, 0)
    assert.equal((await f.nativeStore.read()).grants[0].sendsEnabled, false)
  }
})

test("failed Stop stays host/native denied with honest pending receipt and no automatic effect replay", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  const active = (await f.authority.read())!.mirror!
  f.failStop()
  await assert.rejects(f.action("lifecycle", { action: "stop" }))
  const host = (await f.authority.read())!
  assert(host.pendingDigest); assert.equal(host.mirror!.state, "revoked"); assert.equal(host.mirror!.sendsEnabled, false)
  assert.throws(() => f.authority.assertHostGrantCurrent(active))
  const native = await f.nativeStore.read()
  assert.equal(native.grants[0].state, "revoked"); assert.equal(native.grants[0].sendsEnabled, false)
  assert(native.receipts.some(receipt => receipt.intent.method === "lifecycle" && receipt.intent.payload.action === "stop" && !receipt.completion))
  assert.equal(f.counts.interrupts, 1)
  await f.authority.read(); await f.authority.read()
  assert.equal(f.counts.interrupts, 1)
})

test("readonly native receipt substitution after waiting never clears protected reservation", async t => {
  const f = await fixture(); t.after(f.cleanup)
  let reads = 0
  f.setReceiptRead(receipt => { if (++reads === 2 && receipt) receipt.digest = "0".repeat(64) })
  await assert.rejects(f.create())
  const host = (await f.authority.read())!
  assert(host.pendingDigest); assert.equal(host.mirror, null)
})

test("normalized actions cannot submit browser grant/key/root/epoch/driver or managed deletion", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  const state = (await f.authority.read())!, before = await readFile(f.recordFile, "utf8")
  for (const extra of [{ epoch: 999 }, { roots: [] }, { grant: state.mirror }, { privateKey: "bad" }, { kind: "prompt" }]) {
    await assert.rejects(f.actions.execute(f.request, { requestID: "untrusted", method: "update", payload: { objective: "changed" },
      expectedRevision: 1, expectedHostRevision: state.revision, ...extra }, f.signal))
  }
  await assert.rejects(f.actions.execute(f.request, { requestID: "delete", method: "delete", payload: { deleteManagedSessions: true },
    expectedRevision: 1, expectedHostRevision: state.revision }, f.signal))
  assert.equal(await readFile(f.recordFile, "utf8"), before)
})

test("unowned physical roots and missing WSL host mapping fail closed before any key/native write", async t => {
  const f = await fixture(); t.after(f.cleanup)
  await assert.rejects(f.roots.resolve({ directory: `${f.project}/foreign` }))
  f.manager.getHostPathForServicePath = async () => undefined
  await assert.rejects(f.create())
  assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
})

test("completed Stop retains exact map ownership; only an accepted Delete releases the held family claim", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  const contender = new FamilyAuthorityStore({ root: path.join(f.root, "families"), profileKey: "another-profile", executionHostKey: "another-host",
    policy: structuralTestPolicy, lookup: async () => ({ state: "live", startIdentity: "test-second-owner" }) })
  await assert.rejects(contender.acquire(f.deps.familyClaims[0].family), /family-owner-conflict/)
  const stopped = await f.action("lifecycle", { action: "stop" })
  assert.equal(stopped.pendingDigest, null); assert.equal(stopped.mirror!.state, "revoked")
  assert.equal(f.counts.interrupts, 1)
  await f.deps.familyClaims[0].claim.assertCurrent()
  await assert.rejects(contender.acquire(f.deps.familyClaims[0].family), /family-owner-conflict/)
  await f.action("delete", { deleteManagedSessions: false })
  assert.equal(f.counts.interrupts, 1)
  await assert.rejects(f.deps.familyClaims[0].claim.assertCurrent(), /family-claim-lost/)
  const explicitNewOwner = await contender.acquire(f.deps.familyClaims[0].family)
  await explicitNewOwner.assertCurrent(); await explicitNewOwner.release()
})

test("human cookie loss after native signing preparation cannot publish a signature or invoke effects", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  const before = await readFile(f.recordFile, "utf8")
  f.afterHandshake(() => { f.request.headers.cookie = "unrelated-session" })
  await assert.rejects(f.action("lifecycle", { action: "start" }))
  assert.equal(await readFile(f.recordFile, "utf8"), before)
  assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
})
