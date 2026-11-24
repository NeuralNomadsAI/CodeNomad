import assert from "node:assert/strict"
import test from "node:test"
import { recurrenceControlRequestSchema, recurrenceControlHttpSchema, recurrenceControlStatusSchema } from "./recurrence-control-contract"
import { recurrenceTitle } from "./recurrence-contract"
test("simple controls use explicit request identity and revision, not epochs or signed retry tuples", () => {
  const input = { scheduleID: "schedule_one", requestID: "request_one", action: "resume", expectedRevision: 4 }
  assert(recurrenceControlRequestSchema.safeParse(input).success)
  assert.equal(recurrenceControlRequestSchema.safeParse({ ...input, expectedEpoch: 1 }).success, false)
  assert.equal(recurrenceControlHttpSchema.safeParse({ ...input, retry: true }).success, false)
  assert(recurrenceControlHttpSchema.safeParse({ ...input, action: "pause", retry: true }).success)
  assert.equal(recurrenceControlStatusSchema.safeParse({ version: 1, ...input, action: undefined, outcome: "committed", controlsComplete: false }).success, false)
  assert.equal(recurrenceTitle("\n  First line  \nSecond"), "First line")
  assert.equal(recurrenceTitle("x".repeat(200)).length, 120)
})
