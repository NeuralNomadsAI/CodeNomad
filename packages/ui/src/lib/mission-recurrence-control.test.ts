import assert from "node:assert/strict"
import test from "node:test"
import { recurrenceControlHttpSchema, recurrenceControlRequestSchema, recurrenceControlStatusSchema } from "../../../server/src/missions/recurrence-control-contract"
import { recurrenceManualRequestSchema, recurrenceManualResultSchema } from "../../../server/src/missions/recurrence-manual-rpc"
import { createRecurrenceControlIntent, recurrenceControlStatusInput, completedRecurrenceControl,
  completedRecurrenceManual, partialRecurrenceControl, readRecurrenceControlResult, recurrenceControlRefusalKey,
  rejectedRecurrenceControl } from "./mission-recurrence-control"
import { HttpResponseError } from "./retryable-file-search"

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

test("only proven no-effect refusals release a control; uncertain failures stay held", () => {
  const error = (status: number, code?: string) => new HttpResponseError("refused", status, null, code)
  assert.equal(recurrenceControlRefusalKey(error(409, "recurrence-revision-conflict")), "missions.recurrence.refused.stale")
  assert.equal(recurrenceControlRefusalKey(error(409, "recurrence-control-conflict")), "missions.recurrence.refused.conflict")
  assert.equal(recurrenceControlRefusalKey(error(401)), "missions.recurrence.refused.notAdmitted", "refused before any permit")
  assert.equal(recurrenceControlRefusalKey(error(400)), "missions.recurrence.refused.notAdmitted")
  // Refused before dispatch (preparation failure or another request's permit): nothing was sent.
  assert.equal(recurrenceControlRefusalKey(error(503, "recurrence-not-dispatched")), "missions.recurrence.refused.notSent")
  assert.equal(recurrenceControlRefusalKey(error(409, "recurrence-not-dispatched")), "missions.recurrence.refused.notSent")
  for (const uncertain of [error(503), error(409), error(500), error(404), error(401, "unexpected"), error(409, "creation-uncertain"),
    error(500, "recurrence-not-dispatched"), error(502, "recurrence-not-dispatched"), error(503, "creation-unavailable"),
    new TypeError("Failed to fetch"), undefined]) assert.equal(recurrenceControlRefusalKey(uncertain), undefined)

  const intent = createRecurrenceControlIntent("rec_schedule", 4, "pause")
  const rejected = recurrenceControlStatusSchema.parse({ version: 1, scheduleID: intent.scheduleID, requestID: intent.requestID,
    expectedRevision: 4, outcome: "rejected", reason: "revision-conflict" })
  assert.equal(rejectedRecurrenceControl(rejected, intent), "missions.recurrence.refused.stale")
  assert.equal(completedRecurrenceControl(rejected, intent), false)
  assert.throws(() => recurrenceControlStatusSchema.parse({ ...rejected, reason: undefined }), "a rejection always carries its reason")
  for (const foreign of [{ ...rejected, requestID: "another_request" }, { ...rejected, expectedRevision: 3 },
    { ...rejected, outcome: "unknown" as const }, { ...rejected, reason: "unknown-reason" as never }])
    assert.equal(rejectedRecurrenceControl(foreign, intent), undefined)
  const manualIntent = createRecurrenceControlIntent("rec_schedule", 4, "run-now")
  const manual = recurrenceManualResultSchema.parse({ version: 1, scheduleID: manualIntent.scheduleID, requestID: manualIntent.requestID,
    expectedRevision: 4, projectID: "project", projectCanonical: "/project", location: { directory: "/project" },
    outcome: "rejected", reason: "control-conflict", passageID: null, messageID: null, admission: null })
  assert.equal(rejectedRecurrenceControl(manual, manualIntent), "missions.recurrence.refused.conflict")
  assert.equal(completedRecurrenceManual(manual, manualIntent), false)
})

test("Check completion accepts both native inactive states without relaxing identity or acknowledgement", () => {
  const intent = createRecurrenceControlIntent("rec_schedule", 4, "check")
  for (const state of ["paused", "stopped"] as const) {
    const result = recurrenceControlStatusSchema.parse({ version: 1, scheduleID: intent.scheduleID,
      requestID: intent.requestID, action: "check", expectedRevision: 4, revision: 5, state,
      outcome: "committed", controlsComplete: true, schedulerCancellation: "acknowledged", targets: [] })
    assert.equal(completedRecurrenceControl(result, intent), true)
    for (const invalid of [{ ...result, state: "running" as const }, { ...result, requestID: "other_request" },
      { ...result, outcome: "unknown" as const }, { ...result, schedulerCancellation: "unknown" as const },
      { ...result, targets: [{ sessionID: "child", outcome: "unknown" as const }] }]) {
      assert.equal(completedRecurrenceControl(invalid, intent), false)
    }
    assert.equal(completedRecurrenceControl({ ...result, action: "pause" }, { ...intent, action: "pause" }), state === "paused")
  }
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
