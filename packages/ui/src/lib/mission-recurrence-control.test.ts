import assert from "node:assert/strict"
import test from "node:test"
import { createRecurrenceControlIntent, recurrenceControlStatusInput, completedRecurrenceControl } from "./mission-recurrence-control"

test("simple controls reserve unique requests and only exact completed status releases an uncertain send", () => {
  const intent = createRecurrenceControlIntent("rec_schedule", 4)
  assert.deepEqual(Object.keys(intent).sort(), ["expectedRevision", "requestID", "scheduleID"])
  assert.notEqual(createRecurrenceControlIntent("rec_schedule", 4).requestID, intent.requestID)
  assert.deepEqual(recurrenceControlStatusInput(intent), { scheduleID: intent.scheduleID, requestID: intent.requestID })
  const completed = { scheduleID: intent.scheduleID, requestID: intent.requestID, status: "completed" as const }
  assert.equal(completedRecurrenceControl(completed, intent), true)
  for (const status of ["pending", "partial", "unknown"] as const)
    assert.equal(completedRecurrenceControl({ ...completed, status }, intent), false)
  assert.equal(completedRecurrenceControl({ ...completed, requestID: "another-request" }, intent), false)
  assert.equal(completedRecurrenceControl({ ...completed, scheduleID: "another-schedule" }, intent), false)
})
