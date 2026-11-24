import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { reduceMissionEvents, type MissionEvent, type MissionJsonValue, type MissionNativeBinding, type MissionRevisedEvent } from "./model"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) { values.set(key, structuredClone(value)) },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...values.keys()].filter(key => key.startsWith(`${prefix}/`) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  }
  const journal = new MissionJournal(storage, "project", "/owned/project", () => 10_000)
  let clock = 0
  const base = () => ({ version: 1 as const, id: `evt_${++clock}`, missionID: "msn_generation", projectID: "project", createdAt: clock })
  const created = (): MissionEvent => ({ ...base(), type: "mission.created", objective: "Task-local generations",
    projectCanonical: "/owned/project", template: "custom",
    coordinator: { sessionID: "ses_parent", title: "Coordinator", location: { directory: "/owned/project" } } })
  const task = (key = "work", blockedBy: string[] = []): Extract<MissionEvent, { type: "task.created" }> => ({
    ...base(), type: "task.created", task: { id: `tsk_${key}`, key, title: key, brief: "Work", role: "worker", blockedBy },
  })
  const revise = (dependencyUpdates: MissionRevisedEvent["dependencyUpdates"] = []): MissionRevisedEvent => ({
    ...base(), type: "mission.revised", requestID: `req_${clock}`, expectedRevision: clock - 1, actorSessionID: "ses_parent",
    reason: "Plan edit", notesSpecified: false, addedTasks: [], retiredTasks: [], dependencyUpdates,
  })
  const binding = (generation = 1, suffix = "work"): MissionNativeBinding => ({ generation,
    parentSessionID: "ses_parent", toolCallID: `call_${suffix}`, parentMessageID: `msg_${suffix}` })
  const bound = (generation = 1, key = "work"): MissionEvent => ({ ...base(), type: "task.native-bound", taskKey: key,
    actor: { sessionID: `ses_${key}`, title: key, managed: true, location: { directory: "/owned/project" } }, binding: binding(generation, key) })
  const report = (key = "work", late = false): MissionEvent => {
    const event = base()
    return { ...event, type: "task.reported", report: { id: `rpt_${clock}`, taskKey: key, sessionId: `ses_${key}`,
      outcome: "completed", summary: "Explicit report", evidence: [], next: [], createdAt: clock, ...(late ? { late: true } : {}) } }
  }
  const snapshot = () => journal.snapshot()
  const work = async (key = "work") => (await snapshot()).missions[0].tasks.find(task => task.key === key)!
  return { journal, values, base, created, task, revise, binding, bound, report, snapshot, work }
}

test("initial and revision-added tasks always project generation 1 without writing a declaration generation", async () => {
  const f = fixture(); await f.journal.append(f.created())
  const initial = f.task(); await f.journal.append(initial)
  const event = f.revise()
  event.retiredTasks = [{ taskKey: "work", replacementTaskKey: "replacement" }]
  event.addedTasks = [{ ...initial.task, id: "tsk_replacement", key: "replacement", replacesTaskKey: "work" }]
  await f.journal.append(event)
  const tasks = (await f.snapshot()).missions[0].tasks
  assert.deepEqual(tasks.map(task => task.contractGeneration), [1, 1])
  assert.equal(tasks[0].status, "withdrawn")
  const stored = (await f.journal.events()).events
  assert.ok(stored.every(event => event.type !== "task.created" || !Object.prototype.hasOwnProperty.call(event.task, "contractGeneration")))
  assert.ok(stored.every(event => event.type !== "mission.revised" || event.addedTasks.every(task => !Object.prototype.hasOwnProperty.call(task, "contractGeneration"))))
})

