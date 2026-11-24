import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { compareModelError, missionRoleProfile, type MissionProfiles } from "./playbook-profiles"
import { validateMissionCompletionPolicy, validateMissionDelegationPolicy, validateMissionReportArtifact } from "./contracts"
import type { MissionJsonValue, MissionMap, MissionTask } from "./model"
import { buildAssignmentPrompt, getMissionRecipe } from "./recipes"
import { prepareMissionCreation } from "../server/routes/mission-creation-pipeline"
import { registerMissionRecurrenceCreate } from "../server/routes/mission-recurrence-create"
import { MissionControl } from "./control"
import type { MissionStorage } from "./journal"
import type { NativeMissionSession } from "./control-types"

const a = { model: { providerID: "fixture", id: "a" } }, b = { model: { providerID: "fixture", id: "b" } }
const profiles: MissionProfiles = { coordinator: a, roles: { "model-a": a, "model-b": b } }
const source = { kind: "file", path: "output.txt", sha256: "a".repeat(64) }
const artifact = { version: 1, kind: "comparison", runRefs: ["x", "y"], verdict: "equivalent",
  results: [{ criterion: "correct", a: 10, b: 10, observation: "Both correct", evidence: [source] }] }
const task = (key: string, role: string, artifact?: MissionJsonValue): MissionTask => ({ id: key, key, role, brief: "Same task", title: key,
  status: "completed", blockedBy: [], createdAt: 1, updatedAt: 1, outstandingExecution: false,
  report: { id: key, taskKey: key, sessionId: "ses_root", outcome: "completed", summary: "Actual output", evidence: [], next: [], createdAt: 1, artifact } })
const tasks = [task("x", "model-a"), task("y", "model-b"), task("judge", "comparator", artifact)]

function controlFixture() {
  const values = new Map<string, MissionJsonValue>(), created: NativeMissionSession[] = []
  const root: NativeMissionSession = { id: "ses_root", projectID: "project", location: { directory: "/repo" },
    model: { providerID: "fixture", id: "effective", variant: "high" } }
  const sessions = new Map([[root.id, root]])
  const storage: MissionStorage = { get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) }
  const control = new MissionControl({ storage, project: { id: "project", canonical: "/repo", location: root.location }, sessions: {
    get: async ({ sessionID }) => { const value = sessions.get(sessionID); assert(value); return value },
    create: async input => { const value = { ...input, projectID: "project" }; sessions.set(value.id, value); created.push(value); return value },
    prompt: async () => {}, synthetic: async () => {},
  } })
  return { control, values, root, created }
}

for (const [value, code] of [[undefined, "compare-models-required"],
  [{ roles: { "model-a": a, "model-b": a } }, "compare-models-identical"]] as const) {
  test(`agent-started Compare refuses ${code} before writing`, async () => {
    const f = controlFixture()
    await assert.rejects(f.control.inspect(f.root.id, { start: { objective: "Compare", template: "compare", profiles: value } }, "start"), new RegExp(code))
    assert.equal(f.values.size, 0)
  })
}

test("agent-started Compare freezes the caller's model at creation", async () => {
  const f = controlFixture()
  const result = await f.control.inspect(f.root.id, { start: { objective: "Compare", template: "compare", profiles: { roles: profiles.roles } } }, "start")
  assert.deepEqual(result.mission!.profiles?.roles?.comparator?.model, f.root.model)
})

for (const mode of ["native", "independent", "revision"] as const) test(`${mode} judge retries keep the creation-time model after the coordinator changes`, async () => {
  const f = controlFixture()
  const started = await f.control.inspect(f.root.id, { start: { objective: "Compare", template: "compare", taskMode: mode === "independent" ? mode : "native", profiles: { roles: profiles.roles } } }, "start")
  const input = { taskKey: "judge", title: "Judge", brief: "X/Y only", role: "comparator", blockedBy: [] }
  const revision = { expectedRevision: started.mission!.revision, requestID: "judge-revision", reason: "Add judge", retireTasks: [], dependencyUpdates: [], addTasks: [input] }
  const run = () => mode === "revision" ? f.control.revise(f.root.id, revision) : mode === "native" ? f.control.declare(f.root.id, input)
    : f.control.delegate(f.root.id, { ...input, delivery: "queue", executionMode: { kind: "independent", reason: "playbook", explanation: "Independent comparison" } })
  const result = await run()
  assert.deepEqual(result.mission.tasks[0].execution?.model, f.root.model)
  assert.deepEqual((await run()).mission, result.mission, "identical retry before coordinator change")
  f.root.model = { providerID: "fixture", id: "changed" }
  assert.deepEqual((await run()).mission, result.mission, "identical retry after coordinator change")
  if (mode === "independent") assert.equal(f.created.length, 1)
  assert.deepEqual((await f.control.inspect(f.root.id, { start: { objective: "Compare", template: "compare", taskMode: mode === "independent" ? mode : "native", profiles: { roles: profiles.roles } } }, "start")).mission, result.mission)
})

