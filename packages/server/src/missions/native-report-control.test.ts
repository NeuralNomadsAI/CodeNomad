import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import type { MissionNativeReportAuthorization, MissionNativeReportRequest, MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { MissionJournal, type MissionStorage } from "./journal"
import type { MissionJsonValue, MissionNativeBinding } from "./model"
import { nativeCallObservationID } from "./native-call-reconciliation"
import type { NativeCallObservation } from "./native-call-observation"

const call: MissionNativeBinding = { generation: 1, parentSessionID: "ses_parent", toolCallID: "call_birth", parentMessageID: "msg_parent" }
const report = { outcome: "completed" as const, summary: "Bounded evidence", evidence: ["unit green"], next: [], final: false }

async function fixture(authorize = true, nativeDecision = false) {
  const values = new Map<string, MissionJsonValue>()
  let revoke = false, checks = 0, wakes = 0, sequence = 1
  let onScan: (() => void) | undefined
  let publication: (() => void | Promise<void>) | undefined
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, current) => { await publication?.(); current?.(); values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      onScan?.()
      const keys = [...values.keys()].sort().filter(key => key.startsWith(prefix) && (!after || key > after))
      return { entries: keys.slice(0, limit).map(key => ({ key, value: structuredClone(values.get(key)!) })),
        ...(keys.length > limit ? { next: keys[limit - 1] } : {}) }
    },
  }
  const parent: NativeMissionSession = { id: "ses_parent", projectID: "project-test", title: "Parent", location: { directory: "/repo", workspaceID: "native-workspace" } }
  const child: NativeMissionSession = { ...parent, id: "ses_child", parentID: parent.id, title: "Child" }
  const sessions: MissionSessionAdapter = {
    get: async ({ sessionID }) => {
      const value = sessionID === parent.id ? parent : sessionID === child.id ? child : undefined
      if (!value) throw new Error("missing")
      return structuredClone(value)
    },
    create: async () => { throw new Error("No birth from report") },
    prompt: async () => { throw new Error("No prompt from report") },
    synthetic: async () => { wakes++ },
  }
  const requests: MissionNativeReportRequest[] = []
  const authorizeNativeReport: MissionNativeReportAuthorization = async request => {
    requests.push(structuredClone(request))
    return { call, current: () => { checks++; if (revoke) throw new Error("revoked"); return true } }
  }
  const project = { id: "project-test", canonical: "/repo", location: parent.location }
  const control = new MissionControl({ storage, sessions, project, now: () => sequence++,
    ...(authorize ? { authorizeNativeReport } : {}) })
  const { mission } = await control.create({ requestID: "start", objective: "One bounded task", template: nativeDecision ? "wayfinder" : "custom", coordinatorSessionID: parent.id })
  const journal = new MissionJournal(storage, project.id, project.canonical, () => sequence++)
  const base = () => ({ version: 1 as const, missionID: mission.id, projectID: project.id, createdAt: sequence++ })
  if (nativeDecision) {
    // Inject a syntactically valid accepted-task fixture to test the human-proof
    // ceiling, not to claim full Wayfinder plan/execution qualification.
    await journal.append({ ...base(), id: "decision-contract", type: "task.created",
      task: { id: "tsk_decision", key: "work", title: "Decision", brief: "Ask the human", role: "decision", blockedBy: [],
        executionMode: { kind: "native", parentTaskKey: null } } })
  } else await control.declare(parent.id, { missionID: mission.id, taskKey: "work", title: "Work", brief: "Bounded", role: "specialist", blockedBy: [] })
  await journal.append({ ...base(), id: "bound", type: "task.native-bound", taskKey: "work", binding: call,
    actor: { sessionID: child.id, title: "Child", location: child.location, managed: true } })
  const request: MissionNativeReportRequest = { contract: { missionID: mission.id, taskKey: "work", generation: 1 },
    sessionID: child.id, toolCallID: "call_report", messageID: "msg_child" }
  return { control, journal, parent, child, values, requests, request, base,
    revoke: () => { revoke = true }, checks: () => checks, wakes: () => wakes,
    onScan: (callback?: () => void) => { onScan = callback },
    beforePublication: (callback: () => void | Promise<void>) => { publication = callback } }
}

