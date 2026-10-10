import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import test from "node:test"
import { MissionControl } from "./control"
import { NativeMissionAuthority } from "./authority-core"
import { MISSION_AUTHORITY_STORAGE_PREFIX, NativeMissionAuthorityStore } from "./authority-store"
import { authoritySignerDigest, authoritySigningBytes, MISSION_AUTHORITY_POLICY, type AuthorityIntent, type ProvisionedAuthoritySigner } from "./authority-protocol"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, stableToken, type MissionStorage } from "./journal"
import { MISSION_SCHEMA_VERSION, type MissionCreatedEvent, type MissionJsonValue } from "./model"
import { controlResumeAdmissionID } from "./receipt-identity"
import type { SessionInboxSynthetic, SessionSyntheticInput } from "@opencode/client"

function syntheticAcknowledgement(input: SessionSyntheticInput): SessionInboxSynthetic {
  if (!input.id || !input.delivery) throw new Error("Fixture requires explicit synthetic ID and delivery")
  return { id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: input.delivery, time: { created: 100 },
    payload: { text: input.text, ...(input.description != null ? { description: input.description } : {}),
      ...(input.metadata !== undefined ? { metadata: structuredClone(input.metadata) } : {}) } }
}

// Preserve serialized bytes, including whitespace, rather than normalizing seeds.
class SharedStorage implements MissionStorage {
  readonly bytes = new Map<string, string>()
  readonly reads: string[] = []
  readonly writes: string[] = []
  async get(key: string) {
    this.reads.push(key)
    const value = this.bytes.get(key)
    return value === undefined ? undefined : JSON.parse(value) as MissionJsonValue
  }
  async set(key: string, value: MissionJsonValue) {
    this.writes.push(key)
    this.bytes.set(key, JSON.stringify(value))
  }
  async scan({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) {
    this.reads.push(prefix)
    const keys = [...this.bytes.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
    const page = keys.slice(0, limit)
    return { entries: page.map(key => ({ key, value: JSON.parse(this.bytes.get(key)!) as MissionJsonValue })),
      ...(keys.length > limit ? { next: page[page.length - 1] } : {}) }
  }
}

const projectID = "project-isolation"
const canonical = "/owned/isolation"
const token = stableToken(`${projectID}\0${canonical}`, 24)
const legacyJournal = `codenomad-missions/v1/${token}`
const legacyAuthority = "codenomad-missions/authority-v1"
const currentAuthorityKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/project/${token}`
const created = (missionID: string, objective: string): MissionCreatedEvent => ({
  version: MISSION_SCHEMA_VERSION, type: "mission.created", id: "evt_created", projectID,
  projectCanonical: canonical, missionID, objective, template: "custom", requestID: "create-request", prepared: true,
  coordinator: { sessionID: "ses_fresh", title: "Fresh coordinator", location: { directory: canonical } }, createdAt: 1,
})
const entries = (storage: SharedStorage, prefix: string) => [...storage.bytes].filter(([key]) => key.startsWith(`${prefix}/`)).sort()
function seedLegacy(storage: SharedStorage) {
  storage.bytes.set(`${legacyJournal}/msn_legacy/evt_created`, JSON.stringify(created("msn_legacy", "Old map"), null, 2))
  storage.bytes.set(`${legacyAuthority}/namespace`, JSON.stringify(randomUUID()))
  // Even damaged/obsolete authority metadata is ignored, never repaired/imported.
  storage.bytes.set(`${legacyAuthority}/project/${token}`, '{ "grants": ["old-active"], "receipts": ["old-receipt"], "migrations": [] }')
}

test("fresh journal/authority never read, import, normalize or delete old-generation bytes", async () => {
  const storage = new SharedStorage(); seedLegacy(storage)
  const original = [...storage.bytes]
  const journal = new MissionJournal(storage, projectID, canonical, () => 100)
  assert.deepEqual((await journal.snapshot()).missions, [])
  assert.equal(await journal.event("msn_legacy", "evt_created"), undefined)
  assert.deepEqual([...storage.bytes], original, "journal reads must not write")
  const store = new NativeMissionAuthorityStore(storage, projectID, canonical)
  const namespace = await store.initialize()
  assert.notEqual(namespace, JSON.parse(storage.bytes.get(`${legacyAuthority}/namespace`)!))
  assert.deepEqual((await store.read()).grants, [])
  assert.deepEqual((await store.read()).receipts, [])
  await journal.append(created("msn_fresh", "Fresh map"))
  assert.equal((await journal.snapshot()).missions[0].id, "msn_fresh")
  for (const [key, bytes] of original) assert.equal(storage.bytes.get(key), bytes)
  assert.ok(storage.reads.every(key => !key.startsWith("codenomad-missions/v1/") && !key.startsWith(`${legacyAuthority}/`)))
  assert.ok(storage.writes.every(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/`) || key.startsWith(`${MISSION_AUTHORITY_STORAGE_PREFIX}/`)))
  assert.equal(MISSION_SCHEMA_VERSION, 1, "storage generations do not change wire schemas")
})

