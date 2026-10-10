import assert from "node:assert/strict"
import test from "node:test"
import { canRecoverMissionReport, hasUnreturnedNativeInvocation, missionActivityKey, missionNativeCallKey, missionReportNotificationKey, missionTaskStatusKey, partialInterrupt, type MissionNativeTask } from "./mission-native-execution-model.ts"

const binding = { generation: 2, parentSessionID: "parent", parentMessageID: "message", toolCallID: "call" }
const task = (patch: Partial<MissionNativeTask> = {}): MissionNativeTask => ({ status: "queued", contractGeneration: 2,
  actorSessionId: "child", nativeBinding: binding, nativeExecution: { binding }, outstandingExecution: false, ...patch })
const report = { id: "report", taskKey: "task", sessionId: "child", outcome: "completed" as const, summary: "Evidence", evidence: [], next: [], createdAt: 1 }

test("native status never borrows inbox admission language and planning is explicit", () => {
  assert.equal(missionTaskStatusKey(task()), "missions.control.native.bound")
  assert.equal(missionTaskStatusKey(task({ status: "ready", nativeBinding: undefined, nativeExecution: undefined,
    executionMode: { kind: "native", parentTaskKey: null } })), "missions.control.native.planned")
  assert.equal(missionTaskStatusKey(task({ status: "blocked", executionMode: { kind: "native", parentTaskKey: null } })), "missions.control.task.status.blocked")
  assert.equal(missionTaskStatusKey(task({ nativeBinding: undefined, nativeExecution: undefined, admissionId: "input" })), "missions.control.task.status.queued")
  assert.equal(missionTaskStatusKey(task({ status: "withdrawn" })), "missions.control.task.status.superseded")
})

test("a newer unreturned call remains visible despite an old completed business report", () => {
  const current = task({ report, nativeExecution: { binding: { ...binding, toolCallID: "later", parentMessageID: "later-message" } } })
  assert.equal(hasUnreturnedNativeInvocation(current), true)
  assert.equal(canRecoverMissionReport(current, "idle-without-report"), false)
  for (const ended of ["returned", "error"] as const) assert.equal(hasUnreturnedNativeInvocation(task({ nativeExecution: { binding, ended } })), false)
})

test("native report recovery requires recorded current return, observed idle, current generation and no outstanding work", () => {
  for (const ended of ["returned", "error"] as const) {
    const endedTask = task({ nativeExecution: { binding, ended } })
    assert.equal(canRecoverMissionReport(endedTask, "idle-without-report"), true, "no inbox admission ID is needed")
    for (const activity of [undefined, "unknown", "running", "queued", "background", "permission", "form", "missing"] as const)
      assert.equal(canRecoverMissionReport(endedTask, activity), false)
    for (const patch of [{ report }, { lateReports: [{ ...report, late: true }] }, { outstandingExecution: true },
      { contractGeneration: 3 }, { contractGeneration: undefined }, { actorSessionId: undefined }])
      assert.equal(canRecoverMissionReport({ ...endedTask, ...patch }, "idle-without-report"), false)
  }
  assert.equal(canRecoverMissionReport(task(), "idle-without-report"), false)
  assert.equal(canRecoverMissionReport(task({ nativeExecution: undefined }), "idle-without-report"), false)
  assert.equal(canRecoverMissionReport(task({ status: "withdrawn", nativeExecution: { binding, ended: "returned" } }), "idle-without-report"), false)
  assert.equal(canRecoverMissionReport(task({ nativeExecution: { binding: { ...binding, parentSessionID: "other" }, ended: "returned" } }), "idle-without-report"), false)
})

test("root admission recovery keeps its unknown preflight but never recovers an already recorded report", () => {
  const root = task({ nativeBinding: undefined, nativeExecution: undefined, admissionId: "input" })
  assert.equal(canRecoverMissionReport(root), true)
  assert.equal(canRecoverMissionReport(root, "unknown"), true)
  assert.equal(canRecoverMissionReport(root, "running"), false)
  assert.equal(canRecoverMissionReport({ ...root, status: "withdrawn" }), false)
  assert.equal(canRecoverMissionReport({ ...root, status: "withdrawn", outstandingExecution: true }), true)
  assert.equal(canRecoverMissionReport({ ...root, report }), false)
})

