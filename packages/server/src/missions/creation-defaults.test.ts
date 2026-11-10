import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { MissionControl, MissionControlError } from "./control"
import type { MissionInputTransport, NativeMissionSession } from "./control-types"
import { missionCreationDefaultsSchema, missionCreationDefaultsWire, missionCreationSelection, parseMissionCreationDefaults, parseMissionCreationDefaultsInput, parseMissionCreationSelection } from "./creation-defaults"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { MISSION_DEFAULT_ORIGINS, MISSION_PREFERENCES_UNAVAILABLE, resolveMissionCreationDefaults } from "./profile-defaults"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { freezeCompareProfiles, missionProfileRoles } from "./playbook-profiles"

test("creation default requests accept exactly the shared playbook keys", () => {
  for (const template of Object.keys(missionProfileRoles)) assert.equal(parseMissionCreationDefaultsInput({ template }).template, template)
  for (const template of ["other", "all", "toString", "__proto__", null]) {
    assert.throws(() => parseMissionCreationDefaultsInput({ template }), (error: any) => error.code === "invalid-execution")
  }
})

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const coordinator = "ses_coordinator"
  const sessions = new Map<string, NativeMissionSession>([[coordinator,
    { id: coordinator, agent: "lead", projectID: "project", location: { directory: "/repo" } }]])
  let failJournal = false, failDocument = false, refusePreparation = false, reads = 0, created = 0
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
    prepare: async (id, input) => {
      if (refusePreparation) throw new MissionControlError("Nothing created by this call", "prepare-refused")
      return control.create({ ...input, prepared: true, preparedBy: { missionID: input.missionID, coordinatorSessionID: id } })
    },
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
    transport, fail: () => { failJournal = true }, failBeforeDocument: () => { failDocument = true },
    refusePreparation: () => { refusePreparation = true },
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
      const create = async () => {
        if (method === "inspect") return f.control.inspect(f.coordinator, { start: request }, "compare")
        const { mission } = await f.control.prepare(f.coordinator, { ...request, requestID: "compare" })
        return { mission, selection: missionCreationSelection(mission) }
      }
      const result = await create()
      assert.ok(result.mission)
      const selected = result.selection
      assert.deepEqual(result.mission.profiles, freezeCompareProfiles("compare", profiles))
      assert.deepEqual(selected?.profiles, result.mission.profiles)
      assert.equal(selected?.origins.roles.comparator, origin)
      const reads = f.reads
      f.invalidate(); f.restart()
      assert.deepEqual((await create()).selection, selected)
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
  assert.equal("creationDefaults" in result.mission!, false, "inspection exposes only the documented selection")
  assert.deepEqual(missionCreationSelection({ creationDefaults: document.oneTime?.creationDefaults }), result.selection)
  await f.documents.change(document.id, document.revision, () => true, next => { next.configuration.profiles = {} })
  assert.deepEqual(missionCreationSelection({ creationDefaults: document.oneTime?.creationDefaults, profiles: {}, taskMode: "independent" }), result.selection,
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

test("inspect preflight races retain the first published event or frozen document choices", async () => {
  for (const journalFails of [false, true]) for (const preferencesFail of [false, true]) {
    const f = fixture()
    const gates: Array<() => void> = []
    let started!: () => void
    const both = new Promise<void>(resolve => { started = resolve })
    f.transport.resolveCreationDefaults = async (_id, input) => {
      const agent = gates.length === 0 ? "first" : "second"
      await new Promise<void>(resolve => { gates.push(resolve); if (gates.length === 2) started() })
      if (agent === "second" && preferencesFail) throw new Error("Preferences became unavailable")
      return resolveMissionCreationDefaults({ ...input, preferences: [{ template: "all", profiles: {
        coordinator: { agent: "lead" }, roles: { specialist: { agent } },
      } }] })
    }
    const request = { start: { objective: "Concurrent", template: "custom" as const } }
    if (journalFails) f.fail()
    const first = f.control.inspect(f.coordinator, request, "same-operation")
    const firstOutcome = first.catch(error => error)
    const second = f.control.inspect(f.coordinator, request, "same-operation")
    await both
    gates[0]()
    if (journalFails) assert.match(String(await firstOutcome), /Journal write unavailable/)
    else await first
    gates[1]()
    assert.equal((await second).selection?.profiles.roles.specialist.agent, "first")
  }
})

test("document-mode inspect replay rejects moved coordinators and altered creation digests", async () => {
  const f = fixture(), request = { start: { objective: "Replay", template: "custom" as const } }
  await f.control.inspect(f.coordinator, request, "replay")
  f.sessions.get(f.coordinator)!.location = { directory: "/repo/other" }
  await assert.rejects(f.control.inspect(f.coordinator, request, "replay"), (error: any) => error.code === "foreign-session")
  f.sessions.get(f.coordinator)!.location = { directory: "/repo" }
  const entry = [...f.values].find(([, value]) => value && typeof value === "object" && "oneTime" in value)!
  const damaged = structuredClone(entry[1]) as any
  damaged.oneTime.creationDigest = "0".repeat(64)
  f.values.set(entry[0], damaged)
  await assert.rejects(f.control.inspect(f.coordinator, request, "replay"), (error: any) => error.code === "request-conflict")
})

test("prepare recovers its frozen document before journal publication without rereading preferences", async () => {
  const f = fixture()
  await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: f.coordinator })
  const request = { requestID: "pilot", objective: "Pilot", template: "custom" as const }
  f.fail()
  await assert.rejects(f.control.prepare(f.coordinator, request), (error: any) => error.code === "prepare-uncertain")
  assert.equal(f.reads, 1)
  assert.equal(f.created, 1)
  f.invalidate(); f.restart()
  await assert.rejects(f.control.prepare(f.coordinator, { ...request, profiles: {} }), { code: "prepare-conflict", message: "This requestID already prepared a different mission" })
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
  await assert.rejects(f.control.prepare(f.coordinator, request), (error: any) => error.code === "prepare-uncertain")
  assert.equal(f.reads, 1)
  assert.equal(f.created, 0)
  f.invalidate(); f.restart()
  const result = await f.control.prepare(f.coordinator, request)
  assert.deepEqual(result.mission.profiles?.roles, { specialist: { agent: "worker" } })
  assert.equal(f.reads, 1)
  assert.equal(f.created, 1)
})

