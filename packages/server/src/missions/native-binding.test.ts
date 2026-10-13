import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent, type MissionStorage } from "./journal"
import { MISSION_MAX_ACTORS, MISSION_MAX_EVENTS, type MissionEvent, type MissionJsonValue,
  type MissionNativeBinding, type MissionTaskNativeBoundEvent, type MissionTaskNativeReturnedEvent,
  type MissionTaskNativeCallStartedEvent, type MissionTaskNativeCallEndedEvent } from "./model"
import { controlReceiptID, reportAdmissionID, reportNotificationID } from "./receipt-identity"
import { cleanupReceiptID } from "./cleanup-projection"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value) { values.set(key, structuredClone(value)) },
    async scan({ prefix, after, limit = 100 }) {
      assert.equal(limit, 100)
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  }
  const location = { directory: "/owned/project" }
  const journal = new MissionJournal(storage, "project", location.directory, () => 10_000)
  let clock = 0
  const base = () => ({ version: 1 as const, id: `evt_${++clock}`, missionID: "msn_native", projectID: "project", createdAt: clock })
  const key = (event: Pick<MissionEvent, "missionID" | "id">) => `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${event.missionID}/${event.id}`
  const inject = (event: unknown, physicalKey = key(event as MissionEvent)) => {
    values.set(physicalKey, structuredClone(event) as MissionJsonValue)
    return physicalKey
  }
  const create = () => journal.append({ ...base(), type: "mission.created", objective: "Native business projection",
    projectCanonical: location.directory, template: "custom", coordinator: { sessionID: "ses_parent", title: "Coordinator", location } })
  const task = (taskKey = "work", blockedBy: string[] = []) => journal.append({ ...base(), type: "task.created",
    task: { id: `tsk_${taskKey}`, key: taskKey, title: taskKey, brief: "Native work", role: "worker", blockedBy } })
  const binding = (generation = 1, suffix = "work"): MissionNativeBinding => ({ generation,
    parentSessionID: "ses_parent", toolCallID: `call_${suffix}`, parentMessageID: `msg_${suffix}` })
  const bound = (taskKey = "work", child = "ses_child", identity = binding(1, taskKey)): MissionTaskNativeBoundEvent => ({
    ...base(), type: "task.native-bound", taskKey, actor: { sessionID: child, title: "Child", location, managed: true }, binding: identity,
  })
  const returned = (identity = binding(), childSessionID = "ses_child", taskKey = "work"): MissionTaskNativeReturnedEvent => ({
    ...base(), type: "task.native-returned", taskKey, binding: identity, childSessionID,
  })
  const started = (identity = binding(1, "continuation"), childSessionID = "ses_child", taskKey = "work"): MissionTaskNativeCallStartedEvent => ({
    ...base(), type: "task.native-call-started", taskKey, binding: identity, childSessionID,
  })
  const ended = (identity = binding(), outcome: "returned" | "error" = "error", childSessionID = "ses_child", taskKey = "work"): MissionTaskNativeCallEndedEvent => ({
    ...base(), type: "task.native-call-ended", taskKey, binding: identity, childSessionID, outcome,
  })
  const report = (taskKey = "work", sessionId = "ses_child", late = false): Extract<MissionEvent, { type: "task.reported" }> => {
    const event = base()
    return { ...event, type: "task.reported", report: { id: `rpt_${event.id}`, taskKey, sessionId, outcome: "completed",
      summary: "Actual explicit report", evidence: [], next: [], createdAt: event.createdAt, ...(late ? { late: true } : {}) } }
  }
  const revise = (retire = false, dependencyUpdates: Array<{ taskKey: string; blockedBy: string[] }> = []): MissionEvent => ({
    ...base(), type: "mission.revised", requestID: `rev_${clock}`, expectedRevision: clock - 1, actorSessionID: "ses_parent",
    reason: "Task-local change", notesSpecified: false,
    retiredTasks: retire ? [{ taskKey: "work", replacementTaskKey: "replacement" }] : [],
    addedTasks: retire ? [{ id: "tsk_replacement", key: "replacement", title: "Replacement", brief: "New work", role: "worker",
      blockedBy: [], replacesTaskKey: "work" }] : [], dependencyUpdates,
  })
  const mission = async () => (await journal.snapshot()).missions[0]
  const setup = async () => { await create(); await task(); await journal.append(bound()) }
  return { journal, values, base, key, inject, create, task, binding, bound, returned, started, ended, report, revise, mission, setup, location }
}

