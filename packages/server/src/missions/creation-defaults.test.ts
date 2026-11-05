import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { MissionControl } from "./control"
import type { MissionInputTransport, NativeMissionSession } from "./control-types"
import { missionCreationSelection, parseMissionCreationDefaults } from "./creation-defaults"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { resolveMissionCreationDefaults } from "./profile-defaults"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { freezeCompareProfiles } from "./playbook-profiles"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const coordinator = "ses_coordinator"
  const sessions = new Map<string, NativeMissionSession>([[coordinator,
    { id: coordinator, agent: "lead", projectID: "project", location: { directory: "/repo" } }]])
  let failJournal = false, failDocument = false, reads = 0, created = 0
  let preferences: unknown = [{ template: "all", profiles: { coordinator: { agent: "lead" }, roles: { specialist: { agent: "worker" } } } }]
  const storage: MissionStorage & MissionDocumentStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => {
      if (failJournal && value && typeof value === "object" && "type" in value && value.type === "mission.created") {
        failJournal = false; throw new Error("Journal write unavailable")
      }
      values.set(key, structuredClone(value))
    },
    compareAndSet: async (key, value, expected, current) => {
      current()
      if (failDocument) { failDocument = false; throw new Error("Document write unavailable") }
      assert.equal((values.get(key) as { revision?: number } | undefined)?.revision ?? null, expected)
      values.set(key, structuredClone(value))
    },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value: structuredClone(value) })) }),
  }
  const documents = new NativeMissionDocumentStore(storage, "project", "/repo")
  const access = <T>(use: (store: NativeMissionDocumentStore) => Promise<T>) => use(documents)
  const transport: MissionInputTransport = {
    prompt: async () => assert.fail("Creation never prompts"), synthetic: async () => assert.fail("Creation never resumes"),
    resolveCreationDefaults: async (_id, input) => { reads++; return resolveMissionCreationDefaults({ ...input, preferences }) },
    prepare: async (id, input) => control.create({ ...input, prepared: true,
      preparedBy: { missionID: input.missionID, coordinatorSessionID: id } }),
  }
  const options: ConstructorParameters<typeof MissionControl>[0] = {
    project: { id: "project", canonical: "/repo", location: { directory: "/repo" } }, storage,
    documents: access, documentReads: access, transport, now: () => 1_790_000_000_000,
    sessions: {
      get: async ({ sessionID }) => { const session = sessions.get(sessionID); if (!session) throw new Error("Missing"); return session },
      create: async input => { created++; const session = { ...input, projectID: "project" }; sessions.set(session.id, session); return session },
      prompt: async () => assert.fail("Creation never prompts"), synthetic: async () => assert.fail("Creation never resumes"),
    },
  }
  let control = new MissionControl(options)
  return { get control() { return control }, coordinator, documents, values, sessions, get reads() { return reads }, get created() { return created },
    fail: () => { failJournal = true }, failBeforeDocument: () => { failDocument = true },
    setPreferences: (value: unknown) => { preferences = value }, invalidate: () => { preferences = null }, restart: () => { control = new MissionControl(options) } }
}

test("both agent creation paths store the editor's effective Compare judge and freeze the selected slot's origin", async () => {
  const model = { providerID: "p", id: "coordinator" }
  for (const method of ["prepare", "inspect"] as const) for (const origin of ["explicit", "preference"] as const) {
    for (const comparator of [{}, { agent: "judge" }, { agent: "judge", model: { providerID: "p", id: "own" } }]) {
      const f = fixture()
      f.sessions.get(f.coordinator)!.model = model
      if (method === "prepare") await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: f.coordinator })
      const profiles = { coordinator: { model }, roles: { "model-a": { model: { providerID: "p", id: "a" } },
        "model-b": { model: { providerID: "p", id: "b" } }, comparator } }
      f.setPreferences(origin === "preference" ? [{ template: "compare", profiles }] : [])
      const request = { objective: "Compare", template: "compare" as const, ...(origin === "explicit" ? { profiles } : {}) }
      const create = () => method === "prepare" ? f.control.prepare(f.coordinator, { ...request, requestID: "compare" })
        : f.control.inspect(f.coordinator, { start: request }, "compare")
      const result = await create()
      assert.ok(result.mission)
      const selected = missionCreationSelection(result.mission)
      assert.deepEqual(result.mission.profiles, freezeCompareProfiles("compare", profiles))
      assert.deepEqual(selected?.profiles, result.mission.profiles)
      assert.equal(selected?.origins.roles.comparator, origin)
      const reads = f.reads
      f.invalidate(); f.restart()
      assert.deepEqual(missionCreationSelection((await create()).mission!), selected)
      assert.equal(f.reads, reads, "the completed judge model is retained without another preference read")
    }
  }
})

