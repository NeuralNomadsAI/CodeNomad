import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionActorActivity, MissionMap, MissionReport, MissionTask } from "../../../server/src/api-types"
import { reduceMissionEvents, type MissionEvent } from "../../../server/src/missions/model"
import { missionExcerpt, missionProgress, missionReportIsPrevious, missionReports, missionTaskHistory, missionTaskReport } from "./mission-progress-model"

const binding = { generation: 1, parentSessionID: "coordinator", toolCallID: "call", parentMessageID: "message" }
const report = (patch: Partial<MissionReport> = {}): MissionReport => ({ id: "report", taskKey: "work",
  sessionId: "actor", outcome: "completed", summary: "Returned evidence", evidence: [], next: [], createdAt: 3, ...patch })
const task = (patch: Partial<MissionTask> = {}): MissionTask => ({ id: "task", key: "work", title: "Work",
  brief: "Work brief", role: "specialist", blockedBy: [], status: "completed", contractGeneration: 1,
  actorSessionId: "actor", createdAt: 1, updatedAt: 3, outstandingExecution: false, report: report(), ...patch })
const mission = (patch: Partial<MissionMap> = {}): MissionMap => ({ version: 1, id: "mission", projectID: "project",
  projectCanonical: "/fixture", objective: "Objective", template: "custom", status: "active", runState: "running",
  coordinatorSessionId: "coordinator", actors: [{ sessionId: "actor", kind: "specialist", managed: false,
    title: "Worker", roles: ["specialist"], location: { directory: "/fixture" }, joinedAt: 1 }],
  tasks: [task()], reports: [report()], frontier: [], claims: [],
  createdAt: 1, updatedAt: 3, revision: 3, history: [], historyTruncated: false, ...patch })

test("report history deduplicates by ID with current copy winning and keeps deterministic newest-first order", () => {
  const current = report({ notificationStatus: "admitted" })
  const late = report({ id: "late", late: true, createdAt: 4 })
  const value = mission({ tasks: [task({ report: current, lateReports: [late, { ...current, late: true }] })],
    reports: [{ ...current, notificationStatus: "pending" }, late, report({ id: "a", createdAt: 4 })] })
  assert.deepEqual(missionReports(value).map(item => item.id), ["a", "late", "report"])
  assert.equal(missionReports(value)[2], current)
  assert.equal(missionTaskReport(value, value.tasks[0]), current)
})

test("missing current reports never fall back to non-late historical results", () => {
  for (const status of ["ready", "blocked", "dispatching", "queued", "completed", "needs-input", "failed"] as const) {
    const value = mission({ tasks: [task({ status, report: undefined })] })
    assert.equal(missionTaskReport(value, value.tasks[0]), undefined, status)
    assert.equal(missionProgress(value).latest, undefined, status)
    assert.deepEqual(missionProgress(value).blockers, [], status)
  }
})

test("current result requires matching task identity, outcome/status and native generation", () => {
  const current = report({ nativeCall: binding })
  for (const patch of [
    { status: "queued" as const }, { status: "withdrawn" as const }, { replacedByTaskKey: "replacement" },
    { report: { ...current, late: true } }, { report: { ...current, taskKey: "other" } },
    { contractGeneration: 2 }, { contractGeneration: undefined },
    { status: "failed" as const }, { status: "needs-input" as const },
  ]) {
    const value = mission({ tasks: [task({ report: current, ...patch })] })
    assert.equal(missionTaskReport(value, value.tasks[0]), undefined)
    assert.equal(missionProgress(value).latest, undefined)
    assert.deepEqual(missionProgress(value).blockers, [])
  }
  const value = mission({ tasks: [task({ report: current, nativeExecution: { binding: { ...binding,
    toolCallID: "later-call", parentMessageID: "later-message" } } })] })
  assert.equal(missionTaskReport(value, value.tasks[0]), current, "business result does not claim a later call ended")
})

test("only active current returned blockages appear; dependency waiting and retired reports stay historical", () => {
  const blocked = task({ status: "needs-input", report: report({ outcome: "blocked" }) })
  const failed = task({ id: "failed", key: "failed", status: "failed", report: report({ id: "failure", taskKey: "failed", outcome: "failed" }) })
  const value = mission({ tasks: [blocked, failed, task({ id: "waiting", key: "waiting", status: "blocked", report: undefined }),
    task({ id: "retired", key: "retired", status: "withdrawn", report: report({ id: "retired-report", taskKey: "retired", outcome: "blocked", createdAt: 100 }) }),
    task({ id: "replaced", key: "replaced", status: "failed", replacedByTaskKey: "failed",
      report: report({ id: "replaced-report", taskKey: "replaced", outcome: "failed", createdAt: 101 }) })] })
  const progress = missionProgress(value)
  assert.deepEqual(progress.blockers, [blocked, failed])
  assert.equal(progress.tasks.length, 3)
  assert.equal(progress.completed, 0)
  assert.equal(progress.latest?.id, "failure")
  assert.equal(missionReports(value)[0].taskKey, "replaced", "history is not deleted")
})