test("native report commits exact provenance before native return, never wakes coordinator", async () => {
  const f = await fixture()
  const result = await f.control.reportNative(f.request, report)
  assert.equal(result.disposition, "reported")
  assert.deepEqual(result.mission.reports[0].nativeCall, call)
  assert.equal(result.mission.reports[0].delivery, "native-return")
  assert.equal(result.mission.reports[0].notificationStatus, "pending")
  assert.equal(result.mission.tasks[0].nativeExecution?.ended, undefined)
  assert.deepEqual(f.requests, [f.request])
  assert.ok(f.checks() >= 4)
  const repeated = await f.control.reportNative(f.request, report)
  assert.equal(repeated.disposition, "existing")
  assert.equal(repeated.mission.revision, result.mission.revision)
  await assert.rejects(f.control.reportNative(f.request, { ...report, summary: "Changed immutable evidence" }), /different immutable evidence/)
  assert.deepEqual(await f.control.retryPendingNotifications(), { attempted: 0, failed: 0 })
  assert.equal(f.wakes(), 0)
  await assert.rejects(f.control.report(f.parent.id, { ...report, final: true, missionID: f.request.contract.missionID }), /observed invocation end/)
})

test("coordinator readout cannot settle a tracked native invocation or fabricate human proof", async () => {
  const f = await fixture(false)
  const result = await f.control.report(f.parent.id, { ...report, taskKey: "work" })
  assert.equal(result.mission.tasks[0].status, "completed")
  assert.equal(result.mission.tasks[0].report?.delivery, "coordinator-readout")
  assert.equal(result.mission.tasks[0].nativeExecution?.ended, undefined)
  assert.equal(f.requests.length, 0)
  assert.equal(f.wakes(), 0)
  await assert.rejects(f.control.report(f.parent.id, { ...report, final: true }), /observed invocation end/)
  await f.journal.append({ ...f.base(), id: "returned-after-readout", type: "task.native-call-ended",
    taskKey: "work", childSessionID: f.child.id, binding: call, outcome: "returned" })
  assert.equal((await f.control.report(f.parent.id, { ...report, final: true })).mission.status, "completed")
  const human = await fixture(false, true)
  await assert.rejects(human.control.report(human.parent.id, { ...report, taskKey: "work" }), /human-decision evidence unavailable/)
  assert.equal((await human.control.snapshot()).missions[0].reports.length, 0)
})

test("missing authority, sibling, ancestor, wrong generation and finalization refuse without report writes", async () => {
  const unqualified = await fixture(false)
  await assert.rejects(unqualified.control.reportNative(unqualified.request, report), /authority unavailable/)
  const f = await fixture()
  const before = f.values.size
  await assert.rejects(f.control.reportNative({ ...f.request, sessionID: f.parent.id }, report), /No matching task/)
  await assert.rejects(f.control.reportNative({ ...f.request, sessionID: "ses_sibling" }, report), /Session not found/)
  await assert.rejects(f.control.reportNative({ ...f.request, contract: { ...f.request.contract, generation: 2 } }, report), /generation differs/)
  await assert.rejects(f.control.reportNative(f.request, { ...report, final: true }), /never finalization/)
  await assert.rejects(f.control.reportNative(f.request, { ...report, taskKey: "foreign" }), /exact task/)
  assert.equal(f.values.size, before)
  assert.equal(f.wakes(), 0)
})

test("moved actual parent and full Location refuse a native report", async () => {
  const f = await fixture()
  f.child.parentID = "ses_foreign"
  await assert.rejects(f.control.reportNative(f.request, report), /parent or generation differs/)
  f.child.parentID = f.parent.id
  f.child.location = { ...f.child.location, workspaceID: "moved" }
  await assert.rejects(f.control.reportNative(f.request, report), /admitted location/)
  assert.equal(f.wakes(), 0)
})

test("revocation during journal preparation is rechecked at actual publication", async () => {
  const f = await fixture()
  const before = f.values.size
  let scans = 0
  f.onScan(() => { if (++scans === 3) f.revoke() })
  await assert.rejects(f.control.reportNative(f.request, report), /revoked/)
  f.onScan()
  assert.equal(f.values.size, before)
  assert.equal((await f.control.snapshot()).missions[0].reports.length, 0)
  assert.equal(f.wakes(), 0)
})

test("a guarded storage adapter repeats revocation after its own asynchronous preparation", async () => {
  const f = await fixture()
  const before = f.values.size
  f.beforePublication(async () => { await Promise.resolve(); f.revoke() })
  await assert.rejects(f.control.reportNative(f.request, report), /revoked/)
  assert.equal(f.values.size, before)
  assert.equal(f.wakes(), 0)
})

