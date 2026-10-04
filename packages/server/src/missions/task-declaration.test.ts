import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import type { MissionSessionAdapter, NativeMissionSession } from "./control-types"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue, MissionTemplateId } from "./model"
import { normalizeTaskDeclaration, taskContractReferenceSchema, validateTaskAdmissionGraph } from "./task-declaration"

const task = (taskKey: string, blockedBy: string[] = []) => ({ taskKey, title: taskKey, brief: "Bounded work", role: "research", blockedBy })
const readout = (taskKey: string) => ({ taskKey, outcome: "completed" as const, summary: "Native results reviewed",
  evidence: ["Ordinary child return"], next: [], final: false })

test("coordinator settles unbound native business tasks without child reports or execution proof", async () => {
  const h = harness("custom")
  const { mission } = await h.start()
  await h.control.declare(h.coordinator.id, task("research-one"))
  await h.control.declare(h.coordinator.id, task("research-two", ["research-one"]))
  const before = h.values.size
  await assert.rejects(h.control.report(h.coordinator.id, readout("research-two")), /prerequisite/)
  assert.equal(h.values.size, before)
  const first = await h.control.report(h.coordinator.id, readout("research-one"))
  assert.equal(first.mission.tasks[0].report?.delivery, "coordinator-readout")
  assert.equal(first.mission.tasks[0].report?.notificationStatus, undefined)
  assert.equal(first.mission.reports[0].notificationStatus, undefined)
  assert.equal(first.mission.tasks[0].report?.sessionId, h.coordinator.id)
  assert.equal(first.mission.tasks[0].report?.nativeCall, undefined)
  assert.equal(first.mission.tasks[0].actorSessionId, undefined)
  assert.equal(first.mission.tasks[0].nativeExecution, undefined)
  const repeated = await h.control.report(h.coordinator.id, readout("research-one"))
  assert.equal(repeated.disposition, "existing")
  assert.equal(repeated.mission.revision, first.mission.revision)
  await assert.rejects(h.control.report(h.coordinator.id, { ...readout("research-one"), summary: "Different" }), /immutable/)
  await h.control.report(h.coordinator.id, readout("research-two"))
  assert.deepEqual(await h.control.retryPendingNotifications(), { attempted: 0, failed: 0 })
  const final = await h.control.report(h.coordinator.id, { ...readout("research-two"), taskKey: undefined, final: true, missionID: mission.id })
  assert.equal(final.mission.status, "completed")
  assert.equal(final.mission.actors.length, 1)
  assert.equal(h.sideEffects(), 0)
})

test("coordinator readout remains ownership-fenced and cannot invent human decision proof", async () => {
  const h = harness("custom")
  await h.start()
  await h.control.declare(h.coordinator.id, task("research-one"))
  h.coordinator.location.directory = "/moved"
  await assert.rejects(h.control.report(h.coordinator.id, readout("research-one")), /admitted location/)
  h.coordinator.location.directory = "/repo"
  h.coordinator.parentID = "ses_another"
  await assert.rejects(h.control.report(h.coordinator.id, readout("research-one")), /root sessions/)
  assert.equal((await h.control.snapshot()).missions[0].reports.length, 0)
})