test("a damaged retained preparation leaves other requests usable and its own ID blocked", async () => {
  const f = fixture()
  await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: f.coordinator })
  const damagedRequest = { requestID: "damaged", objective: "Uncertain preparation", template: "custom" as const }
  f.failBeforeDocument()
  await assert.rejects(f.control.prepare(f.coordinator, damagedRequest), (error: any) => error.code === "prepare-uncertain")
  const key = [...f.values.keys()].find(key => key.includes("/creation-intents/"))!
  assert.ok(key)
  const damaged = { version: 1 }
  f.values.set(key, damaged)
  const unaffected = await f.control.prepare(f.coordinator, { requestID: "unaffected", objective: "Other preparation", template: "custom" })
  assert.equal(unaffected.mission.runState, "prepared")
  const reads = f.reads, roots = f.created
  await assert.rejects(f.control.prepare(f.coordinator, damagedRequest), (error: any) => error.code === "invalid-journal")
  assert.equal(f.reads, reads)
  assert.equal(f.created, roots)
  assert.deepEqual(f.values.get(key), damaged)
})

test("creation provenance validates its exact roles and leaves historical missions absent", () => {
  const selected = resolveMissionCreationDefaults({ template: "custom", preferences: [] })
  const metadata = { request: {}, ...selected }
  assert.deepEqual(parseMissionCreationDefaults("custom", metadata), metadata)
  assert.throws(() => parseMissionCreationDefaults("debug", metadata))
  assert.throws(() => parseMissionCreationDefaults("custom", { ...metadata, origins: { ...metadata.origins, coordinator: "guessed" } }))
  assert.equal(missionCreationSelection({ profiles: {}, taskMode: "native" }), undefined)
})

test("transport selections and durable defaults require complete profiles and exact playbook roles", () => {
  for (const template of Object.keys(missionProfileRoles) as (keyof typeof missionProfileRoles)[]) {
    const selected = resolveMissionCreationDefaults({ template, preferences: [] })
    assert.deepEqual(parseMissionCreationSelection(template, selected), selected)
    for (const profiles of [undefined, {}, { coordinator: {} }, { roles: selected.profiles.roles },
      { ...selected.profiles, roles: {} }, { ...selected.profiles, roles: { ...selected.profiles.roles, unknown: {} } },
      ...missionProfileRoles[template].map(removed => ({ ...selected.profiles,
        roles: Object.fromEntries(Object.entries(selected.profiles.roles).filter(([role]) => role !== removed)) }))]) {
      const partial = { ...selected, profiles }
      assert.throws(() => parseMissionCreationSelection(template, partial))
      assert.throws(() => parseMissionCreationDefaults(template, { request: {}, ...partial }))
    }
    const foreign = template === "custom" ? "developer" : "specialist"
    assert.throws(() => parseMissionCreationSelection(template, { ...selected,
      profiles: { ...selected.profiles, roles: { ...selected.profiles.roles, [foreign]: {} } } }))
    assert.throws(() => parseMissionCreationSelection(template, { ...selected,
      origins: { ...selected.origins, roles: {} } }))
  }
})

