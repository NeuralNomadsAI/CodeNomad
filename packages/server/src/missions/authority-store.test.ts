import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import { NativeMissionAuthority, type AuthorityMissionObservation } from "./authority-core"
import { NativeMissionAuthorityStore, MISSION_AUTHORITY_STORAGE_PREFIX } from "./authority-store"
import { authorityDigest, authorityIntentSchema, authoritySigningBytes, MISSION_AUTHORITY_POLICY,
  type AuthorityIntent, type ProvisionedAuthoritySigner } from "./authority-protocol"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { controlOperationID } from "./receipt-identity"

const cases = ["create", "adopt", "revoke", "update", "delete", "start", "pause", "stop", "recover-coordinator", "recover-report"] as const
type Case = typeof cases[number]

async function fixture(kind: Case = "update") {
  const values = new Map<string, MissionJsonValue>()
  let writes = 0, effects = 0, metadataCallbacks = 0
  const storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) { writes++; values.set(key, structuredClone(value)) },
    async scan() { return { entries: [] } },
  }
  const store = new NativeMissionAuthorityStore(storage, "project", "/owned/project")
  const namespace = await store.initialize(), key = generateKeyPairSync("ed25519")
  const binding = { authorityID: "authority", keyID: "key", profileID: "profile", executionHost: "host", namespace,
    projectID: "project", projectCanonical: "/owned/project", missionID: "msn_owned", coordinatorSessionID: "ses_owned",
    roots: [{ mode: "git" as const, directory: "/owned/project", family: "family", checkout: "checkout" }] }
  const signer: ProvisionedAuthoritySigner = { ...binding, publicKey: key.publicKey, provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }
  let mission: AuthorityMissionObservation | undefined = kind === "create" ? undefined : {
    missionID: binding.missionID, coordinatorSessionID: binding.coordinatorSessionID, revision: 1,
    status: "active", runState: kind === "pause" ? "running" : "prepared", controlPending: false, roots: binding.roots,
  }
  const authority = new NativeMissionAuthority(store, {
    assertActive() {}, readSigners: async () => [signer], assertSignerCurrent: () => true,
    observeMission: async () => mission, assertJournalCapacity: async () => {},
  })
  const transaction = store.transaction.bind(store)
  store.transaction = (operation, beforePublish) => transaction(async doc => { metadataCallbacks++; return operation(doc) }, beforePublish)
  const intent = (method: AuthorityIntent["method"], payload: unknown, epoch = 0, requestID = "target-request") => authorityIntentSchema.parse({
    ...binding, version: 1, policy: MISSION_AUTHORITY_POLICY, expectedRevision: mission?.revision ?? 0, epoch, requestID, method, payload,
  })
  const execute = (body: AuthorityIntent, fail = false) => authority.execute({ body,
    signature: sign(null, authoritySigningBytes(body), key.privateKey).toString("base64") }, {
    apply: async () => {
      effects++
      if (fail) throw new Error("lost ACK")
      if (body.method === "lifecycle") {
        mission!.runState = body.payload.action === "start" ? "running" : body.payload.action === "pause" ? "paused" : "stopped"
        mission!.revision++
        mission!.control = { ...body, id: controlOperationID(body.missionID, body.requestID), action: body.payload.action,
          targets: [{ sessionID: body.coordinatorSessionID, location: { directory: body.projectCanonical } }], pending: [], completedRevision: mission!.revision }
      }
      return { missionID: body.missionID, revision: body.method === "lifecycle" ? mission!.revision : 2,
        ...(body.method === "lifecycle" ? { operationID: controlOperationID(body.missionID, body.requestID) } : {}),
        ...(body.method === "create" ? { prepared: true as const } : {}),
        ...(body.method === "delete" ? { deleted: true as const } : {}) }
    },
  }, new AbortController().signal)
  const needsGrant = kind === "start" || kind.startsWith("recover-")
  if (needsGrant) await execute(intent("adopt", {}, 1, "setup-adopt"))
  if (kind.startsWith("recover-")) await execute(intent("lifecycle", { action: "start" }, 1, "setup-start"))
  const body = kind === "create" ? intent("create", { objective: "Prepared owned mission", template: "custom", prepared: true })
    : kind === "adopt" ? intent("adopt", {}, 1)
    : kind === "revoke" ? intent("revoke", {})
    : kind === "update" ? intent("update", { objective: "Update owned mission" })
    : kind === "delete" ? intent("delete", { deleteManagedSessions: false })
    : kind.startsWith("recover-") ? intent("recover", kind === "recover-report" ? { target: "report", taskKey: "worker" } : { target: "coordinator" }, 1)
    : intent("lifecycle", { action: kind }, needsGrant ? 1 : 0)
  const documentKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/project/${store.projectToken}`
  const query = { intent: body, digest: authorityDigest(body) }
  const counts = () => ({ writes, effects, metadataCallbacks })
  function corrupt(completion: unknown) {
    const doc = structuredClone(values.get(documentKey)) as any
    doc.receipts.find((receipt: any) => receipt.requestID === body.requestID).completion = completion
    values.set(documentKey, doc)
  }
  return { values, store, authority, body, query, execute, counts, corrupt, documentKey }
}

async function assertDamagedReadFences(f: Awaited<ReturnType<typeof fixture>>) {
  const counts = f.counts(), bytes = JSON.stringify(f.values.get(f.documentKey))
  for (const read of [() => f.store.read(), () => f.store.initialize(), () => f.authority.readReceipt(f.query), () => f.authority.state(f.body.missionID),
    () => f.execute(f.body), () => f.store.transaction(async () => assert.fail("damaged document reached metadata callback"))]) {
    await assert.rejects(read(), /storage-invalid/)
    assert.deepEqual(f.counts(), counts, "no metadata callback, publication or effect follows damaged storage")
    assert.equal(JSON.stringify(f.values.get(f.documentKey)), bytes, "foreign bytes are neither repaired nor rewritten")
  }
}

for (const kind of cases) {
  test(`legitimate ${kind} completion survives stored reads and exact retry without effect replay`, async () => {
    const f = await fixture(kind), completed = await f.execute(f.body), counts = f.counts()
    const read = await f.authority.readReceipt(f.query)
    assert.deepEqual(read.receipt?.completion, completed.receipt.completion)
    assert.deepEqual((await f.authority.state(f.body.missionID)).pendingRequestIDs, [])
    const retry = await f.execute(f.body)
    assert.deepEqual(retry.receipt.completion, completed.receipt.completion)
    assert.equal(f.counts().effects, counts.effects)
  })

  if (kind === "adopt" || kind === "revoke") {
    test(`${kind} cannot read a schema-valid effect completion instead of its metadata-only kind`, async () => {
      const f = await fixture(kind); await f.execute(f.body)
      f.corrupt({ outcome: "applied", result: { missionID: f.body.missionID, revision: 2 } })
      await assertDamagedReadFences(f)
    })
  } else {
    for (const damage of ["foreign-mission", "metadata-only"] as const) {
      test(`${kind} pending signed receipt rejects stored ${damage} completion before reads/state/retry metadata`, async () => {
        const f = await fixture(kind)
        await assert.rejects(f.execute(f.body, true), /effect-unavailable/)
        assert.equal((await f.authority.readReceipt(f.query)).receipt?.completion, undefined)
        assert.deepEqual((await f.authority.state(f.body.missionID)).pendingRequestIDs, [f.body.requestID])
        f.corrupt({ outcome: "applied", result: damage === "foreign-mission" ? { missionID: "msn_FOREIGN", revision: 900 } : { metadataOnly: true } })
        await assertDamagedReadFences(f)
      })
    }
  }
}

for (const completion of [
  { outcome: "unknown", result: { missionID: "msn_owned" } },
  { outcome: "applied", result: { metadataOnly: false } },
  { outcome: "applied", result: { missionID: "msn_owned", metadataOnly: true } },
  { outcome: "applied", result: { revision: 2 } },
]) {
  test(`malformed stored completion fails closed: ${JSON.stringify(completion)}`, async () => {
    const f = await fixture(); await assert.rejects(f.execute(f.body, true), /effect-unavailable/)
    f.corrupt(completion); await assertDamagedReadFences(f)
  })
}

test("honest pending receipt stays pending across exact retry without invented completion or replay", async () => {
  const f = await fixture(); await assert.rejects(f.execute(f.body, true), /effect-unavailable/)
  const counts = f.counts(), retry = await f.execute(f.body)
  assert.equal(retry.receipt.completion, undefined); assert.equal(f.counts().effects, counts.effects)
  assert.deepEqual((await f.authority.state(f.body.missionID)).pendingRequestIDs, [f.body.requestID])
})

test("rejected outcome does not exempt stored completions from mission/kind identity", async () => {
  for (const result of [{ missionID: "msn_FOREIGN" }, { metadataOnly: true }]) {
    const f = await fixture(); await assert.rejects(f.execute(f.body, true), /effect-unavailable/)
    f.corrupt({ outcome: "rejected", result }); await assertDamagedReadFences(f)
  }
})

test("existing rejected outcome remains readable when its result identity and method kind match", async () => {
  for (const kind of ["create", "adopt", "revoke", "delete", "stop"] as const) {
    const f = await fixture(kind), completed = await f.execute(f.body), counts = f.counts()
    f.corrupt({ ...completed.receipt.completion!, outcome: "rejected" })
    assert.equal((await f.authority.readReceipt(f.query)).receipt?.completion?.outcome, "rejected")
    assert.equal((await f.execute(f.body)).receipt.completion?.outcome, "rejected")
    assert.equal(f.counts().effects, counts.effects)
  }
})
