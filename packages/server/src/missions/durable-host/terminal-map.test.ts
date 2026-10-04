import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { MissionJournal } from "../journal"
import { fixture } from "./test-fixture"
import { FamilyAuthorityStore } from "../../workspaces/family-authority-claim"
import { structuralTestPolicy } from "../host-authority/test-fixture"

type Fixture = Awaited<ReturnType<typeof fixture>>
const snapshot = (f: Fixture) => new MissionJournal(f.storage, "test-project", f.project).snapshot()
const contender = (f: Fixture) => new FamilyAuthorityStore({ root: path.join(f.root, "families"),
  profileKey: "another-profile", executionHostKey: "another-host", policy: structuralTestPolicy,
  lookup: async () => ({ state: "live", startIdentity: "isolated-contender" }) })
async function execute(f: Fixture, method: "delete" | "lifecycle", requestID: string, expectedRevision: number, payload: unknown) {
  return f.actions.execute(f.request, { method, requestID, expectedRevision,
    expectedHostRevision: (await f.authority.read())!.revision, payload }, f.signal)
}
function loseOneAck(f: Fixture, requestID: string) {
  const rpc = f.client.rpc.bind(f.client)
  let lost = false
  f.client.rpc = (definition: { id: string }) => {
    const original = rpc(definition)
    if (definition.id !== "codenomad.missions.authority") return original
    return new Proxy(original, { get: (target, method) => method !== "intent" ? target[method] : async (signed: any, options: any) => {
      const result = await target.intent(signed, options)
      if (!lost && signed.body.requestID === requestID) { lost = true; throw new Error("isolated lost native ACK") }
      return result
    } })
  }
}

for (const mode of ["grantless prepared", "adopted running"] as const) {
  test(`${mode} Stop permits current-revision map-only Delete without sends or session deletion`, async t => {
    const f = await fixture(); t.after(f.cleanup); await f.create()
    if (mode === "adopted running") { await f.action("adopt", {}); await f.action("lifecycle", { action: "start" }) }
    const stopped = await f.action("lifecycle", { action: "stop" }, "stop-then-delete")
    assert.equal(stopped.pendingDigest, null)
    assert.equal(stopped.mirror?.sendsEnabled ?? false, false)
    const before = { writes: f.storage.writes, counts: { ...f.counts }, revision: stopped.revision }
    const deleted = await f.action("delete", { deleteManagedSessions: false }, "delete-stopped-map")
    assert.equal(deleted.pendingDigest, null); assert.equal(deleted.revision, before.revision + 2)
    assert.equal(deleted.mirror?.sendsEnabled ?? false, false)
    assert.equal(f.storage.writes, before.writes + 3); assert.equal(f.counts.receipts, before.counts.receipts + 4)
    assert.deepEqual({ ...f.counts, receipts: before.counts.receipts }, before.counts)
    assert.equal((await snapshot(f)).missions.length, 0)
    assert.equal((await f.nativeStore.read()).terminals[0].state, "deleted")
    assert.equal(f.sessions.size, 2, "map-only Delete never removes native conversations")
    await assert.rejects(f.deps.familyClaims[0].claim.assertCurrent(), /family-claim-lost/)
  })
}

test("retained stopped-map ownership blocks another profile; only accepted Delete releases the exact reference", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const other = contender(f), held = f.deps.familyClaims[0]
  await f.action("lifecycle", { action: "stop" })
  await held.claim.assertCurrent()
  await assert.rejects(other.acquire(held.family), /family-owner-conflict/)
  const before = await readFile(f.recordFile, "utf8"), counts = { ...f.counts }, writes = f.storage.writes
  await assert.rejects(f.action("lifecycle", { action: "start" }))
  assert.equal(await readFile(f.recordFile, "utf8"), before)
  assert.deepEqual(f.counts, counts); assert.equal(f.storage.writes, writes)
  await f.action("delete", { deleteManagedSessions: false })
  const next = await other.acquire(held.family)
  await next.assertCurrent()
  await assert.rejects(held.claim.assertCurrent(), /family-claim-lost/, "old capability cannot borrow the new owner")
  await next.release()
})

