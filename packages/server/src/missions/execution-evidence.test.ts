import assert from "node:assert/strict"
import test from "node:test"
import { missionTaskExecutionEvidence } from "./execution-evidence"
import type { MissionTask } from "./model"

const binding = { generation: 1, parentSessionID: "parent", toolCallID: "call-one", parentMessageID: "message-one" }
const task = (overrides: Partial<MissionTask> = {}): MissionTask => ({
  id: "task", key: "task", title: "Task", brief: "Brief", role: "specialist", blockedBy: [], status: "queued",
  actorSessionId: "child", createdAt: 1, updatedAt: 1, outstandingExecution: false, ...overrides,
})
const report = { id: "report", taskKey: "task", sessionId: "child", outcome: "completed" as const,
  summary: "Done", evidence: [], next: [], createdAt: 2 }

test("independent inbox evidence and native binding are distinct execution evidence", () => {
  assert.deepEqual(missionTaskExecutionEvidence(task({ admissionId: "assignment" })),
    { hasExecution: true, nativeCall: "none", missingReport: true })
  const native = task({ nativeBinding: binding, nativeExecution: { binding, ended: "returned" } })
  assert.deepEqual(missionTaskExecutionEvidence(native), { hasExecution: true, nativeCall: "ended", missingReport: true })
  assert.equal(native.admissionId, undefined)
  assert.deepEqual(missionTaskExecutionEvidence(task()), { hasExecution: false, nativeCall: "none", missingReport: false })
})

test("historical nativeReturned never settles a current continuation", () => {
  const continuation = { ...binding, toolCallID: "call-two", parentMessageID: "message-two" }
  assert.deepEqual(missionTaskExecutionEvidence(task({ status: "completed", report,
    nativeBinding: { ...binding, nativeReturned: true }, nativeExecution: { binding: continuation } })),
  { hasExecution: true, nativeCall: "active", missingReport: false })
})

test("ended failed continuation does not manufacture outstanding work from an original binding", () => {
  const continuation = { ...binding, toolCallID: "call-two", parentMessageID: "message-two" }
  const value = task({ status: "withdrawn", report, nativeBinding: binding, nativeExecution: { binding: continuation, ended: "error" } })
  assert.deepEqual(missionTaskExecutionEvidence(value), { hasExecution: true, nativeCall: "ended", missingReport: false })
  assert.equal(value.outstandingExecution, false)
  delete value.report
  assert.equal(missionTaskExecutionEvidence(value).missingReport, false, "withdrawn ended work is not inferred outstanding")
  value.status = "queued"
  assert.equal(missionTaskExecutionEvidence(value).missingReport, true, "an ended failed call may still lack a business report")
})

test("outstanding execution remains first-class but settled reports do not become missing", () => {
  const value = task({ status: "withdrawn", outstandingExecution: true })
  assert.deepEqual(missionTaskExecutionEvidence(value), { hasExecution: true, nativeCall: "none", missingReport: true })
  value.lateReports = [{ ...report, late: true }]
  assert.equal(missionTaskExecutionEvidence(value).missingReport, false)
  value.lateReports = []
  value.report = report
  assert.equal(missionTaskExecutionEvidence(value).missingReport, false)
  delete value.actorSessionId
  assert.equal(missionTaskExecutionEvidence(value).hasExecution, false)
})

test("partial or mismatched current native facts remain unknown even with historical return or inbox evidence", () => {
  for (const overrides of [
    { nativeBinding: { ...binding, nativeReturned: true } },
    { nativeExecution: { binding } },
    { nativeBinding: binding, nativeExecution: { binding: { ...binding, generation: 2 } } },
    { nativeBinding: binding, nativeExecution: { binding: { ...binding, parentSessionID: "foreign" } } },
    { nativeBinding: binding, nativeExecution: { binding: { ...binding, toolCallID: "call-two" } } },
    { nativeBinding: binding, nativeExecution: { binding: { ...binding, parentMessageID: "message-two" } } },
    { nativeBinding: { ...binding, generation: 0 }, nativeExecution: { binding } },
    { nativeBinding: binding, nativeExecution: { binding: { ...binding, toolCallID: "" } } },
    { nativeBinding: binding, nativeExecution: { binding, ended: "invented" } },
    { nativeBinding: binding, nativeExecution: {} },
  ]) {
    const value = task({ admissionId: "assignment", ...overrides } as Partial<MissionTask>)
    assert.equal(missionTaskExecutionEvidence(value).nativeCall, "unknown")
  }
})

test("execution evidence reads never mutate historical binding, report or task", () => {
  const value = task({ report, nativeBinding: { ...binding, nativeReturned: true }, nativeExecution: { binding, ended: "returned" } })
  const before = structuredClone(value)
  missionTaskExecutionEvidence(value)
  assert.deepEqual(value, before)
})

test("a recorded contract generation must match native evidence without converting it to send authority", () => {
  const value = task({ contractGeneration: 1, nativeBinding: binding, nativeExecution: { binding, ended: "returned" } })
  assert.equal(missionTaskExecutionEvidence(value).nativeCall, "ended")
  for (const generation of [0, 2, 1.5, NaN]) {
    value.contractGeneration = generation
    assert.equal(missionTaskExecutionEvidence(value).nativeCall, "unknown")
  }
})
