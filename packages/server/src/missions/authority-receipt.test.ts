import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import test from "node:test"
import { NativeMissionAuthority } from "./authority-core"
import { NativeMissionAuthorityStore, MISSION_AUTHORITY_STORAGE_PREFIX } from "./authority-store"
import { CODENOMAD_MISSIONS_AUTHORITY_RPC, missionAuthorityHandlers, rejectUnsignedMissionMutators } from "./authority-rpc"
import { authorityReceiptReadSchema } from "./authority-receipt"
import { authorityDigest, authoritySignerDigest, authoritySigningBytes, MISSION_AUTHORITY_POLICY, rejectAuthority,
  type AuthorityIntent, type AuthoritySignerSnapshot } from "./authority-protocol"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"

async function fixture() {
  let writes = 0, effects = 0, signerReads = 0, observations = 0, capacityChecks = 0, active = true, untrusted = false
  let afterRead: (() => void) | undefined
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    async get(key) { const value = structuredClone(values.get(key)); afterRead?.(); return value },
    async set(key, value) { writes++; values.set(key, structuredClone(value)) },
    async scan() { return { entries: [] } },
  }
  const store = new NativeMissionAuthorityStore(storage, "receipt-project", "/owned/receipt-project")
  const namespace = await store.initialize()
  const key = generateKeyPairSync("ed25519")
  const binding = { authorityID: "authority", keyID: "key", profileID: "profile", executionHost: "host", namespace,
    projectID: store.projectID, projectCanonical: store.projectCanonical, missionID: "msn_receipt", coordinatorSessionID: "ses_coordinator",
    roots: [{ mode: "git" as const, directory: store.projectCanonical, family: "physical-family", checkout: "physical-checkout" }] }
  const signer = { ...binding, publicKey: key.publicKey, provisioningGeneration: "native-generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" as const }
  const assertActive = () => { if (!active) rejectAuthority("authorization-blocked") }
  const authority = new NativeMissionAuthority(store, {
    assertActive,
    readSigners: async () => { signerReads++; if (untrusted) throw new Error("signer must not be acquired for reads"); return [signer as typeof signer & { policy: typeof MISSION_AUTHORITY_POLICY }] },
    assertSignerCurrent: (snapshot: AuthoritySignerSnapshot) => { assert.equal(snapshot.signerDigest, authoritySignerDigest(key.publicKey)); return true },
    observeMission: async () => { observations++; if (untrusted) return undefined; return { missionID: binding.missionID, coordinatorSessionID: binding.coordinatorSessionID,
      revision: 1, status: "active", runState: "prepared", controlPending: false, roots: binding.roots } },
    assertJournalCapacity: async () => { capacityChecks++ },
  })
  const intent = (method: "adopt" | "update" | "delete", requestID: string = randomUUID()): AuthorityIntent => ({ ...binding, version: 1,
    policy: MISSION_AUTHORITY_POLICY, requestID, expectedRevision: 1, epoch: 1, method,
    payload: method === "adopt" ? {} : method === "update" ? { objective: "Public bounded intent" } : { deleteManagedSessions: false },
  } as AuthorityIntent)
  const execute = (body: AuthorityIntent, fail = false) => authority.execute({ body, signature: sign(null, authoritySigningBytes(body), key.privateKey).toString("base64") },
    { apply: async () => { effects++; if (fail) throw new Error("lost effect acknowledgement"); return { missionID: body.missionID, revision: 2 } } }, new AbortController().signal)
  const adopted = intent("adopt")
  await execute(adopted)
  const handlers = missionAuthorityHandlers(authority, { apply: async () => { effects++; assert.fail("read must not execute") } }, assertActive)
  const query = (body: AuthorityIntent) => ({ intent: body, digest: authorityDigest(body) })
  const counts = () => ({ writes, effects, signerReads, observations, capacityChecks })
  return { authority, store, values, intent, adopted, execute, handlers, query, counts,
    loseSigner() { untrusted = true }, dispose() { active = false }, afterRead(callback: () => void) { afterRead = callback } }
}

test("exact receipt read returns an immutable detached completed receipt without signer/transaction/effect/write", async () => {
  const f = await fixture(), before = f.counts()
  f.loseSigner()
  f.store.transaction = () => { assert.fail("readonly query must not enter a transaction") }
  f.store.initialize = async () => { assert.fail("readonly query must not initialize") }
  const result = await f.authority.readReceipt(f.query(f.adopted))
  assert.equal(result.namespace, f.adopted.namespace); assert.equal(result.receipt!.completion!.outcome, "applied")
  assert.equal(result.receipt!.provisioningGeneration, "native-generation")
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.receipt)); assert(Object.isFrozen(result.receipt!.intent.roots[0]))
  assert.throws(() => { result.receipt!.intent.keyID = "mutated" }, TypeError)
  const decoded = structuredClone(result); decoded.receipt!.intent.keyID = "wire-clone"
  assert.equal((await f.authority.readReceipt(f.query(f.adopted))).receipt!.intent.keyID, "key")
  assert.deepEqual(f.counts(), before)
  assert.deepEqual(authorityReceiptReadSchema.parse(result), result)
})

