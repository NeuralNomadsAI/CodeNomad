import assert from "node:assert/strict"
import test from "node:test"
import { missionRecoveryInput } from "./recovery-input"
import type { MissionMap } from "./model"

const mission = (): MissionMap => ({
  version: 1, id: "msn_test", projectID: "project", projectCanonical: "/repo", objective: "Validate", template: "custom",
  status: "active", runState: "running", coordinatorSessionId: "ses_coordinator", revision: 7,
  actors: ["ses_coordinator", "ses_worker"].map((sessionId, index) => ({ sessionId, kind: index ? "specialist" : "coordinator",
    managed: Boolean(index), title: "Actor", roles: [], location: { directory: "/repo" }, joinedAt: 1 })),
  tasks: [{ id: "tsk_test", key: "validation", title: "Validate", brief: "Existing work", role: "specialist", blockedBy: [],
    status: "queued", actorSessionId: "ses_worker", admissionId: "msg_assignment", delivery: "queue", outstandingExecution: false, createdAt: 1, updatedAt: 2 }],
  reports: [], frontier: [], claims: [], createdAt: 1, updatedAt: 2, history: [], historyTruncated: false,
})

test("targeted recovery uses a stable native ID without repeating an assignment", () => {
  const map = mission()
  const request = { missionID: map.id, expectedRevision: 7, target: "report" as const, taskKey: "validation" }
  const first = missionRecoveryInput(map, request)
  assert.deepEqual(missionRecoveryInput(structuredClone(map), request), first)
  assert.equal(first.sessionID, "ses_worker")
  assert.notEqual(first.id, map.tasks[0].admissionId)
  assert.match(first.text, /do not rerun completed work/)
  assert.equal(first.delivery, "queue")
  assert.equal(first.resume, true)
  assert.notEqual(missionRecoveryInput(map, { missionID: map.id, expectedRevision: 7, target: "coordinator" }).id, first.id)
  map.revision++
  assert.notEqual(missionRecoveryInput(map, { ...request, expectedRevision: 8 }).id, first.id)
})

test("recovery cannot bypass lifecycle, stale plans, or a settled report", () => {
  const request = { missionID: "msn_test", expectedRevision: 7, target: "report" as const, taskKey: "validation" }
  for (const state of ["paused", "prepared", "stopped"] as const) {
    const map = mission(); map.runState = state
    assert.throws(() => missionRecoveryInput(map, request), /not running/)
  }
  const map = mission()
  assert.throws(() => missionRecoveryInput(map, { ...request, expectedRevision: 6 }), /changed/)
  assert.throws(() => missionRecoveryInput(map, { ...request, missionID: "msn_other" }), /not found/)
  assert.throws(() => missionRecoveryInput(map, { ...request, taskKey: "missing" }), /outstanding report/)
  map.tasks[0].status = "withdrawn"
  assert.throws(() => missionRecoveryInput(map, request), /outstanding report/)
  map.tasks[0].outstandingExecution = true
  assert.equal(missionRecoveryInput(map, request).sessionID, "ses_worker", "retired admitted work still needs a terminal report")
  map.tasks[0].report = { id: "rpt_test", taskKey: "validation", sessionId: "ses_worker", outcome: "completed", summary: "Done", evidence: [], next: [], createdAt: 3 }
  assert.throws(() => missionRecoveryInput(map, request), /outstanding report/)
})

test("coordinator recovery rejects an unrelated task parameter", () => {
  assert.throws(() => missionRecoveryInput(mission(), { missionID: "msn_test", expectedRevision: 7, target: "coordinator", taskKey: "validation" }), /Invalid recovery target/)
})

const binding = { generation: 1, parentSessionID: "ses_coordinator", toolCallID: "call-one", parentMessageID: "message-one" }
const request = { missionID: "msn_test", expectedRevision: 7, target: "report" as const, taskKey: "validation" }
const nativeMission = () => {
  const map = mission(), task = map.tasks[0]
  delete task.admissionId
  delete task.delivery
  task.nativeBinding = binding
  task.nativeExecution = { binding, ended: "returned" }
  return map
}

