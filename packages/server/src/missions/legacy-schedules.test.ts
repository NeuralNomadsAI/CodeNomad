import assert from "node:assert/strict"
import test from "node:test"
import { legacySchedule, legacyScheduleKey, legacyTombstone } from "./legacy-schedules"
import { missionTombstoneSchema } from "./mission-document"

const stored = (extra: Record<string, unknown> = {}) => ({ id: "msn_sync", state: "running", blocked: null, configuration: { title: "Sync" },
  calendars: [{ scheduleID: "aut_1", sessionID: "ses_cn_schedule_a" }],
  calendarOwner: { slots: [{ scheduleID: "aut_1", sessionID: "ses_cn_schedule_a" }, { scheduleID: "aut_2", sessionID: "ses_cn_schedule_b" }],
    retired: [{ descriptor: { scheduleID: "aut_0", sessionID: "ses_cn_schedule_old" } }] }, ...extra })

test("a stored schedule is read with what woke it; other documents are not schedules", () => {
  assert.deepEqual(legacySchedule(stored()), { id: "msn_sync", configuration: { title: "Sync" }, running: true, busy: false,
    automations: ["aut_1", "aut_2", "aut_0"], carriers: ["ses_cn_schedule_a", "ses_cn_schedule_b", "ses_cn_schedule_old"] })
  assert.deepEqual([{ state: "paused" }, { blocked: "failed" }, { state: "stopped" }].map(extra => legacySchedule(stored(extra))!.running), [false, false, false])
  assert.equal(legacySchedule(stored({ calendars: undefined, calendarOwner: undefined }))!.automations.length, 0)
  assert.equal(legacySchedule(stored({ pending: { id: "psg_1" } }))!.busy, true)
  for (const other of [stored({ deletedAt: 1 }), stored({ oneTime: { coordinatorSessionID: "ses_1" } }), stored({ configuration: undefined }), stored({ id: 1 }), null, "text", []])
    assert.equal(legacySchedule(other), undefined)
  assert.equal(legacySchedule(stored({ oneTime: {}, dormantJournal: {} }))!.id, "msn_sync", "a one-time document turned schedule is one")
})

test("schedules are stored per project under one prefix", () => {
  const project = { id: "project", canonical: "D:\\project" }
  assert.match(legacyScheduleKey(project), /^codenomad-missions\/documents-v1\/project\/[a-f0-9]{24}\/missions\/$/)
  assert.equal(legacyScheduleKey(project, "msn_sync"), legacyScheduleKey(project) + "msn_sync")
  assert.notEqual(legacyScheduleKey({ ...project, canonical: "D:\\other" }), legacyScheduleKey(project))
})

test("a schedule taken over is left deleted the way the recurring engine deletes one", () => {
  const identity = { projectID: "project", projectCanonical: "D:\\project", revision: 1379, timeGeneration: 4 }
  const asked = legacyTombstone(stored({ ...identity, deletion: { requestID: "asked", expectedRevision: 1363, deleteManagedSessions: false, requestedAt: 5 } }), 9)
  assert.deepEqual(missionTombstoneSchema.parse(asked), { version: 1, id: "msn_sync", ...identity, revision: 1380, requestID: "asked", expectedRevision: 1363,
    deleteManagedSessions: false, deletedAt: 9 })
  assert.deepEqual(missionTombstoneSchema.parse(legacyTombstone(stored(identity), 9)), { version: 1, id: "msn_sync", ...identity, revision: 1380,
    requestID: "takeover_msn_sync", expectedRevision: 1379, deleteManagedSessions: false, deletedAt: 9 })
  assert.equal(legacySchedule(asked), undefined)
  assert.equal(legacyTombstone(asked, 10), undefined, "already deleted")
  assert.equal(legacyTombstone(stored({ oneTime: {} }), 9), undefined, "a one-time Mission is not one")
})