test("inspect start recovers frozen preferences from its document before a missing creation event", async () => {
  const f = fixture(), start = { objective: "Frozen document", template: "custom" as const }
  f.fail()
  await assert.rejects(f.control.inspect(f.coordinator, { start }, "inspect-create"), /Journal write unavailable/)
  assert.equal(f.reads, 1)
  f.invalidate(); f.restart()
  await assert.rejects(f.control.inspect(f.coordinator, { start: { ...start, profiles: {} } }, "inspect-create"), /different mission/)
  const result = await f.control.inspect(f.coordinator, { start }, "inspect-create")
  assert.equal(result.mission?.runState, "prepared")
  assert.deepEqual(result.selection?.profiles.roles, { specialist: { agent: "worker" } })
  assert.equal(result.selection?.origins.roles.specialist, "preference")
  assert.equal(f.reads, 1, "even invalid current preferences are unread on recovery")
  const ajv = new Ajv({ allErrors: true })
  const validate = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.create.output)
  assert.ok(validate({ mission: result.mission }), JSON.stringify(validate.errors))
  const document = await f.documents.read(result.mission!.id)
  assert.ok(document && !("deletedAt" in document))
  assert.deepEqual(document.oneTime?.creationDefaults, result.mission?.creationDefaults)
  await f.documents.change(document.id, document.revision, () => true, next => { next.configuration.profiles = {} })
  assert.deepEqual(missionCreationSelection({ ...result.mission!, profiles: {}, taskMode: "independent" }), result.selection,
    "the creation receipt keeps its original selection after profile edits")
  await assert.rejects(f.documents.change(document.id, document.revision + 1, () => true, next => {
    next.oneTime!.creationDefaults!.origins.coordinator = "explicit"
  }), /progress is monotone/, "creation provenance is immutable")
  await f.control.update({ missionID: result.mission!.id, objective: "Human-edited objective", requestID: "edit",
    expectedRevision: result.mission!.revision })
  const replay = await f.control.inspect(f.coordinator, { start }, "inspect-create")
  assert.equal(replay.mission?.objective, "Human-edited objective")
  assert.deepEqual(replay.selection, result.selection, "replay matches the original creation rather than later editor fields")
  assert.equal(f.reads, 1)
})

test("prepare recovers its frozen document before journal publication without rereading preferences", async () => {
  const f = fixture()
  await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: f.coordinator })
  const request = { requestID: "pilot", objective: "Pilot", template: "custom" as const }
  f.fail()
  await assert.rejects(f.control.prepare(f.coordinator, request), /Journal write unavailable/)
  assert.equal(f.reads, 1)
  assert.equal(f.created, 1)
  f.invalidate(); f.restart()
  await assert.rejects(f.control.prepare(f.coordinator, { ...request, profiles: {} }), (error: any) => error.code === "prepare-conflict")
  const result = await f.control.prepare(f.coordinator, request)
  assert.deepEqual(result.mission.profiles?.roles, { specialist: { agent: "worker" } })
  assert.equal(result.mission.creationDefaults?.origins.coordinator, "preference")
  assert.equal(f.reads, 1)
  assert.equal(f.created, 1, "retry reuses the same unprompted root")
})

test("the pre-dispatch creation intention survives a failure before the first document and reinstantiation", async () => {
  const f = fixture()
  await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: f.coordinator })
  const request = { requestID: "before-document", objective: "Pilot", template: "custom" as const }
  f.failBeforeDocument()
  await assert.rejects(f.control.prepare(f.coordinator, request), /Document write unavailable/)
  assert.equal(f.reads, 1)
  assert.equal(f.created, 0)
  f.invalidate(); f.restart()
  const result = await f.control.prepare(f.coordinator, request)
  assert.deepEqual(result.mission.profiles?.roles, { specialist: { agent: "worker" } })
  assert.equal(f.reads, 1)
  assert.equal(f.created, 1)
})

test("creation provenance validates its exact roles and leaves historical missions absent", () => {
  const selected = resolveMissionCreationDefaults({ template: "custom", preferences: [] })
  const metadata = { request: {}, ...selected }
  assert.deepEqual(parseMissionCreationDefaults("custom", metadata), metadata)
  assert.throws(() => parseMissionCreationDefaults("debug", metadata))
  assert.throws(() => parseMissionCreationDefaults("custom", { ...metadata, origins: { ...metadata.origins, coordinator: "guessed" } }))
  assert.equal(missionCreationSelection({ profiles: {}, taskMode: "native" }), undefined)
})
