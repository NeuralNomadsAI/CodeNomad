import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent, type MissionStorage } from "./journal"
import { reduceMissionEvents, type MissionEvent, type MissionJsonValue } from "./model"
import { parseExecutionMode, sameExecutionMode, type MissionTaskExecutionMode } from "./task-execution-mode"

const native: MissionTaskExecutionMode = { kind: "native", parentTaskKey: null }
const nested: MissionTaskExecutionMode = { kind: "native", parentTaskKey: "parent.work", reuseFromTaskKey: "previous-work" }
const independent: MissionTaskExecutionMode = { kind: "independent", reason: "location", explanation: "Requires another owned directory." }
const base = { version: 1 as const, missionID: "msn_mode", projectID: "project" }
const created: MissionEvent = { ...base, id: "evt_mission", createdAt: 1, type: "mission.created",
  projectCanonical: "/owned/project", objective: "Execution descriptors", template: "custom",
  coordinator: { sessionID: "ses_parent", title: "Coordinator", location: { directory: "/owned/project" } } }
const task = (executionMode?: MissionTaskExecutionMode): Extract<MissionEvent, { type: "task.created" }> => ({
  ...base, id: "evt_task", createdAt: 2, type: "task.created", task: { id: "tsk_work", key: "work", title: "Work",
    brief: "Business work", role: "worker", blockedBy: [], ...(executionMode === undefined ? {} : { executionMode }) },
})
const revision = (executionMode?: MissionTaskExecutionMode): Extract<MissionEvent, { type: "mission.revised" }> => ({
  ...base, id: "evt_revision", createdAt: 3, type: "mission.revised", requestID: "req_replace", expectedRevision: 2,
  actorSessionID: "ses_parent", reason: "Replace work", notesSpecified: false,
  retiredTasks: [{ taskKey: "work", replacementTaskKey: "replacement" }], dependencyUpdates: [],
  addedTasks: [{ ...task(executionMode).task, id: "tsk_replacement", key: "replacement", replacesTaskKey: "work" }],
})