test("latest prefers current source-backed results over newer late, obsolete and unknown-task reports", () => {
  const current = report()
  const value = mission({ tasks: [task({ report: current, lateReports: [report({ id: "late", late: true, createdAt: 10 })] })],
    reports: [report({ id: "obsolete", createdAt: 20 }), report({ id: "unknown", taskKey: "unknown", createdAt: 30 })] })
  assert.equal(missionProgress(value).latest, current)
  const taskless = report({ id: "overview", taskKey: "", sessionId: "coordinator", createdAt: 40 })
  value.reports.push(taskless, report({ id: "foreign-overview", taskKey: "", sessionId: "other", createdAt: 50 }))
  assert.equal(missionProgress(value).latest, taskless)
})

test("worker activity requires an exact owned observation, never queued/admitted input or prose", () => {
  const value = mission({ tasks: [task({ status: "queued", report: undefined, admissionId: "admitted" })] })
  assert.deepEqual(missionProgress(value).activeWorkers, [])
  for (const state of ["queued", "unknown", "form", "permission", "idle-without-report", "missing"] as const)
    assert.deepEqual(missionProgress(value, [{ sessionId: "actor", state }]).activeWorkers, [])
  const activity: MissionActorActivity[] = [{ sessionId: "actor", state: "running" }, { sessionId: "coordinator", state: "background" }]
  assert.deepEqual(missionProgress(value, activity).activeWorkers, [activity[0]])
  assert.equal(missionProgress(value, activity).coordinatorWorking, true)
  assert.deepEqual(missionProgress(value, [{ sessionId: "descendant-mentioned-in-brief", state: "running" }]).activeWorkers, [])
  for (const patch of [{ runState: "prepared" as const }, { runState: "paused" as const },
    { status: "completed" as const }, { status: "failed" as const }, { status: "stopped" as const }]) {
    assert.deepEqual(missionProgress({ ...value, ...patch }, activity).activeWorkers, [activity[0]])
    assert.equal(missionProgress({ ...value, ...patch }, activity).coordinatorWorking, true,
      "Mission lifecycle does not claim native conversation quiescence")
  }
})

test("an active actor shared by queued tasks is one conversation observation, not task execution", () => {
  const queued = task({ status: "queued", report: undefined, admissionId: "admitted" })
  const next = task({ ...queued, id: "next", key: "next", title: "Queued next" })
  const value = mission({ tasks: [queued, next], reports: [] })
  const active: MissionActorActivity = { sessionId: "actor", state: "running" }
  const progress = missionProgress(value, [active, { sessionId: "coordinator", state: "unknown" }])
  assert.deepEqual(progress.activeWorkers, [active])
  assert.deepEqual(progress.ready, [queued, next], "actor activity does not remove queued business work")
  assert.equal("running" in progress, false, "no synthetic running-task attribution")
  assert.equal(progress.coordinatorWorking, false)
  assert.equal(progress.completed, 0)
})

test("completed-task native continuation remains an active worker with an idle coordinator", () => {
  const completed = task({ report: report({ nativeCall: binding }), nativeBinding: { ...binding, nativeReturned: true },
    nativeExecution: { binding: { ...binding, toolCallID: "continuation", parentMessageID: "later-message" } } })
  const value = mission({ tasks: [completed] })
  const active: MissionActorActivity = { sessionId: "actor", state: "running" }
  const progress = missionProgress(value, [active, { sessionId: "coordinator", state: "idle-without-report" }])
  assert.deepEqual(progress.activeWorkers, [active])
  assert.equal(progress.coordinatorWorking, false)
  assert.equal(progress.completed, 1)
  assert.deepEqual(progress.open, [])
  assert.equal(progress.latest, completed.report, "continuation never rewrites the business result")
  assert.deepEqual(missionProgress({ ...value, tasks: [] }, [active]).activeWorkers, [active],
    "conversation observation does not depend on any task business status")
})

