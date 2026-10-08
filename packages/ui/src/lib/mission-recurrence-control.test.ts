import assert from "node:assert/strict"
import test from "node:test"
import { recurrenceControlHttpSchema, recurrenceControlRequestSchema, recurrenceControlStatusSchema } from "../../../server/src/missions/recurrence-control-contract"
import { recurrenceManualRequestSchema, recurrenceManualResultSchema } from "../../../server/src/missions/recurrence-manual-rpc"
import { createRecurrenceControlIntent, recurrenceControlStatusInput, completedRecurrenceControl,
  completedRecurrenceManual, partialRecurrenceControl, readRecurrenceControlResult } from "./mission-recurrence-control"

test("real control schemas preserve exact unknown/partial identities and normalize native mutation records", () => {
  const intent = createRecurrenceControlIntent("rec_schedule", 4, "pause", "/project")
  assert.deepEqual(recurrenceControlHttpSchema.parse(intent), intent)
  assert.notEqual(createRecurrenceControlIntent("rec_schedule", 4, "pause").requestID, intent.requestID)
  const { directory: _directory, ...input } = recurrenceControlStatusInput({ ...intent, retry: true })
  assert.deepEqual(recurrenceControlRequestSchema.parse({ ...input, scheduleID: intent.scheduleID }),
    { scheduleID: intent.scheduleID, requestID: intent.requestID, expectedRevision: 4, action: "pause" })
  const native = { version: 1, ...intent, revision: 5, state: "paused", controlsComplete: true,
    schedulerCancellation: "acknowledged", targets: [], targetsKnown: true }
  const { directory: _nativeDirectory, ...record } = native
  const completed = readRecurrenceControlResult(record)
  assert.deepEqual(recurrenceControlStatusSchema.parse(completed), completed)
  assert.equal(completedRecurrenceControl(completed, intent), true)
  const partial = recurrenceControlStatusSchema.parse({ ...completed, outcome: "unknown", controlsComplete: false,
    targets: [{ sessionID: "ses_running", outcome: "unknown" }] })
  assert.equal(completedRecurrenceControl(partial, intent), false)
  assert.equal(partialRecurrenceControl(partial, intent), true)
  assert.deepEqual(recurrenceControlHttpSchema.parse({ ...intent, retry: true }), { ...intent, retry: true })
  assert.equal(partialRecurrenceControl({ ...partial, revision: undefined }, intent), false)
  assert.equal(partialRecurrenceControl(partial, { ...intent, action: "resume" }), false)
  for (const foreign of [{ ...completed, requestID: "another_request" }, { ...completed, scheduleID: "another_schedule" },
    { ...completed, expectedRevision: 3 }, { ...completed, revision: 6 }])
    assert.equal(completedRecurrenceControl(foreign, intent), false)
})

test("manual admission/status uses the real tuple and accepts only exact known effects", () => {
  const intent = createRecurrenceControlIntent("rec_schedule", 4, "run-now")
  const input = recurrenceManualRequestSchema.parse({ scheduleID: intent.scheduleID, requestID: intent.requestID, expectedRevision: intent.expectedRevision })
  const result = recurrenceManualResultSchema.parse({ version: 1, ...input, projectID: "project", projectCanonical: "/project",
    location: { directory: "/project" }, outcome: "accepted", passageID: "pas_current", messageID: "msg_current", admission: null })
  assert.equal(completedRecurrenceManual(result, intent), true)
  assert.equal(completedRecurrenceManual({ ...result, outcome: "unknown" }, intent), false)
  assert.equal(completedRecurrenceManual({ ...result, requestID: "another_request" }, intent), false)
})