test("an earlier business report does not settle or authorize an active newer continuation", async () => {
  const f = await fixture()
  await f.control.reportNative(f.request, report)
  await f.journal.append({ ...f.base(), id: "old-ended", type: "task.native-call-ended", taskKey: "work", childSessionID: f.child.id,
    binding: call, outcome: "returned" })
  const next = { ...call, toolCallID: "call_again", parentMessageID: "msg_again" }
  await f.journal.append({ ...f.base(), id: "again", type: "task.native-call-started", taskKey: "work", childSessionID: f.child.id, binding: next })
  await assert.rejects(f.control.reportNative(f.request, report), /invocation was not accepted/)
  await assert.rejects(f.control.report(f.parent.id, { ...report, final: true, missionID: f.request.contract.missionID }), /observed invocation end/)
  const mission = (await f.control.snapshot()).missions[0]
  assert.deepEqual(mission.tasks[0].nativeExecution, { binding: next })
  assert.equal(mission.reports.length, 1)
  assert.equal(f.wakes(), 0)
})

test("retired invocation can record late evidence after a continuation without ending that call", async () => {
  const f = await fixture()
  await f.journal.append({ ...f.base(), id: "ended", type: "task.native-call-ended", taskKey: "work", childSessionID: f.child.id,
    binding: call, outcome: "returned" })
  const next = { ...call, toolCallID: "call_next", parentMessageID: "msg_next" }
  await f.journal.append({ ...f.base(), id: "next", type: "task.native-call-started", taskKey: "work", childSessionID: f.child.id, binding: next })
  const current = (await f.control.snapshot()).missions[0]
  await f.control.revise(f.parent.id, { missionID: current.id, requestID: "retire", expectedRevision: current.revision,
    reason: "Keep interrupted historical evidence", retireTasks: [{ taskKey: "work" }], addTasks: [], dependencyUpdates: [] })
  const result = await f.control.reportNative(f.request, report)
  assert.equal(result.mission.reports[0].late, true)
  assert.equal(result.mission.tasks[0].status, "withdrawn")
  assert.deepEqual(result.mission.tasks[0].nativeExecution, { binding: next })
  assert.equal(result.mission.tasks[0].outstandingExecution, true)
  assert.equal(f.wakes(), 0)
})

test("background launch return plus an uncorrelated child success cannot authorize finalization", async () => {
  const f = await fixture()
  await f.control.reportNative(f.request, report)
  const target = { ...f.base(), taskKey: "work", binding: call, childSessionID: f.child.id }
  const observations: NativeCallObservation[] = [
    { kind: "tool-ended", mode: "background", outcome: "returned",
      source: { id: "event-launch", sessionID: f.parent.id, aggregateID: "aggregate-parent", seq: 1, created: 1 } },
    { kind: "child-uncorrelated", outcome: "succeeded",
      source: { id: "event-child", sessionID: f.child.id, aggregateID: "aggregate-child", seq: 1, created: 1 } },
  ]
  for (const observation of observations) await f.journal.append({ ...target, createdAt: f.base().createdAt,
    id: nativeCallObservationID(target, observation), type: "task.native-call-observed", observation })
  await assert.rejects(f.control.report(f.parent.id, { ...report, final: true, missionID: f.request.contract.missionID }), /observed invocation end/)
  assert.equal((await f.control.snapshot()).missions[0].status, "active")
  assert.equal(f.wakes(), 0)
})

test("model-authored and syntactically exact native decision artifacts cannot qualify a human reply", async () => {
  const f = await fixture(true, true)
  const before = f.values.size
  await assert.rejects(f.control.reportNative(f.request, { ...report, artifact: {
    kind: "decision", question: "Choose?", answer: "Yes", humanAnswer: true,
  } }), /exact Form provenance/)
  await assert.rejects(f.control.reportNative(f.request, { ...report, artifact: {
    kind: "decision", question: "Choose?", answer: "Yes", provenance: { kind: "native-form-answer", contract: f.request.contract,
      nativeCall: { ...call }, sessionID: f.child.id, formID: "form_question", messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0" },
  } }), /Durable native human-decision evidence unavailable/)
  assert.equal(f.values.size, before)
  assert.equal(f.wakes(), 0)
})