test("native Pocock business plan finishes from connected coordinator artifacts without invocation bindings", async () => {
  const h = harness("pocock-fix-bug")
  await h.start()
  const artifacts = {
    diagnostician: { kind: "diagnosis", feedbackLoop: { command: "test", redOutput: "red" }, minimizedRepro: "repro",
      confirmedHypothesis: "cause", evidence: "observed", rejectedHypotheses: [] },
    implementer: { kind: "fix", changedFiles: ["fix.ts"], regressionTest: { seam: "present", path: "fix.test.ts",
      command: "test", redObserved: true, greenObserved: true }, originalLoopGreen: true,
      debugInstrumentationRemoved: true, prevention: "regression" },
    "review-standards": { kind: "review", axis: "standards", verdict: "pass", findings: [] },
    "review-spec": { kind: "review", axis: "spec", verdict: "pass", findings: [] },
    resolver: { kind: "resolution", addressed: [], deferred: [], focusedChecks: [] },
    validator: { kind: "validation", checks: ["typecheck", "lint", "test", "build"].map(kind =>
      ({ kind, command: "test", status: "passed", summary: "green" })),
      focusedRegression: { command: "test regression", status: "passed", summary: "green" }, verdict: "green" },
  }
  const plan: Array<[keyof typeof artifacts, string[]]> = [
    ["diagnostician", []], ["implementer", ["diagnostician"]],
    ["review-standards", ["implementer"]], ["review-spec", ["implementer"]],
    ["resolver", ["review-standards", "review-spec"]], ["validator", ["resolver"]],
  ]
  for (const [role, blockedBy] of plan) {
    await h.control.declare(h.coordinator.id, { ...task(role, blockedBy), role,
      executionMode: { kind: "native", parentTaskKey: null, ...(role === "resolver" ? { reuseFromTaskKey: "implementer" } : {}) } })
    await assert.rejects(h.control.report(h.coordinator.id, readout(role)), /artifact|contract|Expected/i)
    await h.control.report(h.coordinator.id, { ...readout(role), artifact: artifacts[role] })
  }
  const finished = await h.control.report(h.coordinator.id, { ...readout("validator"), taskKey: undefined, final: true })
  assert.equal(finished.mission.status, "completed")
  assert.ok(finished.mission.tasks.every(task => !task.actorSessionId && !task.nativeBinding && !task.nativeExecution))
  assert.equal(h.sideEffects(), 0)
})

function harness(template: MissionTemplateId = "wayfinder") {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => values.get(key),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].sort().filter(key => key.startsWith(prefix) && (!after || key > after))
      return { entries: keys.slice(0, limit).map(key => ({ key, value: values.get(key)! })),
        ...(keys.length > limit ? { next: keys[limit - 1] } : {}) }
    },
  }
  const coordinator: NativeMissionSession = { id: "ses_coordinator", projectID: "project-test", title: "Coordinator", location: { directory: "/repo" } }
  let sideEffects = 0
  const sessions: MissionSessionAdapter = {
    get: async ({ sessionID }) => { if (sessionID !== coordinator.id) throw new Error("missing"); return structuredClone(coordinator) },
    create: async () => { sideEffects++; throw new Error("No birth from declaration") },
    prompt: async () => { sideEffects++; throw new Error("No prompt from declaration") },
    synthetic: async () => { sideEffects++; throw new Error("No wake from declaration") },
  }
  let now = 100
  const control = new MissionControl({ project: { id: "project-test", canonical: "/repo", location: { directory: "/repo" } },
    storage, sessions, now: () => now++ })
  const start = () => control.create({ requestID: "declaration-start", objective: "Discover a frontier", template, coordinatorSessionID: coordinator.id })
  return { control, coordinator, values, start, sideEffects: () => sideEffects }
}

test("new declarations persist explicit native mode with generation, without native mutations", async () => {
  const h = harness()
  const { mission } = await h.start()
  const first = await h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id })
  assert.equal(first.disposition, "declared")
  assert.deepEqual(first.contract, { missionID: mission.id, taskKey: "research-one", generation: 1 })
  assert.deepEqual(first.mission.tasks[0].executionMode, { kind: "native", parentTaskKey: null })
  assert.equal(first.mission.actors.length, 1)
  assert.equal(first.mission.tasks[0].actorSessionId, undefined)
  assert.equal(first.mission.tasks[0].admissionId, undefined)
  const repeated = await h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id })
  assert.equal(repeated.disposition, "existing")
  assert.equal(repeated.mission.revision, first.mission.revision)
  assert.equal(h.values.size, 2)
  assert.equal(h.sideEffects(), 0)
  await assert.rejects(h.control.delegate(h.coordinator.id, { ...task("research-one"), missionID: mission.id, delivery: "queue" }), /native subagent tool/)
  assert.equal(h.sideEffects(), 0)
})

