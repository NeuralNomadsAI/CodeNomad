import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { CODENOMAD_MISSIONS_AUTHORITY_RPC } from "../authority-rpc"
import { authorityDigest } from "../authority-protocol"
import { fixture } from "./test-fixture"

test("actual durable-plugin receipt registration is project-readable without signer qualification or caller identity", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const saved = (await f.nativeStore.read()).receipts[0], beforeWrites = f.storage.writes, beforeCounts = { ...f.counts }
  // The native data producer is not an execution authorization boundary. Losing
  // the separately injected managed-host proof blocks host effects, not evidence.
  f.loseNative()
  const rpc = f.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC)
  const first = await rpc.receipt({ intent: saved.intent, digest: saved.digest })
  assert.equal(first.receipt.requestID, saved.requestID); assert(first.receipt.completion)
  first.receipt.intent.payload.objective = "mutated native wire clone"
  const second = await rpc.receipt({ intent: saved.intent, digest: saved.digest })
  assert.equal(second.receipt.intent.payload.objective, "Real canonical coupling")
  const missing = { ...saved.intent, requestID: "missing-native-request" }
  assert.equal((await rpc.receipt({ intent: missing, digest: authorityDigest(missing) })).receipt, null)
  assert.equal(f.storage.writes, beforeWrites)
  for (const key of ["prompts", "synthetics", "creates", "environments", "interrupts"] as const) assert.equal(f.counts[key], beforeCounts[key])
})

test("registered receipt RPC enforces strict exact native namespace/project/mission/request/digest and redacts errors", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const saved = (await f.nativeStore.read()).receipts[0], rpc = f.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC)
  for (const extra of [{ namespace: randomUUID() }, { projectID: "foreign" }, { projectCanonical: "/foreign" },
    { missionID: "msn_foreign" }, { profileID: "foreign" }, { keyID: "foreign" }]) {
    const intent = { ...saved.intent, ...extra }
    await assert.rejects(rpc.receipt({ intent, digest: authorityDigest(intent) }), error => {
      assert.equal((error as Error).message, "declared native rejection")
      return true
    })
  }
  await assert.rejects(rpc.receipt({ intent: saved.intent, digest: "0".repeat(64) }))
  await assert.rejects(rpc.receipt({ intent: saved.intent, digest: saved.digest, storageKey: "private" }))
  const changed = { ...saved.intent, method: "update", payload: { objective: "Changed public input" } }
  await assert.rejects(rpc.receipt({ intent: changed, digest: authorityDigest(changed) }))
})

test("canonical reader uses two native receipt RPCs and denies a moved owned coordinator", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const saved = (await f.nativeStore.read()).receipts[0], before = f.counts.receipts, writes = f.storage.writes
  assert.equal((await f.native.read(saved.intent)).operation.receipt.digest, saved.digest)
  assert.equal(f.counts.receipts - before, 2)
  assert.equal(f.storage.writes, writes)
  f.sessions.get("ses_test_coordinator")!.location.directory = `${f.project}/moved`
  await assert.rejects(f.native.read(saved.intent), /binding-mismatch/)
  assert.equal(f.storage.writes, writes)
})

test("an actual native grant epoch publication between receipt RPC reads vetoes host settlement", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  const saved = (await f.nativeStore.read()).receipts.find(item => item.intent.method === "adopt")!
  let first = true
  f.setReceiptRead(async () => {
    if (!first) return
    first = false
    // Genuine native store publication in isolated memory, with its existing
    // monotonic/capacity checks. This is never a host-side raw-storage read shim.
    await f.nativeStore.transaction(async doc => { doc.grants[0].epoch++; doc.grants[0].sendsEnabled = false })
  })
  await assert.rejects(f.native.read(saved.intent), /observation-unavailable/)
  assert.equal(f.counts.environments, 0); assert.equal(f.counts.synthetics, 0)
})

test("pending product RPC evidence cannot clear the host reservation after a failed Stop", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
  f.failStop(); await assert.rejects(f.action("lifecycle", { action: "stop" }))
  const saved = (await f.nativeStore.read()).receipts.find(item => item.intent.method === "lifecycle" && item.intent.payload.action === "stop")!
  const rpc = f.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC)
  assert.equal((await rpc.receipt({ intent: saved.intent, digest: saved.digest })).receipt.completion, undefined)
  const host = (await f.authority.read())!
  await assert.rejects(f.authority.accept(f.request, host.pendingDigest!, host.revision), /native-receipt-mismatch/)
  assert.equal((await f.authority.read())!.pendingDigest, host.pendingDigest)
  assert.equal(f.counts.interrupts, 1)
})

test("deleted native map receipts remain available through existing coordinator, without recreation", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create(); await f.action("adopt", {})
  const deleted = await f.action("delete", { deleteManagedSessions: false })
  assert.equal(deleted.pendingDigest, null); assert.equal(deleted.mirror!.state, "revoked")
  const saved = (await f.nativeStore.read()).receipts.find(item => item.intent.method === "delete")!
  const writes = f.storage.writes
  const result = await f.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC).receipt({ intent: saved.intent, digest: saved.digest })
  assert.equal(result.receipt.completion.outcome, "applied")
  assert.equal(f.storage.writes, writes); assert.equal(f.counts.creates, 0)
  assert(f.sessions.has("ses_test_coordinator"))
})

test("captured product receipt executor denies after native plugin unload", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const saved = (await f.nativeStore.read()).receipts[0]
  const read = f.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC).receipt
  await f.disposePlugin()
  await assert.rejects(read({ intent: saved.intent, digest: saved.digest }))
})

test("product receipt executor rechecks unload that occurs during its actual storage await", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.create()
  const saved = (await f.nativeStore.read()).receipts[0], originalGet = f.storage.get.bind(f.storage)
  let first = true
  f.storage.get = async key => {
    const value = await originalGet(key)
    if (first) { first = false; await f.disposePlugin() }
    return value
  }
  const writes = f.storage.writes
  await assert.rejects(f.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC).receipt({ intent: saved.intent, digest: saved.digest }))
  assert.equal(f.storage.writes, writes)
})