test("Stop and map Delete never release another explicitly held shared-family reference", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const held = f.deps.familyClaims[0], other = contender(f)
  const sibling = await f.familyStore.acquire(held.family) // explicit reference, not auto-acquisition
  t.after(() => sibling.release())
  await f.action("lifecycle", { action: "stop" })
  await held.claim.assertCurrent(); await sibling.assertCurrent()
  await assert.rejects(other.acquire(held.family), /family-owner-conflict/)
  await f.action("delete", { deleteManagedSessions: false })
  await assert.rejects(held.claim.assertCurrent(), /family-claim-lost/)
  await sibling.assertCurrent()
  await assert.rejects(other.acquire(held.family), /family-owner-conflict/)
  await sibling.release()
  const next = await other.acquire(held.family)
  await next.assertCurrent(); await next.release()
})

test("successful Stop exact terminal retry returns the original receipt without another interruption", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const revision = (await snapshot(f)).missions[0].revision
  await execute(f, "lifecycle", "exact-stop", revision, { action: "stop" })
  const native = await f.nativeStore.read(), counts = { ...f.counts }
  const retried = await execute(f, "lifecycle", "exact-stop", revision, { action: "stop" })
  assert.equal(retried.pendingDigest, null)
  assert.deepEqual(await f.nativeStore.read(), native)
  assert.deepEqual({ ...f.counts, receipts: counts.receipts }, counts)
  await f.deps.familyClaims[0].claim.assertCurrent()
  await f.action("delete", { deleteManagedSessions: false })
  assert.equal(f.counts.interrupts, 1)
})

test("failed Stop and pending terminal retries never replay controls, release claims or conceal unresolved native work", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); f.failStop()
  const revision = (await snapshot(f)).missions[0].revision
  await assert.rejects(execute(f, "lifecycle", "failed-stop", revision, { action: "stop" }))
  await f.deps.familyClaims[0].claim.assertCurrent()
  const pending = await f.nativeStore.read()
  await assert.rejects(execute(f, "lifecycle", "failed-stop", revision, { action: "stop" }))
  assert.deepEqual(await f.nativeStore.read(), pending)
  assert.equal(f.counts.interrupts, 1, "pending native controls are never replayed")
  await assert.rejects(f.action("delete", { deleteManagedSessions: false }, "delete-with-pending-controls"))
  const native = await f.nativeStore.read()
  assert(native.receipts.some(item => item.requestID === "failed-stop" && !item.completion))
  assert(native.receipts.some(item => item.requestID === "delete-with-pending-controls" && !item.completion))
  assert.equal((await snapshot(f)).missions[0].control!.pending.length, 1)
  assert((await f.authority.read())!.pendingDigest)
  await f.deps.familyClaims[0].claim.assertCurrent()
  await assert.rejects(contender(f).acquire(f.deps.familyClaims[0].family), /family-owner-conflict/)
  assert.equal(native.terminals[0].state, "deleted")
  assert.equal(f.counts.interrupts, 1); assert.equal(f.sessions.size, 2)
})

test("terminal map Delete keeps original human cancellation, revision and cookie fences before protected writes", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("lifecycle", { action: "stop" })
  const host = (await f.authority.read())!, before = await readFile(f.recordFile, "utf8")
  const native = await f.nativeStore.read(), writes = f.storage.writes, counts = { ...f.counts }
  const action = { method: "delete", requestID: "guarded-delete", expectedRevision: (await snapshot(f)).missions[0].revision,
    expectedHostRevision: host.revision, payload: { deleteManagedSessions: false } }
  const cancel = new AbortController(); cancel.abort()
  await assert.rejects(f.actions.execute(f.request, action, cancel.signal), { name: "AbortError" })
  await assert.rejects(f.actions.execute(f.request, { ...action, expectedHostRevision: host.revision + 1 }, f.signal), /revision-conflict/)
  f.expireHumanSession()
  await assert.rejects(f.actions.execute(f.request, action, f.signal), /authorization-blocked/)
  assert.equal(await readFile(f.recordFile, "utf8"), before)
  assert.deepEqual(await f.nativeStore.read(), native); assert.equal(f.storage.writes, writes)
  assert.deepEqual(f.counts, counts)
  await f.deps.familyClaims[0].claim.assertCurrent()
})