test("additive discovery projects generation 1 without a fabricated replacement or revoking existing tasks", async () => {
  const f = fixture(); await f.journal.append(f.created()); await f.journal.append(f.task()); await f.journal.append(f.bound())
  const before = await f.work(), revision = f.revise()
  revision.addedTasks = [{ ...f.task("discovered").task, executionMode: { kind: "native", parentTaskKey: null } }]
  await f.journal.append(revision)
  const loaded = await f.journal.event(revision.missionID, revision.id)
  assert.equal(loaded?.type, "mission.revised")
  if (loaded?.type === "mission.revised") assert.equal(Object.prototype.hasOwnProperty.call(loaded.addedTasks[0], "replacesTaskKey"), false)
  assert.deepEqual(await f.work(), before)
  const discovered = await f.work("discovered")
  assert.equal(discovered.contractGeneration, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(discovered, "replacesTaskKey"), false)
  assert.deepEqual(discovered.executionMode, { kind: "native", parentTaskKey: null })
  assert.equal((await f.snapshot()).discardedEvents, 0)
  for (const replacesTaskKey of [null, "", 1, "x".repeat(241)]) {
    assert.equal(parseMissionEvent({ ...revision, addedTasks: [{ ...revision.addedTasks[0], replacesTaskKey }] }), undefined)
  }
})

test("effective normalized dependency changes increment only their unassigned ready/blocked task", async () => {
  const f = fixture(); await f.journal.append(f.created()); await f.journal.append(f.task()); await f.journal.append(f.task("sibling"))
  await f.journal.append(f.revise([{ taskKey: "work", blockedBy: ["sibling", "sibling"] }]))
  assert.equal((await f.work()).contractGeneration, 2)
  assert.equal((await f.work()).status, "blocked")
  assert.deepEqual((await f.work()).blockedBy, ["sibling"])
  assert.equal((await f.work("sibling")).contractGeneration, 1)
  await f.journal.append(f.revise([{ taskKey: "work", blockedBy: ["sibling"] }]))
  assert.equal((await f.work()).contractGeneration, 2)
  await f.journal.append(f.revise([{ taskKey: "work", blockedBy: [] }]))
  assert.equal((await f.work()).contractGeneration, 3)
  assert.equal((await f.work()).status, "ready")
  await f.journal.append(f.bound(1))
  await f.journal.append(f.bound(2))
  assert.equal((await f.work()).nativeBinding, undefined)
  await f.journal.append(f.bound(3))
  assert.equal((await f.work()).nativeBinding?.generation, 3)
  assert.equal((await f.snapshot()).discardedEvents, 2)
})

test("empty/no-op/reordered dependencies, objective/notes, sibling reports and unrelated revisions do not revoke", async () => {
  const f = fixture(); await f.journal.append(f.created()); await f.journal.append(f.task("work", ["first", "second"]))
  await f.journal.append(f.task("first")); await f.journal.append(f.task("second")); await f.journal.append(f.task("empty"))
  await f.journal.append(f.revise([{ taskKey: "work", blockedBy: ["second", "first", "second"] }, { taskKey: "empty", blockedBy: [] }]))
  await f.journal.append({ ...f.base(), type: "mission.updated", requestID: "req_notes", expectedRevision: 6,
    objective: "Changed objective", notesSpecified: true, notes: "Changed notes" })
  const revision = f.revise(); revision.objective = "Coordinator objective"; revision.notesSpecified = true; revision.notes = "Coordinator notes"
  await f.journal.append(revision)
  await f.journal.append(f.bound(1, "first")); await f.journal.append(f.report("first"))
  await f.journal.append(f.bound(1, "second")); await f.journal.append(f.report("second"))
  assert.equal((await f.work()).contractGeneration, 1)
  assert.deepEqual((await f.work()).blockedBy, ["first", "second"], "no-op retains the original normalized order")
  assert.equal((await f.work("empty")).contractGeneration, 1)
  await f.journal.append(f.bound())
  assert.equal((await f.work()).nativeBinding?.generation, 1)
  assert.equal((await f.snapshot()).discardedEvents, 0)
})