test("native binding roundtrips schema 1 through real journal storage without claiming inbox admission", async () => {
  const f = fixture(); await f.create(); await f.task()
  const event = f.bound(); await f.journal.append(event); await f.journal.append(event)
  assert.deepEqual(await f.journal.event(event.missionID, event.id), event)
  assert.equal(f.values.size, 3, "same durable event ID is idempotent")
  const mission = await f.mission(), task = mission.tasks[0]
  assert.equal(mission.version, 1)
  assert.deepEqual(task.nativeBinding, event.binding)
  assert.deepEqual(task.nativeExecution, { binding: event.binding })
  assert.equal(task.actorSessionId, "ses_child")
  assert.equal(task.status, "queued")
  assert.equal(task.admissionId, undefined)
  assert.equal(task.delivery, undefined)
  assert.deepEqual(mission.claims, ["work"])
  assert.deepEqual(mission.actors[1], { sessionId: "ses_child", kind: "specialist", managed: true, title: "Child",
    roles: ["worker"], location: f.location, joinedAt: event.createdAt })
})

test("bound then native-returned is neither business completion nor coordinator consumption", async () => {
  const f = fixture(); await f.setup()
  const event = f.returned(); await f.journal.append(event)
  assert.deepEqual(await f.journal.event(event.missionID, event.id), event)
  let mission = await f.mission()
  assert.equal(mission.tasks[0].nativeBinding?.nativeReturned, true)
  assert.deepEqual(mission.tasks[0].nativeExecution, { binding: event.binding, ended: "returned" })
  assert.equal(mission.tasks[0].status, "queued")
  assert.deepEqual(mission.claims, ["work"])
  assert.deepEqual(mission.reports, [])
  assert.equal(mission.control, undefined)
  const report = f.report(); await f.journal.append(report)
  mission = await f.mission()
  assert.equal(mission.tasks[0].status, "completed")
  assert.equal(mission.tasks[0].report?.notificationStatus, "pending")
  assert.equal(mission.reports[0].notificationStatus, "pending")
  assert.deepEqual(mission.claims, [])
})

test("report may precede native return; the return only annotates the original identity", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.report())
  await f.journal.append(f.returned())
  const mission = await f.mission()
  assert.equal(mission.tasks[0].status, "completed")
  assert.equal(mission.tasks[0].nativeBinding?.nativeReturned, true)
  assert.equal(mission.reports[0].notificationStatus, "pending")
})

const malformed: Array<[string, (event: any) => void]> = [
  ["zero generation", e => { e.binding.generation = 0 }],
  ["negative generation", e => { e.binding.generation = -1 }],
  ["fractional generation", e => { e.binding.generation = 1.5 }],
  ["unsafe generation", e => { e.binding.generation = Number.MAX_SAFE_INTEGER + 1 }],
  ["string generation", e => { e.binding.generation = "1" }],
  ["missing tool call", e => { delete e.binding.toolCallID }],
  ["oversized message ID", e => { e.binding.parentMessageID = "m".repeat(241) }],
  ["empty parent", e => { e.binding.parentSessionID = "" }],
  ["control byte ID", e => { e.binding.toolCallID = "call_\u0000" }],
  ["whitespace ID", e => { e.binding.parentSessionID = " ses_parent" }],
  ["forged admissionID", e => { e.admissionID = "msg_forged" }],
  ["forged admissionId", e => { e.admissionId = "msg_forged" }],
  ["forged delivery", e => { e.delivery = "queue" }],
  ["forged nativeReturned", e => { e.binding.nativeReturned = true }],
  ["forged nested admission", e => { e.binding.admissionID = "msg_forged" }],
]
for (const type of ["bound", "returned", "started", "ended"] as const) {
  for (const [label, damage] of malformed) {
    test(`${type} decoder discards ${label} and preserves the raw damaged entry`, async () => {
      const f = fixture(); await f.setup()
      const bad = structuredClone(f[type]())
      damage(bad)
      assert.equal(parseMissionEvent(bad), undefined)
      await assert.rejects(f.journal.append(bad), /not durable JSON/)
      const key = f.inject(bad), bytes = JSON.stringify(f.values.get(key))
      const snapshot = await f.journal.snapshot()
      assert.equal(snapshot.discardedEvents, 1)
      assert.equal(snapshot.controlUnavailable, true)
      assert.equal(snapshot.notificationUnavailable, true)
      assert.equal(snapshot.missions[0].tasks[0].nativeBinding?.nativeReturned, undefined)
      await assert.rejects(f.journal.event(bad.missionID, bad.id), /identity mismatch/)
      assert.equal(JSON.stringify(f.values.get(key)), bytes)
    })
  }
}

