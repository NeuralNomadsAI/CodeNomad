import assert from "node:assert/strict"
import test from "node:test"
import type { SessionLogOutput, SessionMessageGetOutput, SessionToolCalled, SessionToolSuccess } from "@opencode/client"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { type MissionEvent, type MissionJsonValue, type MissionTaskNativeCallObservedEvent } from "./model"
import { hasUnsettledNativeExecution, type NativeCallReadClient, type NativeCallObservation } from "./native-call-observation"
import { nativeCallObservationID, reconcileNativeCallObservation, type NativeCallReconciliationProof, type NativeCallReconciliationTarget,
  type NativeObservationPublisher } from "./native-call-reconciliation"

async function fixture(background = false) {
  const values = new Map<string, MissionJsonValue>(), storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) { values.set(key, structuredClone(value)) },
    async scan({ prefix }) { return { entries: [...values].filter(([key]) => key.startsWith(`${prefix}/`)).map(([key, value]) => ({ key, value: structuredClone(value) })) } },
  }
  const journal = new MissionJournal(storage, "project", "/owned/project", () => 500)
  const binding = { generation: 1, parentSessionID: "ses_parent", parentMessageID: "msg_parent", toolCallID: "call_child" }
  const target: NativeCallReconciliationTarget = { projectID: "project", missionID: "msn_observe", taskKey: "work", binding,
    childSessionID: "ses_child", toolName: "subagent", callCreatedAt: 3 }
  const proof: NativeCallReconciliationProof = { ...target, nativeIncarnation: "native_incarnation", storageIdentity: "owned_storage", familyIdentity: "owned_family" }
  const base = (id: string, createdAt: number) => ({ version: 1 as const, missionID: target.missionID, projectID: target.projectID, id, createdAt })
  const location = { directory: "/owned/project" }
  await journal.append({ ...base("evt_created", 1), type: "mission.created", objective: "Observation-only", projectCanonical: location.directory,
    template: "custom", coordinator: { sessionID: "ses_parent", title: "Coordinator", location } })
  await journal.append({ ...base("evt_task", 2), type: "task.created", task: { id: "tsk_work", key: "work", title: "Work", brief: "Work", role: "worker",
    blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } } })
  await journal.append({ ...base("evt_bound", 3), type: "task.native-bound", taskKey: "work", actor: { sessionID: "ses_child", title: "Child", managed: true, location }, binding })
  const metadata = { sessionID: "ses_child", ...(background ? { status: "running" } : {}) }
  const called: SessionToolCalled = { type: "session.tool.called", id: "native_called", created: 10, durable: { aggregateID: "agg_parent", seq: 1, version: 1 },
    data: { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child", input: { background }, executed: false } }
  const success: SessionToolSuccess = { type: "session.tool.success", id: "native_success", created: 11, durable: { aggregateID: "agg_parent", seq: 2, version: 2 },
    data: { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child", metadata, executed: false, content: [{ type: "text", text: "Native result" }] } }
  const logs = new Map<string, SessionLogOutput[]>([["ses_parent", [called, success]], ["ses_child", []]])
  const message: SessionMessageGetOutput = { type: "assistant", id: "msg_parent", time: { created: 9 }, agent: "parent", model: { providerID: "provider", id: "parent" },
    content: [{ type: "tool", id: "call_child", name: "subagent", executed: false, time: { created: 9, completed: 11 },
      state: { status: "completed", input: { background }, metadata, content: [{ type: "text", text: "Native result" }] } }] }
  let reads = 0, writes = 0, validateCount = 0
  let duringRead: (() => void) | undefined, duringAppend: (() => void) | undefined
  const client: NativeCallReadClient = {
    message: { async get() { reads++; duringRead?.(); return structuredClone(message) } },
    async *log(input) {
      reads++
      const rows = logs.get(input.sessionID) ?? []
      for (const event of rows) if (event.type === "log.synced" || event.durable.seq > (input.after ?? 0)) yield structuredClone(event)
      const last = rows.at(-1)
      yield { type: "log.synced", aggregateID: input.sessionID === "ses_parent" ? "agg_parent" : "agg_child", seq: last && last.type !== "log.synced" ? last.durable.seq : 0 }
    },
  }
  const validate = async () => { validateCount++; return structuredClone(proof) }
  const publisher: NativeObservationPublisher = {
    event: (missionID, eventID) => journal.event(missionID, eventID),
    async append(event, expected) {
      // Real admission must combine this fence with the authenticated journal writer.
      duringAppend?.()
      assert.deepEqual(proof, expected)
      const latest = Math.max(...(await journal.events()).events.map(event => event.createdAt))
      assert.deepEqual(proof, expected)
      writes++; await journal.append({ ...event, createdAt: latest + 1 })
    },
  }
  const input = () => ({ target, client, expectedProof: structuredClone(proof), validate, publisher, signal: AbortSignal.timeout(5_000) })
  const task = async () => (await journal.snapshot()).missions[0].tasks[0]
  const observedEvent = (observation: NativeCallObservation): MissionTaskNativeCallObservedEvent => ({ ...base(nativeCallObservationID(target, observation), 3 + observation.source.seq),
    type: "task.native-call-observed", taskKey: "work", childSessionID: "ses_child", binding, observation })
  return { journal, values, target, proof, client, publisher, input, task, called, success, logs, message, observedEvent, base, location,
    counts: () => ({ reads, writes, validateCount }), duringRead: (callback: () => void) => { duringRead = callback }, duringAppend: (callback: () => void) => { duringAppend = callback } }
}

test("default reconciliation is read-only; explicit durable publication survives a missing wrapper receipt and is idempotent", async () => {
  const f = await fixture(), before = f.values.size
  const read = await reconcileNativeCallObservation(f.input())
  assert.equal(read.complete, true)
  assert.equal(read.published, 0)
  assert.equal(f.values.size, before)
  assert.equal((await f.task()).nativeExecution?.ended, undefined)
  const published = await reconcileNativeCallObservation({ ...f.input(), publish: true })
  assert.equal(published.published, 2)
  assert.equal((await f.task()).nativeExecution?.ended, "returned")
  assert.equal((await f.task()).report, undefined)
  assert.equal((await f.task()).admissionId, undefined)
  const retry = await reconcileNativeCallObservation({ ...f.input(), publish: true })
  assert.equal(retry.existing, 2)
  assert.equal(retry.published, 0)
  assert.equal(retry.complete, true)
  assert.equal(f.counts().writes, 2)
  assert.equal((await f.journal.events()).events.some(event => event.type === "report.notified" || event.type === "task.dispatching"), false)
})

test("bounded cursor passes retain exact durable facts without treating a partial read as complete", async () => {
  const f = await fixture()
  const first = await reconcileNativeCallObservation({ ...f.input(), publish: true, maxEvents: 1 })
  assert.equal(first.complete, false)
  assert.equal(first.published, 1)
  assert.equal((await f.task()).nativeExecution?.launch?.state, "called")
  const second = await reconcileNativeCallObservation({ ...f.input(), publish: true, maxEvents: 1, parentCursor: first.parentCursor, childCursor: first.childCursor })
  assert.equal(second.complete, false)
  assert.equal(second.published, 1)
  const third = await reconcileNativeCallObservation({ ...f.input(), publish: true, maxEvents: 1, parentCursor: second.parentCursor, childCursor: second.childCursor })
  assert.equal(third.complete, true)
  assert.equal(third.published, 0)
})

test("native aggregate sequences remain evidence, never future mission timestamps", async () => {
  const f = await fixture(); f.called.durable.seq = 100_000; f.success.durable.seq = 100_001
  const result = await reconcileNativeCallObservation({ ...f.input(), publish: true, parentCursor: { aggregateID: "agg_parent", after: 99_999 } })
  assert.equal(result.published, 2)
  assert.equal((await f.task()).updatedAt, 5)
  assert.equal((await f.task()).nativeExecution?.observations?.at(-1)?.source.seq, 100_001)
})

test("business report before/after foreground observation remains independent of executor outcome and notification", async () => {
  for (const before of [false, true]) {
    const f = await fixture()
    const report: MissionEvent = { ...f.base("evt_business", before ? 4 : 10), type: "task.reported", report: { id: "rpt_work", taskKey: "work",
      sessionId: "ses_child", nativeCall: f.target.binding, delivery: "native-return", outcome: "completed", summary: "Business report", evidence: [], next: [], createdAt: before ? 4 : 10 } }
    if (before) { await f.journal.append(report); assert.equal(hasUnsettledNativeExecution(await f.task()), true) }
    await reconcileNativeCallObservation({ ...f.input(), publish: true })
    if (!before) await f.journal.append(report)
    assert.equal((await f.task()).report?.notificationStatus, "pending")
    assert.equal((await f.task()).nativeExecution?.ended, "returned")
    assert.equal((await f.task()).status, "completed")
    assert.equal(hasUnsettledNativeExecution(await f.task()), false)
  }
})

for (const field of ["nativeIncarnation", "storageIdentity", "familyIdentity"] as const) {
  test(`a raced ${field} fence denies publication/checkpoints without invoking or repairing anything`, async () => {
    const f = await fixture(), input = f.input()
    f.duringRead(() => { f.proof[field] += "_changed" })
    const result = await reconcileNativeCallObservation({ ...input, publish: true })
    assert.equal(result.complete, false)
    assert.equal(result.published, 0)
    assert.equal(result.parentCursor, undefined)
    assert.equal(f.values.size, 3)
  })
}

test("generation/current-call races and mutable request aliases cannot retarget prepared observations", async () => {
  const f = await fixture(), input = f.input()
  f.duringRead(() => { f.target.binding.generation = 2; f.proof.binding.generation = 2; input.expectedProof.binding.generation = 2 })
  const result = await reconcileNativeCallObservation({ ...input, publish: true })
  assert.equal(result.complete, false)
  assert.equal(result.published, 0)
  assert.equal(f.counts().writes, 0)
})

test("mutable caller options cannot turn a read-only pass into explicit publication mid-read", async () => {
  const f = await fixture(), input = { ...f.input(), publish: false }
  f.duringRead(() => { input.publish = true })
  const result = await reconcileNativeCallObservation(input)
  assert.equal(result.complete, true)
  assert.equal(result.published, 0)
  assert.equal(f.counts().writes, 0)
})

test("publisher's final admission fence closes an async append race", async () => {
  const f = await fixture(), input = f.input()
  f.duringAppend(() => { f.proof.storageIdentity = "new_storage" })
  const result = await reconcileNativeCallObservation({ ...input, publish: true })
  assert.equal(result.complete, false)
  assert.equal(result.published, 0)
  assert.equal(f.values.size, 3)
})

test("logical IDs use actual native source identity; changed source facts conflict rather than fabricate another receipt", async () => {
  const f = await fixture(); await reconcileNativeCallObservation({ ...f.input(), publish: true })
  f.success.created++
  const result = await reconcileNativeCallObservation({ ...f.input(), publish: true })
  assert.equal(result.complete, false)
  assert.equal(result.published, 0)
  assert.ok(result.reasons.includes("native-publication-conflict-or-authority-unknown"))
  assert.equal(f.counts().writes, 2)
})

test("background launch never settles on report or legacy tool-end; retired work retains unknown child execution", async () => {
  const f = await fixture(true)
  await reconcileNativeCallObservation({ ...f.input(), publish: true })
  assert.equal((await f.task()).nativeExecution?.ended, undefined)
  await f.journal.append({ ...f.base("evt_report", 10), type: "task.reported", report: { id: "rpt_work", taskKey: "work", sessionId: "ses_child",
    nativeCall: f.target.binding, delivery: "native-return", outcome: "completed", summary: "Business result", evidence: [], next: [], createdAt: 10 } })
  await f.journal.append({ ...f.base("evt_old_end", 11), type: "task.native-call-ended", taskKey: "work", childSessionID: "ses_child", binding: f.target.binding, outcome: "returned" })
  await f.journal.append({ ...f.base("evt_retire", 12), type: "mission.revised", requestID: "req_retire", expectedRevision: 7, actorSessionID: "ses_parent",
    reason: "Retire business task", notesSpecified: false, retiredTasks: [{ taskKey: "work" }], addedTasks: [], dependencyUpdates: [] })
  const task = await f.task()
  assert.equal(task.status, "withdrawn")
  assert.equal(task.outstandingExecution, true)
  assert.equal(hasUnsettledNativeExecution(task), true)
  assert.equal(task.nativeBinding?.nativeReturned, undefined)
  assert.equal(task.report?.notificationStatus, "pending")
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
})

test("late foreground error/return observations survive retirement and Stop without replay or business outcome invention", async () => {
  for (const stop of [false, true]) {
    const f = await fixture()
    if (stop) await f.journal.append({ ...f.base("evt_stop", 6), type: "mission.control-requested", requestID: "req_stop", expectedRevision: 3,
      action: "stop", targets: [{ sessionID: "ses_child", location: f.location }] })
    else await f.journal.append({ ...f.base("evt_retire", 6), type: "mission.revised", requestID: "req_retire", expectedRevision: 3,
      actorSessionID: "ses_parent", reason: "Retire", notesSpecified: false, retiredTasks: [{ taskKey: "work" }], addedTasks: [], dependencyUpdates: [] })
    const observation: NativeCallObservation = { kind: "tool-ended", mode: "foreground", outcome: "error",
      source: { id: "native_late", sessionID: "ses_parent", aggregateID: "agg_parent", seq: 10, created: 20 } }
    await f.journal.append(f.observedEvent(observation))
    assert.equal((await f.task()).nativeExecution?.ended, "error")
    assert.equal((await f.task()).outstandingExecution, false)
    assert.equal((await f.task()).status, "withdrawn")
    assert.equal((await f.task()).report, undefined)
    assert.equal(f.counts().reads, 0)
  }
})

test("an older invocation's observation cannot settle a new continuation; original binding remains immutable", async () => {
  const f = await fixture(); await reconcileNativeCallObservation({ ...f.input(), publish: true })
  const original = (await f.task()).nativeBinding
  const next = { ...f.target.binding, toolCallID: "call_next", parentMessageID: "msg_next" }
  await f.journal.append({ ...f.base("evt_start", 10), type: "task.native-call-started", taskKey: "work", childSessionID: "ses_child", binding: next })
  const stale: NativeCallObservation = { kind: "tool-ended", mode: "foreground", outcome: "error",
    source: { id: "native_stale", sessionID: "ses_parent", aggregateID: "agg_parent", seq: 20, created: 20 } }
  await f.journal.append(f.observedEvent(stale))
  const task = await f.task()
  assert.deepEqual(task.nativeBinding, original)
  assert.deepEqual(task.nativeExecution, { binding: next })
  assert.equal(hasUnsettledNativeExecution(task), true)
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
})

test("late background evidence fences an earlier legacy end and cannot admit a new continuation", async () => {
  const f = await fixture(true)
  await f.journal.append({ ...f.base("evt_old_end", 4), type: "task.native-call-ended", taskKey: "work", childSessionID: "ses_child",
    binding: f.target.binding, outcome: "returned" })
  const original = (await f.task()).nativeBinding
  await reconcileNativeCallObservation({ ...f.input(), publish: true })
  assert.equal(hasUnsettledNativeExecution(await f.task()), true)
  assert.equal((await f.task()).nativeExecution?.observationConflict, true)
  await f.journal.append({ ...f.base("evt_new_call", 10), type: "task.native-call-started", taskKey: "work", childSessionID: "ses_child",
    binding: { ...f.target.binding, toolCallID: "call_new", parentMessageID: "msg_new" } })
  assert.deepEqual((await f.task()).nativeBinding, original)
  assert.deepEqual((await f.task()).nativeExecution?.binding, f.target.binding)
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
})

test("observation journal codec rejects forged identity, terminal correlation, extra receipts and foreign source sessions", async () => {
  const f = await fixture(), observation: NativeCallObservation = { kind: "tool-ended", mode: "foreground", outcome: "returned",
    source: { id: "native_valid", sessionID: "ses_parent", aggregateID: "agg_parent", seq: 3, created: 20 } }
  const event = f.observedEvent(observation)
  for (const damage of [ { ...event, id: "evt_forged" }, { ...event, admissionID: "msg_forged" },
    { ...event, observation: { ...observation, kind: "child-terminal" } }, { ...event, observation: { ...observation, profile: {} } } ]) {
    assert.equal(parseMissionEvent(damage), undefined)
    await assert.rejects(f.journal.append(damage as MissionEvent), /not durable JSON/)
  }
  const foreign = f.observedEvent({ ...observation, source: { ...observation.source, sessionID: "ses_foreign" } })
  await f.journal.append(foreign)
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
  assert.equal((await f.task()).nativeExecution?.ended, undefined)
})
