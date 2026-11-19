import assert from "node:assert/strict"
import { test } from "node:test"
import { compareEvents, createOrderedMissionFold, orderedMissionLookups, reduceMissionEvents,
  type MissionCreatedEvent, type MissionEvent } from "./model"
import { controlReceiptID, reportAdmissionID, reportNotificationID } from "./receipt-identity"

const scope = { version: 1, projectID: "project", missionID: "mission" } as const
const target = { sessionID: "coordinator", location: { directory: "/project" } }
const creation: MissionCreatedEvent = {
  ...scope, type: "mission.created", id: "created", createdAt: 1, prepared: true,
  projectCanonical: "/project", template: "custom", objective: "Start", coordinator: { ...target, title: "Coordinator" },
}
const start = {
  ...scope, type: "mission.control-requested", id: "start", createdAt: 2, action: "start",
  requestID: "play", expectedRevision: 1, targets: [target],
} as const satisfies MissionEvent
const startReceipt: MissionEvent = {
  ...scope, type: "mission.control-applied", id: controlReceiptID(start.id, target.sessionID),
  createdAt: 3, operationID: start.id, sessionID: target.sessionID,
}

function differential(events: MissionEvent[], batchSize: number) {
  const ordered = [...events].sort(compareEvents)
  const byID = new Map(events.map(event => [event.id, event]))
  const byReportID = new Map(ordered.flatMap(event => event.type === "task.reported" ? [[event.report.id, event] as const] : []))
  let lookups: ReturnType<typeof orderedMissionLookups>
  const fold = createOrderedMissionFold({ created: ordered.find(event => event.type === "mission.created"),
    readEvent: id => { assert(lookups.events.has(id)); return byID.get(id) },
    readReport: id => { assert(lookups.reports.has(id)); return byReportID.get(id) } })
  for (let offset = 0; offset < ordered.length; offset += batchSize) {
    const batch = ordered.slice(offset, offset + batchSize)
    lookups = orderedMissionLookups(batch)
    fold.append(batch)
  }
  const actual = fold.finish()
  const expected = reduceMissionEvents(events, 0)
  assert.deepEqual(actual, { mission: expected.missions[0], discardedEvents: expected.discardedEvents,
    ...(expected.controlUnavailable ? { controlUnavailable: true } : {}),
    ...(expected.notificationUnavailable ? { notificationUnavailable: true } : {}) })
  return actual
}

test("folds 10,020 events in batches with the legacy revision, latest briefing and bounded plan history", () => {
  const events: MissionEvent[] = [creation, start, startReceipt]
  for (let revision = events.length; revision < 10_020; revision++) {
    const id = `event-${revision}`, createdAt = revision + 1
    events.push(revision % 10 === 0 ? {
      ...scope, id, type: "mission.updated", requestID: id, createdAt, expectedRevision: revision,
      notesSpecified: true, objective: `Objective ${revision}`, notes: `${revision}: ${"large notes ".repeat(250)}`,
    } : {
      ...scope, id, type: "mission.briefed", actorSessionID: target.sessionID, createdAt,
      briefing: { id, requestID: `auto:${revision}`, basedOnRevision: revision, basedOnUpdatedAt: createdAt - 1, createdAt,
        summary: `Briefing ${revision}`, achieved: [], ongoing: [], obstacles: [], next: [] },
    })
  }
  const { mission } = differential(events.reverse(), 37)
  assert.equal(mission?.revision, 10_020)
  assert.equal(mission?.briefing?.summary, "Briefing 10019")
  assert.equal(mission?.history.length, 50)
  assert.equal(mission?.control?.completedRevision, 3)
})

test("checks slot collisions and earlier receipts across batch boundaries", () => {
  const reportID = "report"
  const receipt: MissionEvent = {
    ...scope, type: "report.notified", id: reportNotificationID(scope.missionID, reportID), createdAt: 0,
    reportID, admissionID: reportAdmissionID(reportID),
  }
  const report: MissionEvent = {
    ...scope, type: "task.reported", id: "historical-event-alias", createdAt: 7, report: {
      id: reportID, taskKey: "task", sessionId: target.sessionID, summary: "Done", evidence: [], next: [], outcome: "completed",
      delivery: "coordinator-readout", createdAt: 7,
    },
  }
  const task: MissionEvent = { ...scope, type: "task.created", id: "task", createdAt: 6,
    task: { id: "task", key: "task", role: "specialist", title: "Task", brief: "Do it", blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null } } }
  const shadow: MissionEvent = { ...scope, type: "mission.finished", outcome: "failed", summary: "Shadow",
    id: startReceipt.id, createdAt: 4 }
  const reopened: MissionEvent = { ...scope, type: "mission.reopened", id: "reopen", createdAt: 5, expectedRevision: 4 }
  const { mission, controlUnavailable, notificationUnavailable } = differential(
    [receipt, creation, start, shadow, reopened, task, report], 1)
  assert.equal(controlUnavailable, true)
  assert.equal(notificationUnavailable, true)
  assert.equal(mission?.status, "active")
  assert.deepEqual(mission?.control?.pending, [target.sessionID])
  differential([creation, { ...startReceipt, createdAt: 0 }, start, task, report], 2)
})

test("projects only the previous Pause at its proper cut and preserves terminal history", () => {
  const pause = { ...start, id: "pause", action: "pause", createdAt: 4, requestID: "pause", expectedRevision: 3, graceful: true } as const
  const play = { ...start, id: "play", createdAt: 5, requestID: "resume", expectedRevision: 4, targets: [] }
  const finish: MissionEvent = { ...scope, type: "mission.finished", id: "finish", createdAt: 6, outcome: "completed", summary: "Finished", sequence: 42 }
  const stop = { ...start, id: "stop", action: "stop", createdAt: 7, requestID: "stop", expectedRevision: 6 } as const
  const tombstone: MissionEvent = { ...scope, id: "deleted", type: "mission.deleted", createdAt: 8, requestID: "delete",
    expectedRevision: 7, deleteManagedSessions: false, cleanupTargets: [] }
  const events = [creation, start, startReceipt, pause, play, finish, stop] satisfies MissionEvent[]
  assert.deepEqual(differential(events.slice(0, 5), 1).mission?.control?.pausedDescendants,
    { sessions: [], partial: false, graceful: true })
  assert.equal(differential(events, 2).mission?.status, "completed")
  assert.equal(differential([...events, tombstone], 2).mission, undefined)
  assert.equal(differential(events.slice(1), 2).discardedEvents, events.length - 1)
})

test("addresses historical before/after texts by their source events, including an omitted notes pair", () => {
  const event = (revision: number, notesSpecified: boolean, notes?: string): MissionEvent => ({
    ...scope, id: `edit-${revision}`, type: "mission.updated", requestID: `edit-${revision}`, expectedRevision: revision,
    createdAt: revision + 1, objective: `edit ${revision}`, notesSpecified, notes,
  })
  const ref: unknown[] = []
  const fold = createOrderedMissionFold({ created: creation, readEvent: () => undefined, readReport: () => undefined,
    onChange: (_change, source) => ref.push(source) })
  fold.append([creation, event(1, true, "notes")])
  fold.append([event(2, false), event(3, true, "replacement")])
  assert.deepEqual(ref.at(-1), { eventID: "edit-3", objective: { before: "edit-2", after: "edit-3" },
    notes: { before: "edit-2", after: "edit-3" } })
  assert.equal(fold.finish().mission?.notes, "replacement")
})