function memoryJournal() {
  const values = new Map<string, MissionJsonValue>(), reads: string[] = []
  const storage: MissionStorage = {
    async get(key) { reads.push(key); return structuredClone(values.get(key)) },
    async set(key, value) { values.set(key, structuredClone(value)) },
    async scan({ prefix, after, limit = 100 }) {
      reads.push(prefix)
      const keys = [...values.keys()].filter(key => key.startsWith(`${prefix}/`) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  }
  return { values, reads, journal: new MissionJournal(storage, "project", "/owned/project", () => 100) }
}

test("strict execution codec preserves absence and compares explicit choices without defaults", () => {
  assert.equal(parseExecutionMode(undefined), undefined)
  assert.equal(sameExecutionMode(undefined, undefined), true)
  assert.equal(sameExecutionMode(undefined, native), false)
  for (const mode of [native, nested, independent]) {
    const parsed = parseExecutionMode(mode)
    assert.deepEqual(parsed, mode)
    assert.notEqual(parsed, mode)
    assert.equal(sameExecutionMode(parsed, mode), true)
  }
  assert.equal(sameExecutionMode(native, nested), false)
  assert.equal(sameExecutionMode(native, independent), false)
  assert.equal(sameExecutionMode(nested, { ...nested, reuseFromTaskKey: "another" }), false)
  assert.equal(sameExecutionMode(independent, { ...independent, reason: "lifetime" }), false)
  assert.equal(sameExecutionMode(independent, { ...independent, explanation: "Changed reason" }), false)
})

test("bounded wrapper task refs and all explicit independent reasons roundtrip", () => {
  assert.deepEqual(parseExecutionMode({ kind: "native", parentTaskKey: "a".repeat(64), reuseFromTaskKey: "a-" }),
    { kind: "native", parentTaskKey: "a".repeat(64), reuseFromTaskKey: "a-" })
  for (const reason of ["location", "lifetime", "existing-root", "playbook"] as const) {
    const mode = { kind: "independent" as const, reason, explanation: "x".repeat(2_000) }
    assert.deepEqual(parseExecutionMode(mode), mode)
  }
})

const malformed: unknown[] = [null, false, [], "native", {}, { kind: "other" },
  { kind: "native" }, { kind: "native", parentTaskKey: 1 },
  ...["", "a", "A-work", "a work", "a\u0000", "a".repeat(65)].map(parentTaskKey => ({ kind: "native", parentTaskKey })),
  { ...native, reuseFromTaskKey: null }, { ...native, reuseFromTaskKey: "x" },
  { ...native, reason: "location" }, { ...native, execution: {} }, { ...native, contractGeneration: 1 },
  { kind: "independent", explanation: "Must be explicit" },
  { ...independent, reason: "default" }, { ...independent, explanation: "" }, { ...independent, explanation: " \n\t" },
  { ...independent, explanation: "x".repeat(2_001) }, { ...independent, explanation: 1 },
  { ...independent, parentTaskKey: null }, { ...independent, admissionID: "forged" },
]

test("malformed or extra descriptor fields reject both event task paths rather than strip signed fields", async () => {
  const f = memoryJournal()
  for (const mode of malformed) {
    assert.throws(() => parseExecutionMode(mode))
    const initial = { ...task(), task: { ...task().task, executionMode: mode } }
    const revised = revision()
    const replacement = { ...revised, addedTasks: [{ ...revised.addedTasks[0], executionMode: mode }] }
    for (const event of [initial, replacement]) {
      assert.equal(parseMissionEvent(event), undefined)
      await assert.rejects(f.journal.append(event as MissionEvent), /not durable JSON/)
    }
  }
  assert.equal(f.values.size, 0)
})

test("actual journal persists initial/replacement descriptors with agent/model selection kept separate", async () => {
  for (const mode of [undefined, native, nested, independent]) {
    const f = memoryJournal(), initial = task(mode), replacement = revision(mode)
    initial.task.execution = { agent: "worker", model: { providerID: "provider", id: "model", variant: "fast" } }
    await f.journal.append(created); await f.journal.append(initial); await f.journal.append(replacement)
    assert.deepEqual(await f.journal.event(initial.missionID, initial.id), initial)
    const loaded = await f.journal.event(replacement.missionID, replacement.id)
    assert.equal(loaded?.type, "mission.revised")
    if (loaded?.type === "mission.revised") assert.deepEqual(loaded.addedTasks, replacement.addedTasks)
    const snapshot = await f.journal.snapshot(), mission = snapshot.missions[0]
    assert.deepEqual(mission.tasks.map(task => task.executionMode), [mode, mode])
    assert.deepEqual(mission.tasks[0].execution, initial.task.execution)
    assert.equal(mission.actors.length, 1)
    assert.deepEqual(mission.claims, [])
    assert.equal(snapshot.discardedEvents, 0)
    if (mode === undefined) {
      assert.equal(Object.prototype.hasOwnProperty.call(mission.tasks[0], "executionMode"), false)
      assert.equal(Object.prototype.hasOwnProperty.call(mission.tasks[1], "executionMode"), false)
    }
    assert.ok(f.reads.every(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/`)), "no alternate/legacy namespace reads")
  }
})

test("native-bound respects explicit independent mode; missing mode remains accepted without root admission side effects", () => {
  const bound: MissionEvent = { ...base, id: "evt_bound", createdAt: 3, type: "task.native-bound", taskKey: "work",
    actor: { sessionID: "ses_child", title: "Child", managed: true, location: { directory: "/owned/project" } },
    binding: { generation: 1, parentSessionID: "ses_parent", toolCallID: "call_work", parentMessageID: "msg_work" } }
  for (const mode of [undefined, native, independent]) {
    const snapshot = reduceMissionEvents([created, task(mode), bound]), mission = snapshot.missions[0], work = mission.tasks[0]
    assert.equal(work.actorSessionId, mode?.kind === "independent" ? undefined : "ses_child")
    assert.equal(work.admissionId, undefined)
    assert.equal(work.delivery, undefined)
    assert.equal(snapshot.discardedEvents, mode?.kind === "independent" ? 1 : 0)
    assert.equal(mission.actors.length, mode?.kind === "independent" ? 1 : 2)
  }
})

test("dependency updates cannot mutate a task execution descriptor", () => {
  const event = revision()
  for (const executionMode of [native, independent]) {
    assert.equal(parseMissionEvent({ ...event, dependencyUpdates: [{ taskKey: "work", blockedBy: [], executionMode }] }), undefined)
  }
})