test("native actor decoder validates bounded IDs, location and managed flag without stripping forged fields", async () => {
  const changes = [
    (e: any) => { e.actor.sessionID = "" },
    (e: any) => { e.actor.sessionID = "s".repeat(241) },
    (e: any) => { e.actor.managed = "true" },
    (e: any) => { e.actor.location.directory = "" },
    (e: any) => { e.actor.location.workspaceID = 3 },
    (e: any) => { e.actor.admissionID = "msg_forged" },
    (e: any) => { e.actor.location.delivery = "steer" },
  ]
  for (const damage of changes) {
    const f = fixture(), event = f.bound(); damage(event)
    assert.equal(parseMissionEvent(event), undefined)
    await assert.rejects(f.journal.append(event), /not durable JSON/)
    assert.equal(f.values.size, 0)
  }
})

for (const childSessionID of ["", "s".repeat(241), "ses child", "ses_\u0000child"]) {
  test(`native return decoder rejects malformed child ID ${JSON.stringify(childSessionID.slice(0, 20))}`, async () => {
    const f = fixture(); await f.setup()
    const bad = f.returned(f.binding(), childSessionID)
    assert.equal(parseMissionEvent(bad), undefined)
    await assert.rejects(f.journal.append(bad), /not durable JSON/)
    const key = f.inject(bad), bytes = JSON.stringify(f.values.get(key))
    assert.equal((await f.journal.snapshot()).discardedEvents, 1)
    assert.equal((await f.mission()).tasks[0].nativeBinding?.nativeReturned, undefined)
    assert.equal(JSON.stringify(f.values.get(key)), bytes)
  })
}

for (const field of ["generation", "parentSessionID", "toolCallID", "parentMessageID", "childSessionID", "taskKey", "projectID", "missionID"] as const) {
  test(`native return refuses foreign ${field} without changing task/report/receipt state`, async () => {
    const f = fixture(); await f.setup()
    const before = await f.mission(), bad = f.returned()
    if (field === "generation") bad.binding.generation++
    else if (field === "parentSessionID" || field === "toolCallID" || field === "parentMessageID") bad.binding[field] += "_foreign"
    else bad[field] += "_foreign"
    const key = f.inject(bad), bytes = JSON.stringify(f.values.get(key))
    const snapshot = await f.journal.snapshot(), mission = snapshot.missions[0]
    assert.equal(snapshot.discardedEvents, 1)
    assert.deepEqual(mission.tasks, before.tasks)
    assert.deepEqual(mission.reports, before.reports)
    assert.deepEqual(mission.control, before.control)
    assert.equal(JSON.stringify(f.values.get(key)), bytes)
  })
}

test("native return cannot bind an unbound task and duplicate logical returns are discarded", async () => {
  const f = fixture(); await f.create(); await f.task(); await f.journal.append(f.returned())
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
  await f.journal.append(f.bound()); const returned = f.returned()
  await f.journal.append(returned); await f.journal.append(returned); await f.journal.append(f.returned())
  assert.equal((await f.journal.snapshot()).discardedEvents, 2)
  assert.equal((await f.mission()).tasks[0].status, "queued")
})

test("immutable binding rejects rebinds, root dispatch overwrites and changed generations", async () => {
  const f = fixture(); await f.setup()
  const original = (await f.mission()).tasks[0]
  await f.journal.append(f.bound("work", "ses_other", f.binding(2)))
  await f.journal.append(f.bound())
  await f.journal.append({ ...f.base(), type: "task.dispatching", taskKey: "work", actor: f.bound().actor,
    admissionID: "msg_not_native_admission", delivery: "queue" })
  await f.journal.append({ ...f.base(), type: "task.dispatched", taskKey: "work" })
  assert.equal((await f.journal.snapshot()).discardedEvents, 4)
  assert.deepEqual((await f.mission()).tasks[0], original)
  assert.equal((await f.mission()).actors.length, 2)
})

