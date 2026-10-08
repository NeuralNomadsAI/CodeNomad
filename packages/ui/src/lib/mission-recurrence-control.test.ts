import assert from "node:assert/strict"
import test from "node:test"
import { recurrenceControlHttpSchema, recurrenceControlRequestSchema, recurrenceControlStatusSchema } from "../../../server/src/missions/recurrence-control-contract"
import { recurrenceHumanRequestID } from "../../../server/src/missions/recurrence-authority-contract"
import { createRecurrenceControlIntent, recurrenceControlStatusInput, completedRecurrenceControl } from "./mission-recurrence-control"

test("the actual UI builder satisfies the reviewed native HTTP/status schemas and never treats unknown targets as completed", async () => {
  for (const action of ["play", "pause", "stop"] as const) {
    const intent = await createRecurrenceControlIntent("rec_schedule", 2, action, 4, "/project")
    assert.deepEqual(recurrenceControlHttpSchema.parse(intent), intent)
    if (action !== "play") {
      const retry = { ...intent, retry: true }
      recurrenceControlHttpSchema.parse(retry)
      assert.deepEqual(recurrenceControlStatusInput(retry), recurrenceControlStatusInput(intent), "status never receives the mutation retry flag")
    } else assert.equal(recurrenceControlHttpSchema.safeParse({ ...intent, retry: true }).success, false)
    assert.equal(intent.requestID, recurrenceHumanRequestID(intent.scheduleID, 3,
      action === "play" ? "authorize" : action === "pause" ? "pause" : "revoke"))
    const statusBody = recurrenceControlStatusInput(intent)
    assert.equal("scheduleID" in statusBody, false, "the read-only status route takes scheduleID from its URL")
    const { directory: _directory, ...identity } = statusBody
    recurrenceControlRequestSchema.parse({ ...identity, scheduleID: intent.scheduleID })
    assert.equal(recurrenceControlHttpSchema.safeParse({ action, expectedRevision: 4, directory: "/project" }).success, false)
    const receipt = { version: 1 as const, scheduleID: intent.scheduleID, requestID: intent.requestID,
      expectedRevision: 4, epoch: 3, revision: 5, state: action === "play" ? "running" as const : action === "pause" ? "paused" as const : "stopped" as const,
      outcome: "committed" as const, controlsComplete: true }
    recurrenceControlStatusSchema.parse(receipt)
    assert.equal(completedRecurrenceControl(receipt, intent), true)
    for (const result of [
      { ...receipt, outcome: "unknown" as const, controlsComplete: false },
      { ...receipt, controlsComplete: false }, { ...receipt, schedulerCancellation: "unknown" as const },
      { ...receipt, requestID: "rhuman_foreign" }, { ...receipt, epoch: 4 }, { ...receipt, expectedRevision: 5 },
    ]) assert.equal(completedRecurrenceControl(result, intent), false)
    assert.equal(recurrenceControlStatusSchema.safeParse({ ...receipt, controlsComplete: false }).success, false)
  }
})