test("native-bound missing reports recover with a stable nudge, never an invented inbox admission", () => {
  const map = nativeMission(), before = structuredClone(map)
  const input = missionRecoveryInput(map, request)
  assert.equal(input.sessionID, "ses_worker")
  assert.deepEqual(input, missionRecoveryInput(structuredClone(map), request))
  assert.equal(map.tasks[0].admissionId, undefined)
  assert.match(input.text, /not a new assignment/)
  assert.match(input.text, /do not rerun completed work/)
  assert.deepEqual(map, before)
})

test("active native continuations cannot recover through an old completed report or historical return", () => {
  for (const completedReport of [false, true]) {
    const map = nativeMission(), task = map.tasks[0]
    task.nativeBinding = { ...binding, nativeReturned: true }
    task.nativeExecution = { binding: { ...binding, toolCallID: "call-two", parentMessageID: "message-two" } }
    if (completedReport) {
      task.status = "completed"
      task.report = { id: "old-report", taskKey: task.key, sessionId: "ses_worker", outcome: "completed", summary: "Old result", evidence: [], next: [], createdAt: 3 }
    }
    assert.throws(() => missionRecoveryInput(map, request), error => Boolean(error && typeof error === "object" && "code" in error && error.code === "recovery-busy"))
  }
})

test("partial or changed native invocation evidence fails closed rather than falling back to an admission ID", () => {
  for (const corrupt of ["missing", "generation", "parent"] as const) {
    const map = nativeMission(), task = map.tasks[0]
    task.admissionId = "msg_historical"
    task.nativeBinding = { ...binding, nativeReturned: true }
    if (corrupt === "missing") delete task.nativeExecution
    else task.nativeExecution = { binding: { ...binding, ...(corrupt === "generation" ? { generation: 2 } : { parentSessionID: "foreign" }) }, ended: "returned" }
    assert.throws(() => missionRecoveryInput(map, request), error => Boolean(error && typeof error === "object" && "code" in error && error.code === "recovery-unknown"))
  }
})

test("ended failed calls do not manufacture withdrawn outstanding execution", () => {
  const map = nativeMission(), task = map.tasks[0]
  task.nativeExecution = { binding, ended: "error" }
  task.status = "withdrawn"
  assert.throws(() => missionRecoveryInput(map, request), /outstanding report/)
  assert.equal(task.outstandingExecution, false)
  task.outstandingExecution = true
  assert.equal(missionRecoveryInput(map, request).sessionID, "ses_worker")
  task.lateReports = [{ id: "late-report", taskKey: task.key, sessionId: "ses_worker", outcome: "failed", summary: "Existing error", evidence: [], next: [], late: true, createdAt: 3 }]
  assert.throws(() => missionRecoveryInput(map, request), /outstanding report/)
})

test("native evidence never bypasses paused, prepared, stopped or pending-control policy", () => {
  for (const state of ["paused", "prepared", "stopped"] as const) {
    const map = nativeMission(); map.runState = state
    assert.throws(() => missionRecoveryInput(map, request), /not running/)
  }
  const stopped = nativeMission(); stopped.status = "stopped"
  assert.throws(() => missionRecoveryInput(stopped, request), /not running/)
  const pending = nativeMission()
  pending.control = { id: "control", pending: ["ses_worker"] } as NonNullable<import("./model").MissionMap["control"]>
  assert.throws(() => missionRecoveryInput(pending, request), /control is pending/)
})

test("a stale-generation settled native call cannot admit a recovery nudge", () => {
  const map = nativeMission()
  map.tasks[0].contractGeneration = binding.generation + 1
  assert.throws(() => missionRecoveryInput(map, request), error => Boolean(error && typeof error === "object" && "code" in error && error.code === "recovery-unknown"))
})
