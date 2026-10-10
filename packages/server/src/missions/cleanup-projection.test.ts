import assert from "node:assert/strict"
import test from "node:test"
import { cleanupReceiptID, hasInvalidCleanupHistory, projectMissionCleanups } from "./cleanup-projection"
import { parseMissionEvent } from "./journal"
import type { MissionEvent } from "./model"

function events(id: string, time: number): MissionEvent[] {
  const base = { version: 1 as const, missionID: id, projectID: "project", createdAt: time }
  return [
    { ...base, id: `${id}-create`, type: "mission.created", objective: "Original", projectCanonical: "/private", template: "custom",
      coordinator: { sessionID: "ses_coordinator", title: "Coordinator", location: { directory: "/private" } } },
    { ...base, createdAt: time + 0.1, id: `${id}-update`, type: "mission.updated", objective: "Latest objective", requestID: "edit", expectedRevision: 1, notesSpecified: false },
    { ...base, createdAt: time + 0.2, id: `${id}-delete`, type: "mission.deleted", requestID: `request-${id}`, expectedRevision: 4, deleteManagedSessions: true,
      cleanupTargets: [{ sessionID: "ses_actor", location: { directory: "/private" } }] },
  ]
}

test("cleanup projection retains exact request and pending target counts outside the active map", () => {
  const history = events("pending", 1)
  const entry = projectMissionCleanups(history)[0]
  assert.equal(entry.requestID, "request-pending"); assert.equal(entry.expectedRevision, 4)
  assert.equal(entry.deletionID, "pending-delete"); assert.equal(entry.deleteManagedSessions, true)
  assert.equal(entry.objective, "Latest objective"); assert.equal(entry.pending, 1)
  history.push({ version: 1, id: cleanupReceiptID("pending-delete", "ses_actor"), missionID: "pending", projectID: "project", createdAt: 2,
    type: "mission.session-cleaned", deletionID: "pending-delete", sessionID: "ses_actor", outcome: "retained", reason: "children" })
  assert.deepEqual(projectMissionCleanups(history)[0], { ...entry, pending: 0, retained: 1, reasons: ["children"] })
})

test("newer completed summaries cannot evict an older pending deletion", () => {
  const history = events("pending", 1)
  for (let index = 0; index < 40; index++) {
    const id = `complete-${index}`
    history.push(...events(id, index + 2), { version: 1, id: cleanupReceiptID(`${id}-delete`, "ses_actor"), missionID: id, projectID: "project", createdAt: index + 3,
      type: "mission.session-cleaned", deletionID: `${id}-delete`, sessionID: "ses_actor", outcome: "removed" })
  }
  const projection = projectMissionCleanups(history)
  assert.equal(projection.length, 21); assert.equal(projection[0].missionID, "pending")
  assert.equal(projection[0].pending, 1)
  assert.equal(hasInvalidCleanupHistory(history), false, "summary display limit is not corruption")
})

test("unrelated receipts do not settle immutable targets and unknown reason metadata never invalidates terminal receipts", () => {
  const history = events("pending", 1)
  history.push({ version: 1, id: "other", missionID: "pending", projectID: "foreign", createdAt: 2,
    type: "mission.session-cleaned", deletionID: "pending-delete", sessionID: "ses_actor", outcome: "removed" })
  assert.equal(projectMissionCleanups(history)[0].pending, 1)
  const receipt = parseMissionEvent({ version: 1, id: "evt_receipt", missionID: "msn_pending", projectID: "project", createdAt: 2,
    type: "mission.session-cleaned", deletionID: "evt_deleted", sessionID: "ses_actor", outcome: "retained", reason: "future-unknown" })
  assert.equal(receipt?.type, "mission.session-cleaned")
  if (receipt?.type === "mission.session-cleaned") assert.equal(receipt.reason, undefined)
})