test("task-local dependency edits fence stale binds but unrelated revisions do not", async () => {
  const f = fixture(); await f.create(); await f.task(); await f.task("other")
  await f.journal.append(f.bound("other", "ses_dependency"))
  await f.journal.append(f.returned(f.binding(1, "other"), "ses_dependency", "other"))
  await f.journal.append(f.report("other", "ses_dependency"))
  await f.journal.append(f.revise(false, [{ taskKey: "other", blockedBy: [] }]))
  const beforeNotes = await f.mission()
  await f.journal.append({ ...f.base(), type: "mission.updated", requestID: "notes", expectedRevision: beforeNotes.revision,
    notesSpecified: false, objective: "Unrelated business edit" })
  await f.journal.append(f.revise(false, [{ taskKey: "work", blockedBy: ["other"] }]))
  await f.journal.append(f.bound())
  assert.equal((await f.journal.snapshot()).discardedEvents, 1, "only the stale binding is refused; unrelated no-ops do not revoke")
  assert.equal((await f.mission()).tasks[0].nativeBinding, undefined)
  await f.journal.append(f.bound("work", "ses_child", f.binding(2)))
  await f.journal.append(f.revise(false, [{ taskKey: "work", blockedBy: [] }]))
  await f.journal.append(f.returned(f.binding(2)))
  assert.equal((await f.mission()).tasks[0].nativeBinding?.nativeReturned, true,
    "a real old-generation native return remains evidence, not authority to rebind")
})

test("multiple accepted dependency edits reject every older task-local generation before binding", async () => {
  const f = fixture(); await f.create(); await f.task()
  for (const key of ["one", "two"]) {
    await f.task(key)
    await f.journal.append(f.bound(key, `ses_${key}`))
    await f.journal.append(f.returned(f.binding(1, key), `ses_${key}`, key))
    await f.journal.append(f.report(key, `ses_${key}`))
  }
  for (const blockedBy of [["one"], ["two"], []]) await f.journal.append(f.revise(false, [{ taskKey: "work", blockedBy }]))
  for (let generation = 1; generation < 4; generation++) await f.journal.append(f.bound("work", "ses_child", f.binding(generation)))
  assert.equal((await f.journal.snapshot()).discardedEvents, 3)
  assert.equal((await f.mission()).tasks[0].nativeBinding, undefined)
  await f.journal.append(f.bound("work", "ses_child", f.binding(4)))
  assert.equal((await f.mission()).tasks[0].nativeBinding?.generation, 4)
})

test("bound rejects completed/retired tasks, unsatisfied dependencies and foreign actors", async () => {
  for (const state of ["completed", "retired", "blocked", "coordinator", "unknown-parent", "self-parent"] as const) {
    const f = fixture(); await f.create(); await f.task()
    if (state === "completed") { await f.journal.append(f.bound()); await f.journal.append(f.report()) }
    if (state === "retired") await f.journal.append(f.revise(true))
    if (state === "blocked") await f.journal.append(f.revise(false, [{ taskKey: "work", blockedBy: ["missing"] }]))
    const event = f.bound()
    if (state === "blocked") event.binding.generation = 2
    if (state === "coordinator") event.actor.sessionID = "ses_parent"
    if (state === "unknown-parent") event.binding.parentSessionID = "ses_foreign"
    if (state === "self-parent") event.binding.parentSessionID = "ses_child"
    const before = (await f.mission()).tasks
    await f.journal.append(event)
    assert.equal((await f.journal.snapshot()).discardedEvents, 1, state)
    assert.deepEqual((await f.mission()).tasks, before, state)
  }
})

test("child reuse for a different task preserves original binding and report history; changed actor identity fails closed", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.returned()); await f.journal.append(f.report())
  const original = (await f.mission()).tasks[0]
  await f.task("second")
  for (const field of ["title", "managed", "location"] as const) {
    const bad = f.bound("second")
    if (field === "title") bad.actor.title = "Foreign"
    if (field === "managed") bad.actor.managed = false
    if (field === "location") bad.actor.location = { directory: "/foreign" }
    await f.journal.append(bad)
  }
  await f.journal.append(f.bound("second"))
  const mission = await f.mission()
  assert.equal((await f.journal.snapshot()).discardedEvents, 3)
  assert.deepEqual(mission.tasks[0], original)
  assert.equal(mission.tasks[1].actorSessionId, "ses_child")
  assert.equal(mission.tasks[1].nativeBinding?.toolCallID, "call_second")
  assert.equal(mission.reports.length, 1)
  assert.equal(mission.reports[0].notificationStatus, "pending")
})