test("explicit old-key writer cannot change fresh maps, signed grants/receipts or another project", async () => {
  const storage = new SharedStorage(); seedLegacy(storage)
  const journal = new MissionJournal(storage, projectID, canonical, () => 100)
  const store = new NativeMissionAuthorityStore(storage, projectID, canonical)
  const namespace = await store.initialize()
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const roots = [{ mode: "directory-only" as const, directory: canonical }]
  const scope = { authorityID: "authority", keyID: "key", profileID: "profile", executionHost: "windows:host",
    namespace, projectID, projectCanonical: canonical, roots }
  const signer: ProvisionedAuthoritySigner = { ...scope, publicKey, provisioningGeneration: "generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }
  const control = new MissionControl({ project: { id: projectID, canonical, location: { directory: canonical } }, storage, now: () => 100,
    sessions: {
      get: async ({ sessionID }) => ({ id: sessionID, projectID, title: "Fresh coordinator", location: { directory: canonical } }),
      create: async () => { throw new Error("No native creation in this fixture") },
      prompt: async () => { throw new Error("No prompt") }, synthetic: async () => { throw new Error("No synthetic") },
    }, transport: { prompt: async () => { throw new Error("No prompt") }, synthetic: async () => { throw new Error("No synthetic") },
      lifecycle: async (_coordinatorID, input) => {
        const mission = (await journal.snapshot()).missions.find(item => item.id === input.missionID)!
        const action = mission.control!.action
        assert.equal(action, "start", "This isolated authority fixture admits only Play")
        return { nativeAcknowledgement: { ...input, action, disposition: "start-admitted", admission: syntheticAcknowledgement({
          sessionID: input.sessionID, id: controlResumeAdmissionID(input.operationID, input.sessionID),
          text: "Start existing isolated mission", delivery: "queue",
          metadata: { "codenomad.mission": { version: 1, missionID: input.missionID, operationID: input.operationID, kind: "lifecycle" } },
        }) } }
      } },
  })
  const authority = new NativeMissionAuthority(store, {
    assertActive: () => {}, readSigners: async () => [signer],
    assertSignerCurrent: snapshot => {
      assert.equal(snapshot.signerDigest, authoritySignerDigest(publicKey))
      assert.equal(snapshot.provisioningGeneration, signer.provisioningGeneration)
      return true
    },
    observeMission: async missionID => {
      const mission = (await journal.snapshot()).missions.find(item => item.id === missionID)
      return mission && { missionID, coordinatorSessionID: mission.coordinatorSessionId, revision: mission.revision,
        status: mission.status, runState: mission.runState!, controlPending: Boolean(mission.control?.pending.length),
        control: mission.control, controlUnavailable: mission.controlUnavailable, roots }
    }, assertJournalCapacity: async () => journal.assertCanAppend(2),
  })
  const requestID = "fresh-create"
  const missionID = `msn_${stableToken(`${projectID}\0${requestID}`, 24)}`
  const intent = (method: AuthorityIntent["method"], expectedRevision: number): AuthorityIntent => ({
    ...scope, version: 1, policy: MISSION_AUTHORITY_POLICY, missionID, coordinatorSessionID: "ses_fresh",
    requestID: method === "create" ? requestID : `fresh-${method}`, epoch: method === "create" ? 0 : 1, expectedRevision, method,
    payload: method === "create" ? { objective: "Fresh signed map", template: "custom", prepared: true }
      : method === "lifecycle" ? { action: "start" } : {},
  }) as AuthorityIntent
  const execute = (body: AuthorityIntent) => authority.execute({ body, signature: sign(null, authoritySigningBytes(body), privateKey).toString("base64") }, {
    apply: async body => {
      const result = body.method === "create"
        ? await control.create({ ...body.payload, requestID: body.requestID, coordinatorSessionID: body.coordinatorSessionID })
        : body.method === "lifecycle" ? await control.lifecycle({ missionID: body.missionID, requestID: body.requestID,
          expectedRevision: body.expectedRevision, ...body.payload }) : assert.fail("Unexpected effect")
      return { missionID, revision: result.mission.revision,
        ...(body.method === "lifecycle" ? { operationID: result.mission.control!.id } : {}) }
    },
  }, new AbortController().signal)
  await execute(intent("create", 0))
  assert.equal((await journal.snapshot()).missions[0].runState, "prepared")
  assert.equal((await authority.state(missionID)).grant, null)
  const adoption = await execute(intent("adopt", 1))
  assert.equal(adoption.grant?.sendsEnabled, false)
  const play = await execute(intent("lifecycle", 1))
  assert.equal(play.grant?.sendsEnabled, true)
  await assert.rejects(execute({ ...intent("adopt", 1), missionID: "msn_legacy", requestID: "legacy-adopt" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "revision-conflict")
  await assert.rejects(execute({ ...intent("adopt", 1),
    namespace: JSON.parse(storage.bytes.get(`${legacyAuthority}/namespace`)!) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "untrusted-signer")
  const map = await journal.snapshot(); const authorityBytes = storage.bytes.get(currentAuthorityKey)
  const freshBytes = entries(storage, MISSION_JOURNAL_STORAGE_PREFIX)
  // A private legacy writer uses literal old keys, not a backwards-compatible constructor.
  await storage.set(`${legacyJournal}/msn_legacy/evt_late`, JSON.parse(JSON.stringify({ ...created("msn_legacy", "Old writer still works"), id: "evt_late" })))
  await storage.set(`${legacyAuthority}/project/${token}`, { grants: ["changed-old-grant"], receipts: ["changed-old-receipt"] })
  assert.ok(storage.bytes.has(`${legacyJournal}/msn_legacy/evt_late`))
  assert.deepEqual(await journal.snapshot(), map)
  assert.deepEqual(entries(storage, MISSION_JOURNAL_STORAGE_PREFIX), freshBytes)
  assert.equal(storage.bytes.get(currentAuthorityKey), authorityBytes)
  assert.equal((await store.read()).receipts.length, 3)
  const otherJournal = new MissionJournal(storage, "other-project", canonical)
  assert.deepEqual((await otherJournal.snapshot()).missions, [])
  assert.deepEqual((await new MissionJournal(storage, projectID, "/owned/other-canonical").snapshot()).missions, [])
  const otherStore = new NativeMissionAuthorityStore(storage, "other-project", canonical)
  await otherStore.initialize()
  assert.deepEqual((await otherStore.read()).grants, [])
  assert.equal(storage.bytes.get(currentAuthorityKey), authorityBytes)
})

test("damaged fresh authority fails closed rather than loading a valid legacy namespace", async () => {
  const storage = new SharedStorage(); seedLegacy(storage)
  const original = [...storage.bytes]
  const store = new NativeMissionAuthorityStore(storage, projectID, canonical)
  await store.initialize()
  storage.bytes.set(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, JSON.stringify("damaged"))
  const before = [...storage.bytes]
  await assert.rejects(store.read(), (error: unknown) => error instanceof Error && "code" in error && error.code === "storage-invalid")
  await assert.rejects(store.initialize(), (error: unknown) => error instanceof Error && "code" in error && error.code === "storage-invalid")
  assert.deepEqual([...storage.bytes], before)
  for (const [key, bytes] of original) assert.equal(storage.bytes.get(key), bytes)
})
