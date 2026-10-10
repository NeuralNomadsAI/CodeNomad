import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import { MissionCreateNoEffectError } from "./control-error"
import type { NativeMissionSession } from "./control-types"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { validateMissionProfileCatalog } from "./playbook-profiles"
import { buildActorContext, buildAssignmentPrompt } from "./recipes"
import { parseMissionTaskMode, type MissionTaskMode } from "./task-execution-mode"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { authorityIntentSchema, MISSION_AUTHORITY_POLICY } from "./authority-protocol"

const task = { taskKey: "bounded-work", title: "Bounded work", brief: "Return one concrete result", role: "specialist", blockedBy: [] }
const independent = { kind: "independent" as const, reason: "playbook" as const,
  explanation: "The user selected independent declared tasks for this mission." }
const catalog = { agents: [{ id: "lead", mode: "primary" }, { id: "child", mode: "subagent" }], models: [] }

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const project = { id: "project-mode", canonical: "/owned", location: { directory: "/owned" } }
  const sessions = new Map<string, NativeMissionSession>(["ses_lead", "ses_actor"].map(id => [id,
    { id, projectID: project.id, title: id, location: project.location, agent: "lead" }]))
  let births = 0, sends = 0, clock = 1
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
  }
  const control = new MissionControl({ project, storage, now: () => clock++, sessions: {
    get: async ({ sessionID }) => { const session = sessions.get(sessionID); if (!session) throw new Error("missing"); return structuredClone(session) },
    create: async input => { births++; const session = { ...input, projectID: project.id }; sessions.set(input.id, session); return session },
    prompt: async () => { sends++ }, synthetic: async () => { sends++ },
  }, validateProfiles: async (profiles, _directory, taskMode) => validateMissionProfileCatalog(profiles, catalog, taskMode) })
  const input = { objective: "Bounded mission policy", template: "custom" as const, requestID: "create-mode", coordinatorSessionID: "ses_lead" }
  const journal = new MissionJournal(storage, project.id, project.canonical)
  return { control, input, journal, values, counts: () => ({ births, sends }) }
}

for (const taskMode of ["native", "independent"] as const) {
  test(`${taskMode} creation persists and replays its exact policy; changed policy has a no-effect conflict`, async () => {
    const f = fixture(), input = { ...f.input, taskMode }
    const { mission } = await f.control.create(input)
    assert.equal(mission.taskMode, taskMode)
    assert.equal((await f.journal.events()).events[0].type, "mission.created")
    assert.equal(((await f.journal.events()).events[0] as { taskMode?: MissionTaskMode }).taskMode, taskMode)
    assert.equal(parseMissionEvent({ ...(await f.journal.events()).events[0], taskMode: "root" }), undefined)
    assert.equal((await f.journal.snapshot()).missions[0].taskMode, taskMode)
    assert.equal((await f.control.create(input)).mission.revision, mission.revision)
    const before = structuredClone([...f.values])
    await assert.rejects(f.control.create({ ...input, taskMode: taskMode === "native" ? "independent" : "native" }),
      (error: unknown) => error instanceof MissionCreateNoEffectError && error.code === "request-conflict"
        && error.noEffect.requestID === input.requestID && error.noEffect.missionID === mission.id)
    assert.deepEqual([...f.values], before)
    assert.deepEqual(f.counts(), { births: 0, sends: 0 })
  })

  test(`${taskMode} agent-side creation and replay retain policy`, async () => {
    const f = fixture(), start = { objective: f.input.objective, template: f.input.template, taskMode }
    const first = await f.control.inspect("ses_lead", { start }, "exact-start")
    assert.equal(first.mission!.taskMode, taskMode)
    assert.equal((await f.control.inspect("ses_lead", { start }, "exact-start")).mission!.revision, first.mission!.revision)
    await assert.rejects(f.control.inspect("ses_lead", { start: { ...start, taskMode: taskMode === "native" ? "independent" : "native" } }, "exact-start"), /different mission/)
    assert.deepEqual(f.counts(), { births: 0, sends: 0 })
  })
}

test("absence defaults to native without converting historical root tasks or persisted creation records", async () => {
  const f = fixture(), { mission } = await f.control.create(f.input)
  assert.equal(mission.taskMode, "native")
  assert.equal((await f.control.create({ ...f.input, taskMode: "native" })).mission.revision, mission.revision)
  for (const [key, value] of f.values) {
    const event = parseMissionEvent(value)
    if (event?.type === "mission.created") {
      const { taskMode: _taskMode, ...historical } = event
      assert.equal("taskMode" in parseMissionEvent(historical)!, false)
      f.values.set(key, historical as unknown as MissionJsonValue)
    }
  }
  assert.equal((await f.journal.snapshot()).missions[0].taskMode, "native")
  const native = await f.control.declare("ses_lead", task)
  assert.deepEqual(native.mission.tasks[0].executionMode, { kind: "native", parentTaskKey: null })
  const historical = await f.control.delegate("ses_lead", { ...task, taskKey: "historical-root", delivery: "queue", targetSessionID: "ses_actor" })
  assert.equal(historical.mission.tasks.find(task => task.key === "historical-root")!.executionMode, undefined)
  assert.deepEqual(f.counts(), { births: 0, sends: 1 })
})