for (const settle of ["return", "late-report"] as const) {
  test(`withdrawn native task remains outstanding until actual ${settle}; replacement is untouched`, async () => {
    const f = fixture(); await f.setup(); await f.journal.append(f.revise(true))
    let mission = await f.mission()
    assert.equal(mission.tasks[0].status, "withdrawn")
    assert.equal(mission.tasks[0].outstandingExecution, true)
    assert.equal(mission.tasks[1].status, "ready")
    await f.journal.append(f.report("work", "ses_foreign", true))
    await f.journal.append(f.returned(f.binding(), "ses_foreign"))
    assert.equal((await f.mission()).tasks[0].outstandingExecution, true)
    await f.journal.append(settle === "return" ? f.returned() : f.report("work", "ses_child", true))
    mission = await f.mission()
    assert.equal(mission.tasks[0].outstandingExecution, false)
    assert.equal(mission.tasks[0].status, "withdrawn")
    assert.equal(mission.tasks[1].status, "ready")
    assert.equal(mission.tasks[1].report, undefined)
    assert.equal(mission.tasks[0].report, undefined)
    if (settle === "return") await f.journal.append(f.report("work", "ses_child", true))
    else await f.journal.append(f.returned())
    mission = await f.mission()
    assert.equal(mission.tasks[0].lateReports?.length, 1)
    assert.equal(mission.tasks[0].lateReports?.[0].notificationStatus, "pending")
    assert.equal(mission.tasks[0].nativeBinding?.nativeReturned, true)
    assert.equal(mission.tasks[1].status, "ready")
  })
}

test("Stop ACK is not a native return; settled lifecycle controls cannot release outstanding native work", async () => {
  const f = fixture(); await f.setup()
  const stop: Extract<MissionEvent, { type: "mission.control-requested" }> = { ...f.base(), type: "mission.control-requested",
    requestID: "stop", expectedRevision: 3, action: "stop", targets: ["ses_parent", "ses_child"].map(sessionID => ({ sessionID, location: f.location })) }
  await f.journal.append(stop)
  for (const target of stop.targets) await f.journal.append({ ...f.base(), id: controlReceiptID(stop.id, target.sessionID),
    type: "mission.control-applied", operationID: stop.id, sessionID: target.sessionID })
  let mission = await f.mission()
  assert.deepEqual(mission.control?.pending, [])
  assert.equal(mission.tasks[0].status, "withdrawn")
  assert.equal(mission.tasks[0].outstandingExecution, true)
  await f.journal.append(f.returned())
  mission = await f.mission()
  assert.equal(mission.tasks[0].outstandingExecution, false)
  assert.deepEqual(mission.reports, [])
})

test("native actor capacity rejection never creates a ghost assignment/claim", async () => {
  const f = fixture(); await f.create()
  for (let index = 0; index < MISSION_MAX_ACTORS; index++) {
    await f.task(`work${index}`); await f.journal.append(f.bound(`work${index}`, `ses_child_${index}`))
  }
  const mission = await f.mission()
  assert.equal(mission.actors.length, MISSION_MAX_ACTORS)
  assert.equal(mission.tasks.at(-1)?.actorSessionId, undefined)
  assert.equal(mission.tasks.at(-1)?.nativeBinding, undefined)
  assert.equal(mission.claims.length, MISSION_MAX_ACTORS - 1)
  assert.equal((await f.journal.snapshot()).discardedEvents, 1)
})

test("old root assignment and explicit report-notification receipts retain exact behavior", async () => {
  const f = fixture(); await f.create(); await f.task()
  await f.journal.append({ ...f.base(), type: "task.dispatching", taskKey: "work", actor: f.bound().actor,
    admissionID: "msg_root_admission", delivery: "steer" })
  assert.equal((await f.mission()).tasks[0].status, "dispatching")
  await f.journal.append({ ...f.base(), type: "task.dispatched", taskKey: "work" })
  assert.equal((await f.mission()).tasks[0].status, "queued")
  assert.equal((await f.mission()).tasks[0].nativeBinding, undefined)
  const report = f.report(); await f.journal.append(report)
  assert.equal((await f.mission()).reports[0].notificationStatus, "pending")
  await f.journal.append({ ...f.base(), id: reportNotificationID(report.missionID, report.report.id),
    type: "report.notified", reportID: report.report.id, admissionID: reportAdmissionID(report.report.id) })
  const mission = await f.mission()
  assert.equal(mission.tasks[0].status, "completed")
  assert.equal(mission.tasks[0].admissionId, "msg_root_admission")
  assert.equal(mission.tasks[0].delivery, "steer")
  assert.equal(mission.reports[0].notificationStatus, "admitted")
})