test("declaration preserves execution choices and refuses conflicting task reuse", async () => {
  const h = harness()
  const { mission } = await h.start()
  const selected = { agent: "research-child", model: { providerID: "test", id: "reasoner", variant: "high" } }
  await h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id, execution: selected })
  await assert.rejects(h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id }), /different contract/)
  await assert.rejects(h.control.declare(h.coordinator.id, { ...task("research-two"), missionID: mission.id,
    executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "unknown-source" } }), /not a declared native task/)
  const snapshot = await h.control.snapshot()
  assert.deepEqual(snapshot.missions[0].tasks[0].execution, selected)
  assert.equal(snapshot.missions[0].tasks.length, 1)
  assert.equal(h.sideEffects(), 0)
})

test("planning exact future actor reuse does not require or create the source actor", async () => {
  const h = harness()
  const { mission } = await h.start()
  await h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id })
  const declared = await h.control.declare(h.coordinator.id, { ...task("research-next", ["research-one"]), missionID: mission.id,
    executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "research-one" } })
  assert.equal(declared.mission.tasks[1].status, "blocked")
  assert.equal(declared.mission.tasks[1].actorSessionId, undefined)
  assert.equal(declared.mission.actors.length, 1)
  assert.equal(h.sideEffects(), 0)
})

test("the full native Pocock frontier can be declared before any role executes", async () => {
  const h = harness("pocock-fix-bug")
  const { mission } = await h.start()
  const declare = (key: string, role: string, blockedBy: string[], reuseFromTaskKey?: string) => h.control.declare(h.coordinator.id, {
    ...task(key, blockedBy), missionID: mission.id, role,
    executionMode: { kind: "native", parentTaskKey: null, ...(reuseFromTaskKey ? { reuseFromTaskKey } : {}) },
  })
  await declare("diagnose", "diagnostician", [])
  await declare("fix", "implementer", ["diagnose"])
  await declare("standards", "review-standards", ["fix"])
  await declare("specification", "review-spec", ["fix"])
  await declare("resolve", "resolver", ["standards", "specification"], "fix")
  const last = await declare("validate", "validator", ["resolve"])
  assert.equal(last.mission.tasks.length, 6)
  assert.deepEqual(last.mission.frontier, ["diagnose"])
  assert.equal(last.mission.actors.length, 1)
  assert.ok(last.mission.tasks.every(task => task.contractGeneration === 1 && !task.actorSessionId && !task.admissionId))
  assert.equal(h.sideEffects(), 0)
})

test("one atomic additive revision can declare a native playbook in arbitrary row order", async () => {
  const h = harness("pocock-fix-bug")
  const { mission } = await h.start()
  const items = [
    { ...task("validate", ["resolve"]), role: "validator" },
    { ...task("resolve", ["standards", "specification"]), role: "resolver",
      executionMode: { kind: "native" as const, parentTaskKey: null, reuseFromTaskKey: "fix" } },
    { ...task("specification", ["fix"]), role: "review-spec" },
    { ...task("standards", ["fix"]), role: "review-standards" },
    { ...task("fix", ["diagnose"]), role: "implementer" },
    { ...task("diagnose"), role: "diagnostician" },
  ]
  const result = await h.control.revise(h.coordinator.id, { missionID: mission.id, requestID: "whole-frontier", expectedRevision: mission.revision,
    reason: "One coherent native evidence plan", retireTasks: [], addTasks: items, dependencyUpdates: [] })
  assert.equal(result.mission.tasks.length, 6)
  assert.deepEqual(result.mission.frontier, ["diagnose"])
  assert.equal(result.mission.actors.length, 1)
  assert.equal(h.sideEffects(), 0)
})