test("inspect start creates no standalone intention on mismatch, document refusal or journal failure", async () => {
  const f = fixture()
  const start = { objective: "Inspect", template: "custom" as const }
  f.setPreferences([{ template: "all", profiles: { coordinator: { agent: "different" } } }])
  await assert.rejects(f.control.inspect(f.coordinator, { start }, "mismatch"), /Missions preferences.*profiles\.coordinator/)
  f.setPreferences([])
  f.failBeforeDocument()
  await assert.rejects(f.control.inspect(f.coordinator, { start }, "document"), /Document write unavailable/)
  f.fail()
  await assert.rejects(f.control.inspect(f.coordinator, { start }, "journal"), /Journal write unavailable/)
  await assert.rejects(f.control.inspect(f.coordinator, { start: { ...start, objective: "Conflict" } }, "journal"), (error: any) => error.code === "request-conflict")
  assert.equal([...f.values.keys()].filter(key => key.includes("/creation-intents/")).length, 0)
})

test("a retained document preserves uncertainty after the standalone choices expire", async () => {
  const f = fixture()
  await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: f.coordinator })
  const request = { requestID: "document-retry", objective: "Pilot", template: "custom" as const }
  f.fail()
  await assert.rejects(f.control.prepare(f.coordinator, request), (error: any) => error.code === "prepare-uncertain")
  for (const [key, value] of f.values) if (key.includes("/creation-intents/") && value && typeof value === "object" && !Array.isArray(value)) {
    f.values.set(key, { ...value, createdAt: 0 })
  }
  const reads = f.reads, roots = f.created
  f.invalidate(); f.refusePreparation()
  await assert.rejects(f.control.prepare(f.coordinator, request), (error: any) => error.code === "prepare-uncertain")
  assert.equal(f.reads, reads)
  assert.equal(f.created, roots)
  assert.equal([...f.values.keys()].filter(key => key.includes("/creation-intents/")).length, 1)
})

test("creation origin schemas share the resolver's exact origin set", () => {
  const schema = missionCreationDefaultsSchema.shape.origins.shape
  const wire = missionCreationDefaultsWire.properties.origins.properties
  for (const origins of [schema.coordinator.options, schema.taskMode.options, schema.roles.valueType.options,
    wire.coordinator.enum, wire.taskMode.enum, wire.roles.additionalProperties.enum]) {
    assert.deepEqual(origins, MISSION_DEFAULT_ORIGINS)
  }
  const validate = new Ajv().compile(missionCreationDefaultsWire)
  const selection = resolveMissionCreationDefaults({ template: "custom", preferences: [] })
  for (const origin of [...MISSION_DEFAULT_ORIGINS, "guessed"]) {
    const metadata = { request: {}, ...selection, origins: { coordinator: origin, taskMode: origin, roles: { specialist: origin } } }
    const valid = origin !== "guessed"
    assert.equal(missionCreationDefaultsSchema.safeParse(metadata).success, valid)
    assert.equal(validate(metadata), valid, JSON.stringify(validate.errors))
  }
})

test("creation wire origins fit every playbook and reject more than the largest role list", () => {
  const rolesWire = missionCreationDefaultsWire.properties.origins.properties.roles
  const maximum = Math.max(...Object.values(missionProfileRoles).map(roles => roles.length))
  assert.equal(rolesWire.maxProperties, maximum)
  const validate = new Ajv().compile(missionCreationDefaultsWire)
  for (const template of Object.keys(missionProfileRoles) as (keyof typeof missionProfileRoles)[]) {
    const metadata = { request: {}, ...resolveMissionCreationDefaults({ template, preferences: [] }) }
    assert.ok(validate(metadata), JSON.stringify(validate.errors))
    assert.deepEqual(parseMissionCreationDefaults(template, metadata), metadata)
    const extra = { ...metadata, origins: { ...metadata.origins, roles: { ...metadata.origins.roles, unknown: "explicit" } } }
    assert.throws(() => parseMissionCreationDefaults(template, extra))
  }
  const validateRoles = new Ajv().compile(rolesWire)
  const roles = Object.fromEntries(Array.from({ length: maximum }, (_, index) => [`role-${index}`, "explicit"]))
  assert.ok(validateRoles(roles))
  assert.equal(validateRoles({ ...roles, extra: "explicit" }), false)
})

test("creation preference availability has one shared schema and wire value", () => {
  const validate = new Ajv().compile(missionCreationDefaultsWire)
  const metadata = { request: {}, ...resolveMissionCreationDefaults({ template: "custom", preferences: [] }) }
  assert.equal(missionCreationDefaultsSchema.shape.preferences.unwrap().value, MISSION_PREFERENCES_UNAVAILABLE)
  assert.deepEqual(missionCreationDefaultsWire.properties.preferences.enum, [MISSION_PREFERENCES_UNAVAILABLE])
  for (const preferences of [undefined, MISSION_PREFERENCES_UNAVAILABLE, "available", "", null]) {
    const input = { ...metadata, ...(preferences === undefined ? {} : { preferences }) }
    const valid = preferences === undefined || preferences === MISSION_PREFERENCES_UNAVAILABLE
    assert.equal(missionCreationDefaultsSchema.safeParse(input).success, valid)
    assert.equal(validate(input), valid, JSON.stringify(validate.errors))
  }
})