test("pending and missing receipts remain truthful; reads do not complete/free/retry effects", async () => {
  const f = await fixture(), pending = f.intent("update")
  await assert.rejects(f.execute(pending, true), /effect-unavailable/)
  const before = f.counts()
  const result = await f.handlers.receipt(f.query(pending))
  assert.equal(result.receipt!.completion, undefined)
  assert(!Object.prototype.hasOwnProperty.call(result.receipt!, "completion"))
  const missing = await f.authority.readReceipt(f.query(f.intent("update", "missing-request")))
  assert.equal(missing.receipt, null)
  assert.deepEqual(f.counts(), before)
})

test("strict queries reject namespace/project/full binding/mission/method/epoch/digest/request mismatches", async () => {
  const f = await fixture(), body = f.adopted, before = f.counts()
  const changes = [{ namespace: randomUUID() }, { projectID: "foreign" }, { projectCanonical: "/foreign" }, { profileID: "foreign" },
    { keyID: "other" }, { executionHost: "other" }, { missionID: "msn_other" }, { coordinatorSessionID: "ses_other" },
    { roots: [{ mode: "directory-only", directory: "/foreign" }] }, { epoch: 999 }, { expectedRevision: 99 }, { method: "revoke" }]
  for (const change of changes) {
    const changed = { ...body, ...change } as AuthorityIntent
    await assert.rejects(f.authority.readReceipt(f.query(changed)))
  }
  await assert.rejects(f.authority.readReceipt({ ...f.query(body), digest: "0".repeat(64) }), /request-conflict/)
  for (const raw of [{ ...f.query(body), namespace: body.namespace }, { ...f.query(body), signature: "not-a-grant" },
    { ...f.query(body), intent: { ...body, requestID: "" } }, { ...f.query(body), intent: { ...body, payload: { extra: true } } }]) {
    await assert.rejects(f.authority.readReceipt(raw), /invalid-intent/)
  }
  let getterCalls = 0
  const getter = { digest: authorityDigest(body), get intent() { getterCalls++; return body } }
  await assert.rejects(f.authority.readReceipt(getter), /invalid-intent/)
  assert.equal(getterCalls, 0)
  assert.deepEqual(f.counts(), before)
})

test("only authority namespace declares receipt; journal/future/unsigned writers stay closed", async () => {
  const f = await fixture()
  assert.equal(CODENOMAD_MISSIONS_AUTHORITY_RPC.methods.receipt.input.safeParse(f.query(f.adopted)).success, true)
  const journal = rejectUnsignedMissionMutators({ receipt: f.handlers.receipt, intent: async () => assert.fail("unsigned writer") })
  await assert.rejects(journal.receipt(f.query(f.adopted)), /unsigned-privileged-method/)
  const native = rejectUnsignedMissionMutators({ ...f.handlers, future: async () => assert.fail("future writer") }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
  assert((await native.receipt(f.query(f.adopted))).receipt)
  await assert.rejects(native.intent({} as never, { signal: new AbortController().signal }), /unsigned-privileged-method/)
  await assert.rejects(native.future(), /unsigned-privileged-method/)
})

test("captured read executor rechecks disposal after storage await and redacts native errors", async () => {
  const f = await fixture(), captured = f.handlers.receipt
  f.afterRead(() => f.dispose())
  const failure = await captured(f.query(f.adopted), { error: (name, message, data) => ({ name, message, data }) })
  assert.deepEqual(failure, { name: "mission.authority-rejected", message: "Mission receipt unavailable", data: { code: "authorization-blocked" } })
  await assert.rejects(f.authority.readReceipt(f.query(f.adopted)), /authorization-blocked/)
  const broken = missionAuthorityHandlers(f.authority, { apply: async () => assert.fail("readonly") }, () => { throw new Error("PRIVATE CONTROL SECRET") })
  const redacted = await broken.receipt(f.query(f.adopted), { error: (name, message, data) => ({ name, message, data }) })
  assert.deepEqual(redacted, { name: "mission.authority-rejected", message: "Mission receipt unavailable", data: { code: "observation-unavailable" } })
})

test("deleted/revoked historical receipt is readable without a live map or current signer", async () => {
  const f = await fixture(), deleted = f.intent("delete")
  await f.execute(deleted)
  f.loseSigner()
  const before = f.counts()
  const result = await f.authority.readReceipt(f.query(deleted))
  assert.equal(result.receipt!.intent.method, "delete"); assert.equal(result.receipt!.completion!.outcome, "applied")
  assert.deepEqual(f.counts(), before)
  assert((await f.authority.readReceipt(f.query(f.adopted))).receipt)
})

test("unknown/malformed authority is never initialized/repaired and old bytes remain ignored", async () => {
  const f = await fixture()
  f.values.set("codenomad-missions/authority-v1/namespace", "opaque-old-bytes")
  f.values.set("codenomad-missions/authority-v1/project/old", { receipt: "opaque-old-receipt" })
  assert.equal((await f.authority.readReceipt(f.query(f.intent("update", "old-request")))).receipt, null)
  f.values.delete(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`)
  const before = structuredClone(f.values), counts = f.counts()
  await assert.rejects(f.authority.readReceipt(f.query(f.adopted)), /storage-invalid/)
  assert.deepEqual(f.values, before); assert.deepEqual(f.counts(), counts)
})