for (const kind of ["lifecycle", "cleanup"] as const) {
test(`native binding/return cannot spend reserved ${kind} receipt capacity, even at its deterministic key`, async () => {
  const f = fixture(); await f.setup()
  for (let index = f.values.size; f.values.size < MISSION_MAX_EVENTS - 2; index++) {
    const event: MissionEvent = { ...f.base(), type: "mission.updated", requestID: `fill_${index}`, expectedRevision: 1,
      objective: "Capacity filler", notesSpecified: false }
    f.inject(event)
  }
  const intent: MissionEvent = kind === "lifecycle"
    ? { ...f.base(), type: "mission.control-requested", requestID: "stop", expectedRevision: 1, action: "stop",
      targets: [{ sessionID: "ses_child", location: f.location }] }
    : { ...f.base(), type: "mission.deleted", requestID: "delete", expectedRevision: 1, deleteManagedSessions: true,
      cleanupTargets: [{ sessionID: "ses_child", location: f.location }] }
  await f.journal.append(intent)
  const receiptID = kind === "lifecycle" ? controlReceiptID(intent.id, "ses_child") : cleanupReceiptID(intent.id, "ses_child")
  for (const native of [f.bound(), f.returned(), f.started(), f.ended()]) {
    await assert.rejects(f.journal.append(native), /2000-event safety limit/)
    await assert.rejects(f.journal.append({ ...native, id: receiptID }), /2000-event safety limit/)
  }
  assert.equal(f.values.size, MISSION_MAX_EVENTS - 1)
  await f.journal.append(kind === "lifecycle"
    ? { ...f.base(), id: receiptID, type: "mission.control-applied", operationID: intent.id, sessionID: "ses_child" }
    : { ...f.base(), id: receiptID, type: "mission.session-cleaned", deletionID: intent.id, sessionID: "ses_child", outcome: "removed" })
  assert.equal(f.values.size, MISSION_MAX_EVENTS)
  assert.equal((await f.journal.events()).events.filter(event => event.type === "task.native-returned").length, 0)
})
}

test("first bound error then explicit continuation return retires cleanly without relabeling the original failed call", async () => {
  const f = fixture(); await f.setup()
  const error = f.ended(); await f.journal.append(error)
  assert.deepEqual(await f.journal.event(error.missionID, error.id), error)
  let mission = await f.mission()
  assert.deepEqual(mission.tasks[0].nativeExecution, { binding: f.binding(), ended: "error" })
  assert.deepEqual(mission.tasks[0].nativeBinding, f.binding())
  assert.equal(mission.tasks[0].status, "queued")
  const original = structuredClone(mission.tasks[0].nativeBinding)
  const next = f.binding(1, "next"), start = f.started(next)
  await f.journal.append(start)
  assert.deepEqual(await f.journal.event(start.missionID, start.id), start)
  const end = f.ended(next, "returned"); await f.journal.append(end)
  assert.deepEqual(await f.journal.event(end.missionID, end.id), end)
  await f.journal.append(f.revise(true))
  mission = await f.mission()
  assert.equal(mission.tasks[0].status, "withdrawn")
  assert.equal(mission.tasks[0].outstandingExecution, false)
  assert.deepEqual(mission.tasks[0].nativeBinding, original)
  assert.equal(mission.tasks[0].nativeBinding?.nativeReturned, undefined)
  assert.deepEqual(mission.tasks[0].nativeExecution, { binding: next, ended: "returned" })
  assert.equal(mission.tasks[1].status, "ready")
  assert.equal(mission.tasks[0].report, undefined)
  assert.deepEqual(mission.reports, [])
  assert.equal(mission.control, undefined)
  assert.equal((await f.journal.snapshot()).discardedEvents, 0)
  const events = (await f.journal.events()).events
  assert.equal(events.filter(e => e.type === "task.native-call-started").length, 1)
  assert.equal(events.filter(e => e.type === "task.native-call-ended").length, 2)
})

test("original success followed by pending continuation remains outstanding when retired until exact current end", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.returned())
  const original = structuredClone((await f.mission()).tasks[0].nativeBinding)
  const next = f.binding(1, "next"); await f.journal.append(f.started(next)); await f.journal.append(f.revise(true))
  const before = (await f.mission()).tasks[0]
  assert.equal(before.outstandingExecution, true)
  assert.equal(before.nativeBinding?.nativeReturned, true)
  assert.deepEqual(before.nativeExecution, { binding: next })
  for (const field of ["generation", "parentSessionID", "toolCallID", "parentMessageID", "childSessionID", "taskKey", "projectID", "missionID"] as const) {
    const bad = f.ended(structuredClone(next), "returned")
    if (field === "generation") bad.binding.generation++
    else if (field === "parentSessionID" || field === "toolCallID" || field === "parentMessageID") bad.binding[field] += "_foreign"
    else bad[field] += "_foreign"
    const key = f.inject(bad), bytes = JSON.stringify(f.values.get(key))
    assert.deepEqual((await f.mission()).tasks[0], before, field)
    assert.equal(JSON.stringify(f.values.get(key)), bytes)
  }
  await f.journal.append(f.returned()) // original ACK cannot end the continuation
  assert.deepEqual((await f.mission()).tasks[0], before)
  await f.journal.append(f.ended(next, "returned"))
  const mission = await f.mission()
  assert.equal(mission.tasks[0].outstandingExecution, false)
  assert.equal(mission.tasks[0].status, "withdrawn")
  assert.deepEqual(mission.tasks[0].nativeBinding, original)
  assert.equal(mission.tasks[1].status, "ready")
  assert.equal(mission.tasks[0].report, undefined)
  assert.deepEqual(mission.reports, [])
  assert.equal((await f.journal.snapshot()).discardedEvents, 9)
})