test("creation freezes a materialized native default variant as an omitted request", async () => {
  const f = controlFixture()
  f.root.model = { providerID: "fixture", id: "effective", variant: "default" }
  const result = await f.control.inspect(f.root.id, { start: { objective: "Compare", template: "compare", profiles: { roles: profiles.roles } } }, "start")
  assert.deepEqual(result.mission!.profiles?.roles?.comparator?.model, { providerID: "fixture", id: "effective" })
})

test("prepared Compare creation freezes explicit profiles once and preserves an explicit judge", async () => {
  for (const judge of [undefined, { agent: "child" }, b] as Array<MissionProfiles["coordinator"]>) {
    const f = controlFixture(), input = { requestID: "create", objective: "Compare", template: "compare" as const, prepared: true,
      profiles: { ...profiles, roles: { ...profiles.roles, ...(judge ? { comparator: judge } : {}) } } }
    const { mission } = await f.control.create(input)
    assert.deepEqual(mission.profiles?.roles?.comparator, { ...judge, model: judge?.model ?? a.model })
    assert.deepEqual((await f.control.create(input)).mission, mission)
  }
})

test("unknown creation model leaves judge on the native default, including creation replay", async () => {
  const f = controlFixture(), start = { objective: "Compare", template: "compare" as const, profiles: { roles: profiles.roles } }
  f.root.model = undefined
  const result = await f.control.inspect(f.root.id, { start }, "start")
  assert.equal(result.mission!.profiles?.roles?.comparator, undefined)
  f.root.model = a.model
  assert.deepEqual((await f.control.inspect(f.root.id, { start }, "start")).mission, result.mission)
})

test("Compare refuses missing or identical models before HTTP/recurring admission; variants do not distinguish models", async () => {
  const app = Fastify()
  registerMissionRecurrenceCreate(app, { workspaceManager: {} as never, bridgeToken: "private-fixture", auth: {
    isAuthEnabled: () => true, getSessionFromRequest: () => ({ sessionId: "fixture" }) } as never })
  try {
    for (const [value, code] of [[undefined, "compare-models-required"], [{ roles: { "model-a": a } }, "compare-models-required"],
      [{ roles: { "model-a": a, "model-b": { model: { ...a.model, variant: "high" } } } }, "compare-models-identical"]] as const) {
      assert.equal(compareModelError(value), code)
      await assert.rejects(prepareMissionCreation({ manager: {} as never, workspaceID: "fixture", signal: new AbortController().signal,
        request: { requestId: "compare", objective: "Compare", template: "compare", profiles: value } }), { status: 400, message: code })
      const reply = await app.inject({ method: "POST", url: "/api/workspaces/fixture/missions/recurrence", payload: {
        requestID: "compare", instructions: "Compare", template: "compare", clock: { time: "09:00", zone: "UTC" },
        taskMode: "native", watchedConversationIDs: [], profiles: value } })
      assert.equal(reply.json().code, code)
    }
    assert.equal(compareModelError(profiles), undefined)
    assert.deepEqual(missionRoleProfile("compare", profiles, "comparator"), a)
  } finally { await app.close() }
})

test("Compare enforces byte-identical run briefs and frozen models at the common role policy", () => {
  const check = (brief: string, execution = b) => validateMissionDelegationPolicy({ template: "compare", role: "model-b",
    profiles, brief, execution, tasks: [tasks[0]], phase: "declaration" })
  assert.doesNotThrow(() => check("Same task"))
  for (const [brief, execution, error] of [["Same task\n", b, /byte-identical/], ["Same task", a, /override/]] as const)
    assert.throws(() => check(brief, execution), error)
  assert.throws(() => validateMissionDelegationPolicy({ template: "compare", role: "comparator", tasks,
    executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "x" } }), /fresh conversations/)
  const [first, second] = getMissionRecipe("compare").roles
  assert.deepEqual([first.instructions, first.purpose, first.reportContract], [second.instructions, second.purpose, second.reportContract])
  const prompt = buildAssignmentPrompt({ id: "mission", template: "compare", objective: "SECRET_MODEL", notes: "SECRET_MODEL" } as MissionMap,
    { ...tasks[2], brief: "X: result one; Y: result two" })
  assert(!prompt.includes("SECRET_MODEL"))
})

test("Compare validates only comparison artifacts and requires both runs and the mandatory judge for completion", () => {
  const check = (value: MissionJsonValue, evidence = tasks) => validateMissionReportArtifact({ template: "compare", role: "comparator", outcome: "completed", artifact: value, tasks: evidence })
  assert.deepEqual(check(artifact), artifact)
  for (const value of [{ ...artifact, runRefs: ["y", "x"] }, { ...artifact, verdict: "improved" }, { ...artifact, lesson: "NO_ENTRY" },
    { ...artifact, results: [{ ...artifact.results[0], evidence: [] }] }, { ...artifact, results: [...artifact.results, ...artifact.results] }]) assert.throws(() => check(value))
  assert.throws(() => check(artifact, [{ ...tasks[0], status: "withdrawn" }, ...tasks.slice(1)]), /completed/)
  assert.doesNotThrow(() => validateMissionCompletionPolicy({ template: "compare", outcome: "completed", tasks }))
  for (const role of ["model-a", "model-b", "comparator"]) assert.throws(() => validateMissionCompletionPolicy({
    template: "compare", outcome: "completed", tasks: tasks.filter(task => task.role !== role) }), /requires/)
})