test("cookie invalidation during Delete receipt settlement cannot release terminal-map ownership", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("lifecycle", { action: "stop" })
  f.setReceiptRead(async () => f.expireHumanSession())
  await assert.rejects(f.action("delete", { deleteManagedSessions: false }, "expired-delete-settlement"))
  assert((await f.authority.read())!.pendingDigest)
  await f.deps.familyClaims[0].claim.assertCurrent()
  await assert.rejects(contender(f).acquire(f.deps.familyClaims[0].family), /family-owner-conflict/)
  assert.equal((await snapshot(f)).missions.length, 0, "already-published native deletion is not rolled back")
  assert.equal(f.counts.interrupts, 1); assert.equal(f.sessions.size, 2)
})

test("claim-release preparation preserves the originating human fence after accepted Delete and permits only explicit receipt retry", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("lifecycle", { action: "stop" })
  const revision = (await snapshot(f)).missions[0].revision, held = f.deps.familyClaims[0]
  const current = held.claim.assertCurrent.bind(held.claim)
  let invalidated = false
  held.claim.assertCurrent = async () => {
    await current() // real protected marker check, never an approval substitute
    if (!invalidated && (await f.authority.read())!.pendingDigest === null
      && (await f.nativeStore.read()).terminals[0]?.state === "deleted") {
      invalidated = true; f.expireHumanSession()
    }
  }
  await assert.rejects(execute(f, "delete", "delete-release-cookie", revision, { deleteManagedSessions: false }), /authorization-blocked/)
  assert(invalidated)
  assert.equal((await f.authority.read())!.pendingDigest, null, "accepted native deletion is not rolled back")
  await current()
  await assert.rejects(contender(f).acquire(held.family), /family-owner-conflict/)
  const native = await f.nativeStore.read(), counts = { ...f.counts }
  const session = f.deps.auth.createSession("human")
  f.request.headers.cookie = `${f.deps.auth.getCookieName()}=${session.id}`
  await execute(f, "delete", "delete-release-cookie", revision, { deleteManagedSessions: false })
  assert.deepEqual(await f.nativeStore.read(), native)
  assert.deepEqual({ ...f.counts, receipts: counts.receipts }, counts)
  await assert.rejects(current(), /family-claim-lost/)
})

for (const method of ["lifecycle", "delete"] as const) {
  test(`lost ${method === "lifecycle" ? "Stop" : "Delete"} ACK retains claim until explicit exact receipt settlement`, async t => {
    const f = await fixture(); t.after(f.cleanup); await f.create()
    if (method === "delete") await f.action("lifecycle", { action: "stop" })
    const revision = (await snapshot(f)).missions[0].revision
    const payload = method === "lifecycle" ? { action: "stop" } : { deleteManagedSessions: false }
    loseOneAck(f, "lost-terminal-ack")
    await assert.rejects(execute(f, method, "lost-terminal-ack", revision, payload), /isolated lost native ACK/)
    assert((await f.authority.read())!.pendingDigest)
    await f.deps.familyClaims[0].claim.assertCurrent()
    const native = await f.nativeStore.read(), counts = { ...f.counts }
    assert(native.receipts.find(item => item.requestID === "lost-terminal-ack")?.completion)
    const settled = await execute(f, method, "lost-terminal-ack", revision, payload)
    assert.equal(settled.pendingDigest, null)
    assert.deepEqual(await f.nativeStore.read(), native)
    assert.deepEqual({ ...f.counts, receipts: counts.receipts }, counts)
    if (method === "lifecycle") {
      await f.deps.familyClaims[0].claim.assertCurrent()
      await f.action("delete", { deleteManagedSessions: false })
    }
    await assert.rejects(f.deps.familyClaims[0].claim.assertCurrent(), /family-claim-lost/)
    assert.equal(f.counts.interrupts, 1); assert.equal(f.sessions.size, 2)
  })
}