test("original invocation ended returned annotates its original return; error cannot become a later success", async () => {
  for (const outcome of ["returned", "error"] as const) {
    const f = fixture(); await f.setup(); const end = f.ended(f.binding(), outcome)
    await f.journal.append(end); await f.journal.append(end) // durable idempotence
    const before = (await f.mission()).tasks[0]
    assert.equal(before.nativeBinding?.nativeReturned, outcome === "returned" ? true : undefined)
    assert.equal(before.nativeExecution?.ended, outcome)
    await f.journal.append(f.ended(f.binding(), "returned")); await f.journal.append(f.returned())
    assert.deepEqual((await f.mission()).tasks[0], before)
    assert.equal((await f.journal.snapshot()).discardedEvents, 2)
    await f.journal.append(f.revise(true))
    assert.equal((await f.mission()).tasks[0].outstandingExecution, false)
  }
})

test("continuation start cannot create authority, race a pending invocation or reuse historical call/message identities", async () => {
  const f = fixture(); await f.create(); await f.task()
  await f.journal.append(f.started()) // unbound task cannot acquire a child
  await f.journal.append(f.ended()) // no invocation to end
  await f.journal.append(f.bound())
  const pending = (await f.mission()).tasks[0]
  await f.journal.append(f.started())
  assert.deepEqual((await f.mission()).tasks[0], pending)
  await f.journal.append(f.ended())
  const next = f.binding(1, "next"), start = f.started(next)
  await f.journal.append(start); await f.journal.append(start) // exact append is idempotent
  await f.journal.append(f.started(next)) // logical duplicate while pending
  await f.journal.append(f.ended(next, "returned"))
  const before = (await f.mission()).tasks[0]
  for (const identity of [f.binding(), next,
    { ...f.binding(1, "third"), toolCallID: "call_next" },
    { ...f.binding(1, "third"), parentMessageID: "msg_work" }]) {
    await f.journal.append(f.started(identity))
    assert.deepEqual((await f.mission()).tasks[0], before)
  }
  assert.equal((await f.journal.snapshot()).discardedEvents, 8)
  await f.journal.append(f.started(f.binding(1, "third")))
  assert.deepEqual((await f.mission()).tasks[0].nativeExecution, { binding: f.binding(1, "third") })
  assert.equal((await f.mission()).actors.length, 2)
})

test("continuation refuses foreign identities; a forbidden assigned-task edit does not revoke its generation", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.returned())
  const before = (await f.mission()).tasks[0]
  for (const event of [f.started(f.binding(2, "next")), f.started(f.binding(1, "next"), "ses_foreign"),
    f.started({ ...f.binding(1, "next"), parentSessionID: "ses_foreign" }),
    f.started(f.binding(1, "next"), "ses_child", "foreign-task")]) {
    await f.journal.append(event)
    assert.deepEqual((await f.mission()).tasks[0], before)
  }
  await f.journal.append(f.revise(false, [{ taskKey: "work", blockedBy: ["foreign"] }]))
  const changed = (await f.mission()).tasks[0]
  await f.journal.append(f.started(f.binding(1, "next")))
  const continued = (await f.mission()).tasks[0]
  assert.deepEqual(continued.nativeExecution, { binding: f.binding(1, "next") })
  assert.equal(continued.contractGeneration, changed.contractGeneration)
  await f.journal.append(f.started(f.binding(2, "next")))
  assert.deepEqual((await f.mission()).tasks[0], continued)
  assert.equal((await f.journal.snapshot()).discardedEvents, 6)
})

