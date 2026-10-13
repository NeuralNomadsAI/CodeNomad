import assert from "node:assert/strict"
import test from "node:test"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent, type MissionStorage } from "./journal"
import { reduceMissionEvents, type MissionEvent, type MissionJsonValue, type MissionNativeBinding, type MissionReport } from "./model"
import { hasInvalidReportNotificationHistory, isCoordinatorNotificationReport, parseNativeBinding, parseNativeCall, sameNativeCall } from "./native-report-provenance"
import { controlReceiptID, reportAdmissionID, reportNotificationID } from "./receipt-identity"
import type { MissionTaskExecutionMode } from "./task-execution-mode"

function fixture(mode: MissionTaskExecutionMode | null = { kind: "native", parentTaskKey: null }) {
  const values = new Map<string, MissionJsonValue>(), reads: string[] = []
  const storage: MissionStorage = {
    async get(key) { reads.push(key); return structuredClone(values.get(key)) },
    async set(key, value) { values.set(key, structuredClone(value)) },
    async scan({ prefix, after, limit = 100 }) {
      reads.push(prefix)
      const keys = [...values.keys()].filter(key => key.startsWith(`${prefix}/`) && (!after || key > after)).sort(), page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  }
  const location = { directory: "/owned/project" }, journal = new MissionJournal(storage, "project", location.directory, () => 10_000)
  let clock = 0
  const base = () => ({ version: 1 as const, id: `evt_${++clock}`, missionID: "msn_provenance", projectID: "project", createdAt: clock })
  const binding = (suffix = "first", generation = 1): MissionNativeBinding => ({ generation,
    parentSessionID: "ses_parent", toolCallID: `call_${suffix}`, parentMessageID: `msg_${suffix}` })
  const create = async () => {
    await journal.append({ ...base(), type: "mission.created", objective: "Exact report provenance", projectCanonical: location.directory,
      template: "custom", coordinator: { sessionID: "ses_parent", title: "Coordinator", location } })
    await journal.append({ ...base(), type: "task.created", task: { id: "tsk_work", key: "work", title: "Work", brief: "Actual business work",
      role: "worker", blockedBy: [], ...(mode === null ? {} : { executionMode: mode }) } })
  }
  const bound = (): MissionEvent => ({ ...base(), type: "task.native-bound", taskKey: "work",
    actor: { sessionID: "ses_child", title: "Child", managed: true, location }, binding: binding() })
  const end = (call = binding(), outcome: "returned" | "error" = "error"): MissionEvent => ({ ...base(), type: "task.native-call-ended",
    taskKey: "work", childSessionID: "ses_child", binding: call, outcome })
  const start = (call = binding("next")): MissionEvent => ({ ...base(), type: "task.native-call-started", taskKey: "work",
    childSessionID: "ses_child", binding: call })
  const report = (call: MissionNativeBinding | undefined = binding(), late = false): Extract<MissionEvent, { type: "task.reported" }> => {
    const event = base()
    return { ...event, type: "task.reported", report: { id: `rpt_${clock}`, taskKey: "work", sessionId: "ses_child", outcome: "completed",
      summary: "Explicit business report", evidence: [], next: [], createdAt: clock,
      ...(call === undefined ? {} : { nativeCall: call, delivery: "native-return" }), ...(late ? { late: true } : {}) } }
  }
  const rootReport = (): Extract<MissionEvent, { type: "task.reported" }> => {
    const event = report(); delete event.report.nativeCall; delete event.report.delivery; return event
  }
  const retire = (): MissionEvent => ({ ...base(), type: "mission.revised", requestID: `req_${clock}`, expectedRevision: clock - 1,
    actorSessionID: "ses_parent", reason: "Replacement work", notesSpecified: false, dependencyUpdates: [],
    retiredTasks: [{ taskKey: "work", replacementTaskKey: "replacement" }], addedTasks: [{ id: "tsk_replacement", key: "replacement",
      title: "Replacement", brief: "New business work", role: "worker", blockedBy: [], replacesTaskKey: "work",
      executionMode: { kind: "native", parentTaskKey: null } }] })
  const stop = async () => {
    const intent: Extract<MissionEvent, { type: "mission.control-requested" }> = { ...base(), type: "mission.control-requested",
      requestID: `req_${clock}`, expectedRevision: clock - 1, action: "stop", targets: [{ sessionID: "ses_child", location }] }
    await journal.append(intent)
    await journal.append({ ...base(), id: controlReceiptID(intent.id, "ses_child"), type: "mission.control-applied",
      operationID: intent.id, sessionID: "ses_child" })
  }
  const receipt = (report: MissionReport): Extract<MissionEvent, { type: "report.notified" }> => ({ ...base(), type: "report.notified",
    id: reportNotificationID("msn_provenance", report.id), reportID: report.id, admissionID: reportAdmissionID(report.id) })
  const key = (event: Pick<MissionEvent, "missionID" | "id">) => `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${event.missionID}/${event.id}`
  const inject = (event: unknown) => { const physical = key(event as MissionEvent); values.set(physical, structuredClone(event) as MissionJsonValue); return physical }
  const snapshot = () => journal.snapshot()
  const mission = async () => (await snapshot()).missions[0]
  const setup = async () => { await create(); await journal.append(bound()) }
  return { journal, values, reads, base, binding, create, bound, end, start, report, rootReport, retire, stop, receipt, inject, snapshot, mission, setup, location }
}

test("native provenance is one strict binding and route helpers preserve absence without outcome inference", () => {
  const f = fixture(), call = f.binding()
  assert.equal(parseNativeCall(undefined), undefined)
  assert.deepEqual(parseNativeCall(call), call)
  assert.notEqual(parseNativeCall(call), call)
  assert.equal(sameNativeCall(call, structuredClone(call)), true)
  assert.equal(sameNativeCall(undefined, undefined), true)
  assert.equal(sameNativeCall(call, undefined), false)
  for (const field of ["generation", "parentSessionID", "toolCallID", "parentMessageID"] as const) {
    const changed = { ...call, [field]: field === "generation" ? 2 : "foreign" }
    assert.equal(sameNativeCall(call, changed), false)
  }
  assert.equal(isCoordinatorNotificationReport({}), true)
  assert.equal(isCoordinatorNotificationReport({ delivery: "coordinator-notification" }), true)
  assert.equal(isCoordinatorNotificationReport({ delivery: "native-return" }), false)
  assert.equal(isCoordinatorNotificationReport({ delivery: "unknown" } as any), false)
})

test("malformed/extra native fields and forged derived notification state reject decoding and writes", async () => {
  const f = fixture()
  const malformed: unknown[] = [null, [], "call", {}, { generation: 1, binding: f.binding() },
    ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map(generation => ({ ...f.binding(), generation })),
    ...["", "x".repeat(241), "call bad", "call_\u0000"].map(toolCallID => ({ ...f.binding(), toolCallID })),
    { ...f.binding(), nativeReturned: true }, { ...f.binding(), childSessionID: "ses_child" },
    { ...f.binding(), admissionID: "msg_forged" }]
  for (const nativeCall of malformed) {
    assert.equal(parseNativeBinding(nativeCall), undefined)
    assert.throws(() => parseNativeCall(nativeCall))
    const event = f.report(), bad = { ...event, report: { ...event.report, nativeCall } }
    assert.equal(parseMissionEvent(bad), undefined)
    await assert.rejects(f.journal.append(bad as MissionEvent), /not durable JSON/)
  }
  for (const fields of [{ delivery: "queue" }, { delivery: null }, { notificationStatus: "admitted" },
    { nativeReturned: true }, { nativeExecution: { ended: "returned" } }, { admissionID: "msg_forged" }]) {
    const event = f.report(), bad = { ...event, report: { ...event.report, ...fields } }
    assert.equal(parseMissionEvent(bad), undefined)
    await assert.rejects(f.journal.append(bad as MissionEvent), /not durable JSON/)
  }
  for (const fields of [{ nativeCall: f.binding() }, { delivery: "native-return" }, { outcome: "completed" }]) {
    assert.equal(parseMissionEvent({ ...f.receipt(f.report().report), ...fields }), undefined)
  }
  assert.equal(f.values.size, 0)
})

test("malformed persisted native provenance is discarded without repair or alternate namespace reads", async () => {
  const f = fixture(); await f.setup()
  const bad = f.report() as any; bad.report.nativeCall.nativeReturned = true
  const key = f.inject(bad), bytes = JSON.stringify(f.values.get(key)), snapshot = await f.snapshot()
  assert.equal(snapshot.discardedEvents, 1)
  assert.equal(snapshot.notificationUnavailable, true)
  assert.equal(snapshot.missions[0].tasks[0].report, undefined)
  assert.equal(snapshot.missions[0].tasks[0].nativeExecution?.ended, undefined)
  assert.equal(JSON.stringify(f.values.get(key)), bytes)
  assert.ok(f.reads.every(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/`)))
})

test("report before call end roundtrips exact provenance without inventing native return or notification admission", async () => {
  const f = fixture(); await f.setup()
  const report = f.report(); await f.journal.append(report)
  assert.deepEqual((await f.journal.event(report.missionID, report.id) as typeof report).report.nativeCall, report.report.nativeCall)
  const mission = await f.mission(), task = mission.tasks[0]
  assert.equal(task.status, "completed")
  assert.deepEqual(task.nativeExecution, { binding: f.binding() })
  assert.equal(task.nativeBinding?.nativeReturned, undefined)
  assert.equal(task.report?.notificationStatus, "pending")
  assert.equal(task.report?.delivery, "native-return")
  assert.deepEqual(task.report?.nativeCall, f.binding())
  assert.equal(task.admissionId, undefined)
  assert.equal(task.delivery, undefined)
  assert.equal(mission.reports[0].notificationStatus, "pending")
  await f.journal.append(f.end(f.binding(), "returned"))
  assert.equal((await f.mission()).tasks[0].nativeBinding?.nativeReturned, true)
})

test("report after an observed error can complete business work without rewriting executor outcome", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.end()); await f.journal.append(f.report())
  const task = (await f.mission()).tasks[0]
  assert.equal(task.status, "completed")
  assert.equal(task.nativeExecution?.ended, "error")
  assert.equal(task.nativeBinding?.nativeReturned, undefined)
  assert.equal(task.report?.notificationStatus, "pending")
})

test("explicit native tasks reject missing provenance, wrong invocation/generation, wrong actor and ancestor privilege", async () => {
  const damages: Array<(event: Extract<MissionEvent, { type: "task.reported" }>) => void> = [
    event => { delete event.report.nativeCall },
    event => { event.report.nativeCall!.generation = 2 },
    event => { event.report.nativeCall!.parentSessionID = "ses_other_parent" },
    event => { event.report.nativeCall!.toolCallID = "call_other" },
    event => { event.report.nativeCall!.parentMessageID = "msg_other" },
    event => { event.report.sessionId = "ses_parent" },
    event => { event.report.sessionId = "ses_foreign_child" },
    event => { event.report.taskKey = "ancestor" },
  ]
  for (const damage of damages) {
    const f = fixture(); await f.setup(); const before = await f.mission(), report = f.report(); damage(report)
    await f.journal.append(report)
    const snapshot = await f.snapshot()
    assert.equal(snapshot.discardedEvents, 1)
    assert.deepEqual(snapshot.missions[0].tasks, before.tasks)
    assert.deepEqual(snapshot.missions[0].actors, before.actors)
    assert.deepEqual(snapshot.missions[0].reports, [])
  }
})

test("independent tasks cannot acquire native evidence or native-return delivery through report fields", async () => {
  const f = fixture({ kind: "independent", reason: "existing-root", explanation: "An existing independent root is required." })
  await f.create()
  await f.journal.append({ ...f.base(), type: "task.dispatching", taskKey: "work", admissionID: "msg_root", delivery: "queue",
    actor: { sessionID: "ses_child", title: "Root", managed: false, location: f.location } })
  await f.journal.append({ ...f.base(), type: "task.dispatched", taskKey: "work" })
  await f.journal.append(f.report())
  const withoutCall = f.report(); delete withoutCall.report.nativeCall; await f.journal.append(withoutCall)
  assert.equal((await f.snapshot()).discardedEvents, 2)
  assert.deepEqual((await f.mission()).reports, [])
  const report = f.rootReport(); report.report.delivery = "coordinator-notification"; await f.journal.append(report)
  await f.journal.append(f.receipt(report.report))
  assert.equal((await f.mission()).tasks[0].report?.notificationStatus, "admitted")
  assert.equal((await f.mission()).tasks[0].nativeBinding, undefined)
})

for (const lifecycle of ["retired", "stopped"] as const) {
  test(`exact historical invocation report remains evidence after ${lifecycle} but cannot settle the newer pending call`, async () => {
    const f = fixture(); await f.setup(); await f.journal.append(f.end()); await f.journal.append(f.start())
    if (lifecycle === "retired") await f.journal.append(f.retire()); else await f.stop()
    assert.equal((await f.mission()).tasks[0].outstandingExecution, true)
    const old = f.report(f.binding(), true); await f.journal.append(old)
    let task = (await f.mission()).tasks[0]
    assert.equal(task.status, "withdrawn")
    assert.deepEqual(task.lateReports?.[0].nativeCall, f.binding())
    assert.equal(task.outstandingExecution, true)
    assert.deepEqual(task.nativeExecution, { binding: f.binding("next") })
    assert.equal(task.nativeBinding?.nativeReturned, undefined)
    const current = f.report(f.binding("next"), true); await f.journal.append(current)
    task = (await f.mission()).tasks[0]
    assert.equal(task.outstandingExecution, false)
    assert.equal(task.lateReports?.length, 2)
    assert.deepEqual(task.nativeExecution, { binding: f.binding("next") }, "business report does not infer invocation termination")
    assert.equal(task.report, undefined)
    if (lifecycle === "retired") assert.equal((await f.mission()).tasks[1].report, undefined)
    else assert.deepEqual((await f.mission()).control?.pending, [])
  })
}

test("old completed business report and later historical evidence never settle a continuation started afterward", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.report()); await f.journal.append(f.end())
  await f.journal.append(f.start()); const original = (await f.mission()).tasks[0].report
  await f.journal.append(f.retire()); await f.journal.append(f.report(f.binding(), true))
  let task = (await f.mission()).tasks[0]
  assert.deepEqual(task.report, original)
  assert.equal(task.lateReports?.length, 1)
  assert.equal(task.outstandingExecution, true)
  await f.journal.append(f.end(f.binding("next"), "returned"))
  task = (await f.mission()).tasks[0]
  assert.equal(task.outstandingExecution, false)
  assert.equal(task.nativeBinding?.nativeReturned, undefined)
  assert.deepEqual(task.report, original)
})

test("accepted call history matches whole invocation tuples, not individually seen call/message IDs", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.end()); await f.journal.append(f.start()); await f.journal.append(f.retire())
  const hybrid = { ...f.binding(), parentMessageID: f.binding("next").parentMessageID }
  await f.journal.append(f.report(hybrid, true)); await f.journal.append(f.report(f.binding("first", 2), true))
  assert.equal((await f.snapshot()).discardedEvents, 2)
  assert.equal((await f.mission()).tasks[0].lateReports, undefined)
  assert.equal((await f.mission()).tasks[0].outstandingExecution, true)
})

test("old invocation cannot claim current business outcome while an active continuation is pending", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.end()); await f.journal.append(f.start())
  await f.journal.append(f.report()); assert.equal((await f.snapshot()).discardedEvents, 1)
  assert.equal((await f.mission()).tasks[0].report, undefined)
  await f.journal.append(f.report(f.binding("next")))
  assert.deepEqual((await f.mission()).tasks[0].report?.nativeCall, f.binding("next"))
})

test("a reused child cannot apply an old task's invocation or generation to replacement work", async () => {
  const f = fixture(); await f.setup(); await f.journal.append(f.end(f.binding(), "returned")); await f.journal.append(f.report())
  await f.journal.append(f.retire())
  for (const blockedBy of [["work"], []]) await f.journal.append({ ...f.base(), type: "mission.revised", requestID: `req_${blockedBy.length}`,
    expectedRevision: 1, actorSessionID: "ses_parent", reason: "Replacement dependency contract", notesSpecified: false,
    retiredTasks: [], addedTasks: [], dependencyUpdates: [{ taskKey: "replacement", blockedBy }] })
  const bound = f.bound() as Extract<MissionEvent, { type: "task.native-bound" }>
  bound.taskKey = "replacement"; bound.binding = f.binding("replacement", 3); await f.journal.append(bound)
  const before = (await f.mission()).tasks, stale = f.report(); stale.report.taskKey = "replacement"
  await f.journal.append(stale)
  assert.deepEqual((await f.mission()).tasks, before)
  assert.equal((await f.snapshot()).discardedEvents, 1)
  const current = f.report(f.binding("replacement", 3)); current.report.taskKey = "replacement"; await f.journal.append(current)
  assert.deepEqual((await f.mission()).tasks[1].report?.nativeCall, f.binding("replacement", 3))
  assert.deepEqual((await f.mission()).tasks[0].report, before[0].report)
})

test("routing stays an explicit choice rather than being inferred from native provenance", async () => {
  for (const delivery of [undefined, "coordinator-notification"] as const) {
    const f = fixture(); await f.setup(); const report = f.report()
    if (delivery === undefined) delete report.report.delivery; else report.report.delivery = delivery
    await f.journal.append(report); await f.journal.append(f.receipt(report.report))
    assert.equal((await f.mission()).tasks[0].report?.notificationStatus, "admitted")
    assert.equal((await f.mission()).tasks[0].nativeExecution?.ended, undefined)
    assert.equal((await f.snapshot()).discardedEvents, 0)
  }
})

test("native-return delivery rejects even canonical coordinator receipts and preserves pending status/raw bytes", async () => {
  const f = fixture(); await f.setup(); const report = f.report(); await f.journal.append(report)
  const receipt = f.receipt(report.report)
  assert.notEqual(parseMissionEvent(receipt), undefined, "route correlation needs the report, not an event-only decoder")
  await f.journal.append(receipt)
  const key = `${MISSION_JOURNAL_STORAGE_PREFIX}/${f.journal.projectToken}/${receipt.missionID}/${receipt.id}`
  const bytes = JSON.stringify(f.values.get(key)), snapshot = await f.snapshot()
  assert.equal(snapshot.discardedEvents, 1)
  assert.equal(snapshot.notificationUnavailable, true)
  assert.equal(snapshot.missions[0].notificationUnavailable, true)
  assert.equal(snapshot.missions[0].reports[0].notificationStatus, "pending")
  assert.equal(snapshot.missions[0].tasks[0].report?.notificationStatus, "pending")
  assert.equal(snapshot.missions[0].tasks[0].nativeExecution?.ended, undefined)
  assert.equal(JSON.stringify(f.values.get(key)), bytes)
  assert.equal(hasInvalidReportNotificationHistory((await f.journal.events()).events), true)
})

test("descriptor-free native reports retain historical coordinator receipt behavior without fabricating provenance", async () => {
  const f = fixture(null); await f.create()
  await f.journal.append(f.bound()); const report = f.rootReport(); await f.journal.append(report); await f.journal.append(f.receipt(report.report))
  const snapshot = await f.snapshot(), saved = snapshot.missions[0].tasks[0].report!
  assert.equal(snapshot.discardedEvents, 0)
  assert.equal(snapshot.notificationUnavailable, undefined)
  assert.equal(saved.notificationStatus, "admitted")
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "nativeCall"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "delivery"), false)
  assert.equal((await f.mission()).tasks[0].nativeExecution?.ended, undefined)
  assert.equal(hasInvalidReportNotificationHistory((await f.journal.events()).events), false)
  assert.deepEqual(reduceMissionEvents((await f.journal.events()).events).missions[0].reports, snapshot.missions[0].reports)
})