test("forged task generations reject both decoder paths and cannot override direct reducer projection", async () => {
  const f = fixture(), created = f.created(), initial = f.task(), revision = f.revise()
  revision.addedTasks = [{ ...initial.task, id: "tsk_replacement", key: "replacement", replacesTaskKey: "work" }]
  for (const contractGeneration of [undefined, 0, -1, 1, 2, 1.5, "2", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    const first = { ...initial, task: { ...initial.task, contractGeneration } }
    const added = { ...revision, addedTasks: [{ ...revision.addedTasks[0], contractGeneration }] }
    assert.equal(parseMissionEvent(first), undefined)
    assert.equal(parseMissionEvent(added), undefined)
    if (contractGeneration !== undefined && Number.isFinite(contractGeneration)) {
      await assert.rejects(f.journal.append(first as MissionEvent), /not durable JSON/)
      await assert.rejects(f.journal.append(added as MissionEvent), /not durable JSON/)
    }
    const tasks = reduceMissionEvents([created, first as MissionEvent, added as MissionEvent]).missions[0].tasks
    assert.deepEqual(tasks.map(task => task.contractGeneration), [1, 1])
    assert.ok(tasks.every(task => Number.isSafeInteger(task.contractGeneration) && task.contractGeneration! > 0))
  }
  assert.equal(f.values.size, 0)
  assert.equal(parseMissionEvent({ ...revision, dependencyUpdates: [{ taskKey: "work", blockedBy: [], contractGeneration: 2 }] }), undefined)
})

for (const assignment of ["native", "root"] as const) {
  test(`hostile dependency edits after ${assignment} assignment are discarded without changing binding/generation`, async () => {
    const f = fixture(); await f.journal.append(f.created()); await f.journal.append(f.task())
    if (assignment === "native") await f.journal.append(f.bound())
    else await f.journal.append({ ...f.base(), type: "task.dispatching", taskKey: "work", admissionID: "msg_admission", delivery: "queue",
      actor: { sessionID: "ses_work", title: "work", managed: true, location: { directory: "/owned/project" } } })
    const before = await f.work()
    await f.journal.append(f.revise([{ taskKey: "work", blockedBy: ["missing"] }]))
    assert.deepEqual(await f.work(), before)
    assert.equal((await f.snapshot()).discardedEvents, 1)
    if (assignment === "native") {
      await f.journal.append({ ...f.base(), type: "task.native-call-ended", taskKey: "work", childSessionID: "ses_work", binding: f.binding(), outcome: "returned" })
      const ended = await f.work()
      await f.journal.append({ ...f.base(), type: "task.native-call-started", taskKey: "work", childSessionID: "ses_work", binding: f.binding(2, "forged") })
      assert.deepEqual(await f.work(), ended)
      await f.journal.append({ ...f.base(), type: "task.native-call-started", taskKey: "work", childSessionID: "ses_work", binding: f.binding(1, "continue") })
      assert.deepEqual((await f.work()).nativeExecution, { binding: f.binding(1, "continue") })
      assert.equal((await f.work()).contractGeneration, 1)
    }
  })
}

test("retirement preserves original native binding/report history and replacements start a fresh generation", async () => {
  const f = fixture(); await f.journal.append(f.created()); await f.journal.append(f.task()); await f.journal.append(f.bound())
  const before = await f.work(), revision = f.revise()
  revision.retiredTasks = [{ taskKey: "work", replacementTaskKey: "replacement" }]
  revision.addedTasks = [{ ...f.task().task, id: "tsk_replacement", key: "replacement", replacesTaskKey: "work" }]
  revision.dependencyUpdates = [{ taskKey: "work", blockedBy: ["missing"] }]
  await f.journal.append(revision); await f.journal.append(f.report("work", true))
  const work = await f.work()
  assert.deepEqual(work.nativeBinding, before.nativeBinding)
  assert.equal(work.contractGeneration, 1)
  assert.deepEqual(work.blockedBy, [])
  assert.equal(work.status, "withdrawn")
  assert.equal(work.lateReports?.length, 1)
  assert.equal(work.outstandingExecution, false)
  assert.equal((await f.work("replacement")).contractGeneration, 1)
  assert.equal((await f.work("replacement")).nativeBinding, undefined)
  assert.equal((await f.snapshot()).discardedEvents, 1)
})