test("activity, business completion and notification admission stay separate projections", () => {
  assert.equal(missionNativeCallKey(task()), "missions.control.native.call.unreturned")
  for (const ended of ["returned", "error"] as const)
    assert.equal(missionNativeCallKey(task({ nativeExecution: { binding, ended } })), `missions.control.native.call.${ended}`)
  assert.equal(missionNativeCallKey(task({ nativeExecution: undefined })), "missions.control.execution.unknown")
  const uncorrelated = task({ nativeBinding: undefined, admissionId: "input", nativeExecution: { binding, ended: "returned" } })
  assert.equal(missionNativeCallKey(uncorrelated), "missions.control.execution.unknown")
  assert.equal(canRecoverMissionReport(uncorrelated, "idle-without-report"), false)
  assert.equal(missionActivityKey("queued", true), "missions.control.native.activityQueued")
  assert.equal(missionActivityKey("queued", false), "missions.control.activity.state.queued")
  assert.equal(missionActivityKey(undefined, true), "missions.control.activity.state.unknown")
  for (const notificationStatus of ["pending", "admitted", undefined] as const) {
    const business = { ...report, notificationStatus, late: true }
    assert.equal(missionReportNotificationKey(business), `missions.control.report.notification.${notificationStatus ?? "unknown"}`)
    assert.equal(business.outcome, "completed")
    assert.equal(hasUnreturnedNativeInvocation(task({ report: business })), true)
  }
})

test("native-parent report readout never promises an automatic coordinator outbox send", () => {
  assert.equal(missionReportNotificationKey({ notificationStatus: "pending", delivery: "native-return" }), "missions.control.report.notification.nativeReturnPending")
  assert.equal(missionReportNotificationKey({ notificationStatus: "admitted", delivery: "native-return" }), "missions.control.report.notification.admitted")
  assert.equal(missionReportNotificationKey({ delivery: "native-return" }), "missions.control.report.notification.unknown")
  assert.equal(missionReportNotificationKey({ notificationStatus: "pending", delivery: "coordinator-notification" }), "missions.control.report.notification.pending")
})

test("coordinator business readout has no notification projection, even with a stale status", () => {
  for (const notificationStatus of [undefined, "pending", "admitted"] as const)
    assert.equal(missionReportNotificationKey({ delivery: "coordinator-readout", notificationStatus }), undefined)
})

test("only an explicit incomplete family summary on the latest Pause/Stop reports sub-agents that may still run", () => {
  const ack = (complete?: boolean) => ({ missionID: "m", operationID: "op", sessionID: "c", action: "stop" as const, disposition: "interrupt-observed" as const,
    interrupt: { interrupted: true }, cancellations: [], ...(complete === undefined ? {} : {
      descendants: { observed: 3, interrupted: 3, cancelled: 0, unconfirmed: complete ? 0 : 1, complete, sessions: [] } }) })
  const control = (action: "start" | "pause" | "stop", complete?: boolean) => ({ control: { id: "op", missionID: "m", requestID: "r", expectedRevision: 1, action,
    targets: [], pending: [], receipts: [{ receiptID: "x", sessionID: "c", acknowledgementState: "known" as const, nativeAcknowledgement: ack(complete) as never }] } })
  assert.equal(partialInterrupt({}), false)
  assert.equal(partialInterrupt(control("stop", false)), true)
  assert.equal(partialInterrupt(control("pause", false)), true)
  assert.equal(partialInterrupt(control("stop", true)), false)
  assert.equal(partialInterrupt(control("stop")), false, "legacy receipts claim nothing")
  assert.equal(partialInterrupt(control("start", false)), false)
})