test("independent policy rejects omitted/native declarations, root dispatch bypasses and new revised tasks before writes", async () => {
  const f = fixture(), { mission } = await f.control.create({ ...f.input, taskMode: "independent" })
  for (const executionMode of [undefined, { kind: "native" as const, parentTaskKey: null }]) {
    const before = structuredClone([...f.values])
    await assert.rejects(f.control.declare("ses_lead", { ...task, executionMode }), /requires explicit independent/)
    await assert.rejects(f.control.delegate("ses_lead", { ...task, executionMode, targetSessionID: "ses_actor", delivery: "queue" }), /requires explicit independent/)
    await assert.rejects(f.control.revise("ses_lead", { missionID: mission.id, expectedRevision: mission.revision,
      requestID: "add-mode", reason: "Add work", retireTasks: [], dependencyUpdates: [], addTasks: [{ ...task, executionMode }] }), /requires explicit independent/)
    assert.deepEqual([...f.values], before)
  }
  const declared = await f.control.declare("ses_lead", { ...task, executionMode: independent })
  assert.deepEqual(declared.mission.tasks[0].executionMode, independent)
  const added = await f.control.revise("ses_lead", { missionID: mission.id, expectedRevision: declared.mission.revision,
    requestID: "add-independent", reason: "Add work", retireTasks: [], dependencyUpdates: [],
    addTasks: [{ ...task, taskKey: "next-work", executionMode: independent }] })
  assert.deepEqual(added.mission.tasks[1].executionMode, independent)
  assert.deepEqual(f.counts(), { births: 0, sends: 0 })
  const dispatched = await f.control.delegate("ses_lead", { ...task, executionMode: independent, delivery: "queue", targetSessionID: "ses_actor" })
  assert.equal(dispatched.disposition, "dispatched")
  assert.deepEqual(dispatched.mission.tasks[0].executionMode, independent)
  const context = buildActorContext(dispatched.mission, "ses_lead")
  assert.match(context, /persisted user-selected taskMode is independent/)
  assert.doesNotMatch(context, /Pass the declaration's canonical assignmentPrompt/)
  const assignment = buildAssignmentPrompt(dispatched.mission, dispatched.mission.tasks[0])
  assert.match(assignment, /ordinary native helpers when useful/)
  assert.match(assignment, /denied\/depth-limited helper into an undeclared independent root/)
  assert.match(assignment, /When finished, call mission.report/)
})

test("primary-only role presets validate against a fresh catalog only for independent missions", async () => {
  const profiles = { roles: { specialist: { agent: "lead" } } }
  const native = fixture()
  await assert.rejects(native.control.create({ ...native.input, profiles }), /owned native catalog/)
  assert.equal(native.values.size, 0)
  const root = fixture()
  assert.deepEqual((await root.control.create({ ...root.input, profiles, taskMode: "independent" })).mission.profiles, profiles)
  assert.throws(() => validateMissionProfileCatalog({ roles: { specialist: { agent: "child" } } }, catalog, "independent"), /primary\/all/)
  validateMissionProfileCatalog({ roles: { specialist: { agent: "child" } } }, catalog)
})

test("mode codecs fail closed and creation wire/signed schemas preserve both selections", () => {
  assert.equal(parseMissionTaskMode(undefined), "native")
  for (const invalid of [null, "root", false, {}]) assert.throws(() => parseMissionTaskMode(invalid))
  assert.ok("taskMode" in CODENOMAD_MISSIONS_RPC.methods.create.input.properties)
  assert.ok("taskMode" in CODENOMAD_MISSIONS_RPC.methods.create.output.properties.mission.properties)
  const body = { version: 1, policy: MISSION_AUTHORITY_POLICY, method: "create", missionID: "mission-mode", projectID: "project-mode",
    authorityID: "authority-mode", keyID: "key-mode", profileID: "profile", executionHost: "local", projectCanonical: "/owned",
    namespace: "c8cb8d62-a104-40ca-a9ba-d205c2a4a7cd", coordinatorSessionID: "ses_lead", roots: [{ mode: "directory-only", directory: "/owned" }],
    epoch: 0, expectedRevision: 0, requestID: "signed-create", payload: { objective: "Signed mode", template: "custom", prepared: true } }
  for (const taskMode of ["native", "independent"]) {
    const signed = { ...body, payload: { ...body.payload, taskMode } }
    assert.deepEqual(authorityIntentSchema.parse(signed).payload, signed.payload)
  }
  assert.deepEqual(authorityIntentSchema.parse(body).payload, body.payload)
  assert.equal(authorityIntentSchema.safeParse({ ...body, payload: { ...body.payload, taskMode: "root" } }).success, false)
})
