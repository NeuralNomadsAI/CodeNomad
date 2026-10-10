import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import test from "node:test"
import { MISSION_AUTHORITY_POLICY, authorityDigest, authoritySigningBytes, canonicalAuthority, snapshotAuthoritySigner } from "./authority-protocol"
import { authorityIntentSchema } from "./authority-protocol"
import { assertDerivedInvocation, authenticateDerivedCall, derivedReservationID, derivedSigningBytes,
  parseDerivedCallBody, derivedCallRecordSchema, type DerivedCallBody } from "./derived-call-protocol"

function fixture() {
  const keys = generateKeyPairSync("ed25519")
  const binding = { authorityID: "authority-one", keyID: "key-one", profileID: "profile-one", executionHost: "windows-one",
    namespace: randomUUID(), projectID: "project-one", projectCanonical: "D:/owned/project",
    roots: [{ mode: "git" as const, directory: "D:/owned/project", family: "family-one", checkout: "checkout-one" }],
    missionID: "msn_one", coordinatorSessionID: "ses_coordinator" }
  const signer = snapshotAuthoritySigner({ ...binding, publicKey: keys.publicKey, provisioningGeneration: "provisioning-one",
    policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" })
  const identity = { ...binding, version: 1 as const, policy: "codenomad.missions.native-call/signed-v1" as const,
    epoch: 1, provisioningGeneration: signer.provisioningGeneration, signerDigest: signer.signerDigest,
    task: { taskKey: "task-one", generation: 2 }, taskContractDigest: "a".repeat(64), parentTask: null,
    parentSessionID: binding.coordinatorSessionID, parentMessageID: "msg_parent", toolCallID: "call_one",
    choice: { kind: "new" as const }, execution: { agent: "research", model: { providerID: "fixture", id: "family/model", variant: "careful" } }, root: binding.roots[0] }
  const body: DerivedCallBody = { ...identity, reservationID: derivedReservationID(identity) }
  const envelope = (value = body) => ({ body: value, signature: sign(null, derivedSigningBytes(value), keys.privateKey).toString("base64") })
  return { body, signer, envelope, signBytes: (bytes: Buffer) => sign(null, bytes, keys.privateKey).toString("base64") }
}

test("derived protocol pins a domain-separated full binding and deterministic invocation reservation", () => {
  const f = fixture(), signed = f.envelope()
  assert.deepEqual(authenticateDerivedCall(signed, f.signer), signed)
  assert.deepEqual(parseDerivedCallBody(f.body), f.body)
  assert.equal(authorityIntentSchema.safeParse(signed.body).success, false, "not a human mutation intent")
  assert(!JSON.stringify(signed).includes("privateKey"))
})

for (const field of ["authorityID", "keyID", "profileID", "executionHost", "namespace", "projectID", "projectCanonical",
  "missionID", "coordinatorSessionID", "epoch", "provisioningGeneration", "signerDigest", "task", "taskContractDigest",
  "parentTask", "parentSessionID", "parentMessageID", "toolCallID", "choice", "execution", "root", "roots"] as const) {
  test(`signature refuses changed ${field}, including a recomputed reservation ID`, () => {
    const f = fixture(), body = structuredClone(f.body) as Record<string, unknown>
    const changes: Record<string, unknown> = { namespace: randomUUID(), epoch: 2, signerDigest: "b".repeat(64),
      task: { taskKey: "other-task", generation: 2 }, taskContractDigest: "c".repeat(64),
      parentTask: { taskKey: "parent-task", generation: 7 }, choice: { kind: "continue", sessionID: "ses_child" },
      execution: { agent: "other" }, root: { ...f.body.root, checkout: "other" }, roots: [{ ...f.body.root, checkout: "other" }] }
    body[field] = changes[field] ?? "foreign"
    const { reservationID: _, ...identity } = body
    body.reservationID = derivedReservationID(identity as Omit<DerivedCallBody, "reservationID">)
    assert.throws(() => authenticateDerivedCall({ ...f.envelope(), body }, f.signer))
  })
}

test("a real host-key signature in the human or bare-JSON domain cannot authorize a derived native call", () => {
  const f = fixture()
  const humanBytes = authoritySigningBytes(f.body as unknown as Parameters<typeof authoritySigningBytes>[0])
  for (const bytes of [humanBytes, Buffer.from(canonicalAuthority(f.body))]) {
    assert.throws(() => authenticateDerivedCall({ body: f.body, signature: f.signBytes(bytes) }, f.signer), /untrusted-signer/)
  }
})

test("strict call schema excludes environment, prompt, generic method, caller keys and incomplete reuse", () => {
  const f = fixture()
  for (const extra of [{ variables: { SECRET: "never" } }, { prompt: "arbitrary" }, { method: "session.prompt" },
    { privateKey: "forged" }, { expectedRevision: 1 }]) assert.throws(() => parseDerivedCallBody({ ...f.body, ...extra }))
  for (const choice of [{ kind: "reuse", fromTask: { taskKey: "old", generation: 1 } },
    { kind: "continue", sessionID: f.body.parentSessionID }, { kind: "reuse", sessionID: "ses_child", fromTask: f.body.task }]) {
    assert.throws(() => parseDerivedCallBody({ ...f.body, choice }))
  }
  assert.throws(() => parseDerivedCallBody({ ...f.body, reservationID: "dcall_" + "0".repeat(48) }))
  assert.throws(() => parseDerivedCallBody({ ...f.body, task: { ...f.body.task, generation: Number.MAX_SAFE_INTEGER + 1 } }))
})

test("portable input rejects accessors, cycles and oversized hidden input before schema cloning", () => {
  const f = fixture()
  let invoked = false
  const getter = { ...f.body }
  Object.defineProperty(getter, "proof", { enumerable: true, get() { invoked = true; return true } })
  assert.throws(() => parseDerivedCallBody(getter)); assert.equal(invoked, false)
  const cycle = { ...f.body, cycle: {} }; cycle.cycle = cycle
  assert.throws(() => parseDerivedCallBody(cycle))
  assert.throws(() => parseDerivedCallBody({ ...f.body, hidden: "x".repeat(150_000) }))
})

test("invocation verification is exact caller/purpose/child/outcome and synchronous literal currentness", () => {
  const f = fixture(), lease = { bodyDigest: authorityDigest(f.body), purpose: "reserve" as const,
    callerSessionID: f.body.parentSessionID, assertCurrent: () => true as const }
  assert.equal(assertDerivedInvocation(lease, f.body, "reserve"), true)
  for (const changed of [{ callerSessionID: "ses_sibling" }, { bodyDigest: "a".repeat(64) },
    { purpose: "report" }, { childSessionID: "ses_child" }, { assertCurrent: () => undefined },
    { assertCurrent: () => Promise.resolve(true) }, { assertCurrent: () => ({ then() { throw new Error("must not assimilate") } }) }]) {
    assert.throws(() => assertDerivedInvocation({ ...lease, ...changed } as typeof lease, f.body, "reserve"))
  }
  const ended = { ...lease, purpose: "end" as const, childSessionID: "ses_child", outcome: "error" as const }
  assert.throws(() => assertDerivedInvocation(ended, f.body, "end", "ses_child", "returned"))
  assert.equal(assertDerivedInvocation(ended, f.body, "end", "ses_child", "error"), true)
})

test("stored evidence validates signature/integrity but does not confer host authorization", () => {
  const f = fixture(), record = { signed: f.envelope(), digest: authorityDigest(f.body),
    publicKey: f.signer.publicKey.export({ format: "der", type: "spki" }).toString("base64"), state: "reserved" as const }
  assert.equal(derivedCallRecordSchema.safeParse(record).success, true)
  for (const change of [{ digest: "0".repeat(64) }, { publicKey: "bad" }, { state: "active" },
    { ended: "returned" }, { signed: { ...record.signed, signature: "A".repeat(86) + "==" } }]) {
    assert.equal(derivedCallRecordSchema.safeParse({ ...record, ...change }).success, false)
  }
})

test("stored active-child evidence must retain requested agent/model/variant and physical identity", () => {
  const f = fixture(), record = { signed: f.envelope(), digest: authorityDigest(f.body),
    publicKey: f.signer.publicKey.export({ format: "der", type: "spki" }).toString("base64"), state: "active" as const,
    child: { sessionID: "ses_child", parentSessionID: f.body.parentSessionID, root: f.body.root, execution: f.body.execution } }
  assert.equal(derivedCallRecordSchema.safeParse(record).success, true)
  for (const execution of [{}, { ...f.body.execution, agent: "foreign" },
    { agent: f.body.execution.agent, model: { ...f.body.execution.model!, variant: "foreign" } }]) {
    assert.equal(derivedCallRecordSchema.safeParse({ ...record, child: { ...record.child, execution } }).success, false)
  }
})

test("foreign signer generation/policy cannot authenticate otherwise valid derived signatures", () => {
  const f = fixture()
  for (const change of [{ provisioningGeneration: "other-generation" }, { policy: "unqualified" },
    { qualification: "unqualified" }, { signerDigest: "d".repeat(64) }]) {
    assert.throws(() => authenticateDerivedCall(f.envelope(), { ...f.signer, ...change } as typeof f.signer))
  }
})