test("completed task can continue without rewriting its report or claiming notification admission", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.returned()); await f.journal.append(f.report())
  const completed = await f.mission(), original = structuredClone(completed.tasks[0].nativeBinding)
  const next = f.binding(1, "next"); await f.journal.append(f.started(next))
  let mission = await f.mission()
  assert.equal(mission.tasks[0].status, "completed")
  assert.deepEqual(mission.tasks[0].report, completed.tasks[0].report)
  assert.deepEqual(mission.reports, completed.reports)
  assert.equal(mission.reports[0].notificationStatus, "pending")
  assert.deepEqual(mission.claims, [])
  await f.journal.append(f.revise(true))
  mission = await f.mission()
  assert.equal(mission.tasks[0].outstandingExecution, true, "the previous report cannot settle a later pending call")
  await f.journal.append(f.ended(next, "error"))
  mission = await f.mission()
  assert.equal(mission.tasks[0].outstandingExecution, false)
  assert.deepEqual(mission.tasks[0].nativeBinding, original)
  assert.deepEqual(mission.reports, completed.reports)
  assert.equal(mission.tasks[1].report, undefined)
})

test("explicit late report still resolves withdrawn current work without inventing its termination", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.ended())
  const next = f.binding(1, "next"); await f.journal.append(f.started(next)); await f.journal.append(f.revise(true))
  assert.equal((await f.mission()).tasks[0].outstandingExecution, true)
  await f.journal.append(f.report("work", "ses_child", true))
  let mission = await f.mission()
  assert.equal(mission.tasks[0].outstandingExecution, false)
  assert.deepEqual(mission.tasks[0].nativeExecution, { binding: next })
  assert.equal(mission.tasks[0].nativeBinding?.nativeReturned, undefined)
  assert.equal(mission.tasks[0].lateReports?.[0].notificationStatus, "pending")
  assert.equal(mission.tasks[1].status, "ready")
  await f.journal.append(f.ended(next, "returned"))
  mission = await f.mission()
  assert.equal(mission.tasks[0].nativeExecution?.ended, "returned")
  assert.equal(mission.tasks[0].nativeBinding?.nativeReturned, undefined)
  assert.equal(mission.tasks[0].status, "withdrawn")
})

test("withdrawn and stopped tasks cannot start continuation, but their exact pending call may end late", async () => {
  for (const stop of [false, true]) {
    const f = fixture(); await f.setup(); await f.journal.append(f.returned())
    const next = f.binding(1, "next"); await f.journal.append(f.started(next))
    if (stop) {
      const intent: Extract<MissionEvent, { type: "mission.control-requested" }> = { ...f.base(), type: "mission.control-requested",
        requestID: "stop", expectedRevision: 5, action: "stop", targets: [{ sessionID: "ses_child", location: f.location }] }
      await f.journal.append(intent)
      await f.journal.append({ ...f.base(), id: controlReceiptID(intent.id, "ses_child"), type: "mission.control-applied",
        operationID: intent.id, sessionID: "ses_child" })
      assert.deepEqual((await f.mission()).control?.pending, [])
    } else await f.journal.append(f.revise(true))
    assert.equal((await f.mission()).tasks[0].outstandingExecution, true)
    await f.journal.append(f.ended(next, "returned"))
    const before = (await f.mission()).tasks[0]
    assert.equal(before.outstandingExecution, false)
    await f.journal.append(f.started(f.binding(1, "third")))
    assert.deepEqual((await f.mission()).tasks[0], before)
    assert.equal((await f.journal.snapshot()).discardedEvents, 1)
  }
})

test("new call decoder refuses malformed child IDs, outcomes and forged execution state without repairing raw evidence", async () => {
  const damages = [
    (e: any) => { e.childSessionID = "" },
    (e: any) => { e.childSessionID = "s".repeat(241) },
    (e: any) => { e.childSessionID = "ses child" },
    (e: any) => { e.childSessionID = "ses_\u0000child" },
    (e: any) => { e.nativeExecution = { binding: e.binding, ended: "returned" } },
    (e: any) => { e.report = { outcome: "completed" } },
    (e: any) => { e.notificationStatus = "admitted" },
    (e: any) => { e.outcome = "completed" },
  ]
  for (const type of ["started", "ended"] as const) {
    for (const damage of damages) {
      const f = fixture(); await f.setup(); const bad = f[type](); damage(bad)
      assert.equal(parseMissionEvent(bad), undefined)
      await assert.rejects(f.journal.append(bad), /not durable JSON/)
      const key = f.inject(bad), bytes = JSON.stringify(f.values.get(key))
      assert.equal((await f.journal.snapshot()).discardedEvents, 1)
      assert.equal(JSON.stringify(f.values.get(key)), bytes)
      assert.deepEqual((await f.mission()).tasks[0].nativeExecution, { binding: f.binding() })
    }
  }
  const f = fixture(), missing = f.ended() as any; delete missing.outcome
  assert.equal(parseMissionEvent(missing), undefined)
})