test("late returns after retirement/stop are readable history, never current or replacement results", () => {
  const late = report({ id: "late", late: true, nativeCall: binding, summary: "Whole late summary",
    evidence: ["Whole late evidence"], artifact: { source: "retained" }, createdAt: 10 })
  const retired = task({ status: "withdrawn", report: undefined, lateReports: [late], replacedByTaskKey: "replacement" })
  const replacement = task({ id: "replacement", key: "replacement", status: "ready", report: undefined })
  const value = mission({ status: "stopped", tasks: [retired, replacement], reports: [] })
  assert.equal(missionTaskReport(value, retired), undefined)
  assert.deepEqual(missionTaskHistory(value, retired), [late])
  assert.equal(missionTaskHistory(value, retired)[0].summary, "Whole late summary")
  assert.deepEqual(missionTaskHistory(value, retired)[0].evidence, ["Whole late evidence"])
  assert.equal(missionTaskReport(value, replacement), undefined)
  assert.deepEqual(missionTaskHistory(value, replacement), [])
  assert.equal(missionProgress(value).latest, undefined)
  assert.equal(missionProgress(value).completed, 0)
})

test("newer late history stays separate from an authoritative current result without duplicate artifacts", () => {
  const current = report({ artifact: { current: true } })
  const late = report({ id: "late", late: true, createdAt: 10, artifact: { old: true } })
  const currentTask = task({ report: current, lateReports: [late, current] })
  const value = mission({ tasks: [currentTask], reports: [late, current] })
  assert.equal(missionTaskReport(value, currentTask), current)
  assert.deepEqual(missionTaskHistory(value, currentTask), [late])
  assert.equal(missionProgress(value).latest, current)
})

test("an earlier retry report is previous work even when non-late and its task is still in the plan", () => {
  const previous = report({ id: "previous", outcome: "blocked", createdAt: 2 })
  const current = report({ id: "current", outcome: "completed", createdAt: 3 })
  const currentTask = task({ report: current })
  const value = mission({ tasks: [currentTask], reports: [previous, current] })
  assert.equal(missionReportIsPrevious(value, previous), true)
  assert.equal(missionReportIsPrevious(value, current), false)
  assert.deepEqual(missionTaskHistory(value, currentTask), [previous])
  assert.deepEqual(missionReports(value), [current, previous], "exact source records and chronology survive")
  assert.equal(missionReportIsPrevious({ ...value, tasks: [{ ...currentTask, status: "queued", report: undefined }] }, current), true,
    "historical outcome is not displayed as a current result during a later retry")
  assert.equal(missionReportIsPrevious(value, { ...current, late: true }), true)
  assert.equal(missionReportIsPrevious(value, report({ taskKey: "", sessionId: "coordinator" })), false,
    "mission-wide readouts are not relabeled as task attempts")
})

test("real reducer task/readout/final records remain distinct; final summary is not fabricated as a report", () => {
  const base = { version: 1 as const, missionID: "mission", projectID: "project" }
  const events: MissionEvent[] = [
    { ...base, id: "created", createdAt: 1, type: "mission.created", objective: "Objective", projectCanonical: "/fixture",
      template: "custom", coordinator: { sessionID: "coordinator", title: "Coordinator", location: { directory: "/fixture" } } },
    { ...base, id: "task", createdAt: 2, type: "task.created", task: { id: "task", key: "work", title: "Work", brief: "Brief",
      role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } } },
    { ...base, id: "reported", createdAt: 3, type: "task.reported", report: report({ sessionId: "coordinator", delivery: "coordinator-readout" }) },
    { ...base, id: "finished", createdAt: 4, type: "mission.finished", outcome: "completed", summary: "Actual mission final result" },
  ]
  const snapshot = reduceMissionEvents(events)
  assert.equal(snapshot.discardedEvents, 0)
  const value = snapshot.missions[0]
  assert.equal(value.summary, "Actual mission final result")
  assert.equal(missionProgress(value).latest, value.tasks[0].report)
  assert.equal(missionProgress(value).completed, 1)
  assert.equal(missionReports(value).length, 1, "mission.finished is summary/status, not an invented report")
  const empty = reduceMissionEvents([events[0], events[3]]).missions[0]
  assert.equal(empty.summary, "Actual mission final result")
  assert.equal(missionProgress(empty).latest, undefined)
})

test("excerpt collapses whitespace without altering source evidence", () => {
  const value = report({ summary: "  A\n\tlong   result  " })
  assert.equal(missionExcerpt(value.summary), "A long result")
  assert.equal(value.summary, "  A\n\tlong   result  ")
})
