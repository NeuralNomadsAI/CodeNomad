import assert from "node:assert/strict"
import test from "node:test"
import { deletionErrorKey, missionCleanupPending, MissionDeletionError } from "./mission-cleanup"

test("only the declared cleanup-pending 503 means remaining cleanup; other failures stay redacted and unconfirmed", () => {
  assert.equal(deletionErrorKey(new MissionDeletionError(503, "cleanup-pending")), "missions.cleanup.error.pending")
  assert.equal(deletionErrorKey(new MissionDeletionError(403, "cleanup-pending")), "missions.cleanup.error.forbidden")
  assert.equal(deletionErrorKey(new MissionDeletionError(409, "revision-conflict")), "missions.control.mutation.conflict")
  assert.equal(deletionErrorKey(new MissionDeletionError(404, "mission-not-found")), "missions.cleanup.error.missing")
  assert.equal(deletionErrorKey(new MissionDeletionError(503)), "missions.cleanup.error.unconfirmed")
  assert.equal(deletionErrorKey(new MissionDeletionError(503, "control-pending")), "missions.cleanup.error.unconfirmed")
  assert.equal(deletionErrorKey(new Error("private transport detail")), "missions.cleanup.error.unconfirmed")
})

test("deletion stays pending until native cleanup and document compaction are both confirmed", () => {
  assert.equal(missionCleanupPending({ pending: 0 }), false, "journal-only deletion")
  assert.equal(missionCleanupPending({ pending: 0, documentPending: false }), false)
  assert.equal(missionCleanupPending({ pending: 1, documentPending: false }), true)
  assert.equal(missionCleanupPending({ pending: 0, documentPending: true }), true)
  assert.equal(missionCleanupPending({ pending: 1, documentPending: true }), true)
})