test("explicit independent declaration retains reason without root creation", async () => {
  const h = harness()
  const { mission } = await h.start()
  const executionMode = { kind: "independent" as const, reason: "location" as const, explanation: "Work in a separately approved Location" }
  const result = await h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id, executionMode })
  assert.deepEqual(result.mission.tasks[0].executionMode, executionMode)
  assert.equal(h.sideEffects(), 0)
})

test("additive revision advances the business journal, not unrelated task generations", async () => {
  const h = harness()
  const { mission } = await h.start()
  const declared = await h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id })
  const input = { missionID: mission.id, expectedRevision: declared.mission.revision, requestID: "new-fog", reason: "New sharp decision",
    retireTasks: [], addTasks: [task("research-two", ["research-one"])], dependencyUpdates: [] }
  const revised = await h.control.revise(h.coordinator.id, input)
  assert.equal(revised.mission.tasks.length, 2)
  assert.equal(revised.mission.tasks[0].contractGeneration, 1)
  assert.equal(revised.mission.tasks[1].contractGeneration, 1)
  assert.equal(revised.mission.tasks[1].replacesTaskKey, undefined)
  assert.deepEqual(revised.mission.tasks[1].executionMode, { kind: "native", parentTaskKey: null })
  assert.deepEqual(await h.control.revise(h.coordinator.id, input), revised)
  assert.equal(h.sideEffects(), 0)
})

test("mixed parent/dependency cycles, missing parents and retired references fail closed", () => {
  const planned = (key: string, parentTaskKey: string | null, blockedBy: string[] = []) => ({ key,
    executionMode: { kind: "native" as const, parentTaskKey }, blockedBy, status: "ready" as const })
  assert.throws(() => validateTaskAdmissionGraph([planned("parent", null, ["child"]), planned("child", "parent")]), /cycle/)
  assert.throws(() => validateTaskAdmissionGraph([planned("child", "unknown")]), /parent task/)
  assert.throws(() => validateTaskAdmissionGraph([{ ...planned("source", null, ["reuse"] ) },
    { ...planned("reuse", null), executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "source" } }]), /cycle/)
  assert.throws(() => validateTaskAdmissionGraph([{ ...planned("source", null),
    executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "source" } }]), /reuse itself/)
  assert.throws(() => validateTaskAdmissionGraph([{ ...planned("parent", null), status: "withdrawn" }, planned("child", "parent")]), /parent task/)
  validateTaskAdmissionGraph([planned("parent", null), planned("child", "parent"), planned("sibling", null)])
})

test("coordinator-only declarations reject moved and child callers without writes", async () => {
  const h = harness()
  const { mission } = await h.start()
  h.coordinator.location.workspaceID = "moved-workspace"
  await assert.rejects(h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id }), /moved/)
  h.coordinator.location.workspaceID = undefined
  h.coordinator.parentID = "ses_unrelated"
  await assert.rejects(h.control.declare(h.coordinator.id, { ...task("research-one"), missionID: mission.id }), /root sessions only/)
  assert.equal(h.values.size, 1)
  assert.equal(h.sideEffects(), 0)
})

test("declaration and contract references reject privilege-shaped extra fields", () => {
  assert.throws(() => normalizeTaskDeclaration({ ...task("research-one"), generation: 99 }))
  assert.throws(() => normalizeTaskDeclaration({ ...task("research-one"), targetSessionID: "ses_sibling" }))
  assert.throws(() => normalizeTaskDeclaration({ ...task("research-one"), executionMode: { kind: "native", parentTaskKey: null, epoch: 7 } }))
  assert.throws(() => taskContractReferenceSchema.parse({ missionID: "mission-test", taskKey: "research-one", revision: 1 }))
  assert.throws(() => taskContractReferenceSchema.parse({ missionID: "mission-test", taskKey: "research-one", generation: Number.MAX_SAFE_INTEGER + 1 }))
  assert.deepEqual(normalizeTaskDeclaration(task("research-one", ["zz", "aa", "zz"])).blockedBy, ["aa", "zz"])
})
