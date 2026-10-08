import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { nativeRecurrenceDue } from "./native-recurrence-due"

test("due callback is an Effect and rejects another schedule before graph/native access", async () => {
  const due = nativeRecurrenceDue({ storage: {} } as never, { projectID: "project", projectCanonical: "/owned", directory: "/owned",
    scheduleID: "schedule", profileID: "profile", executionHost: "local" })
  const wake = due("different", () => true, new AbortController().signal)
  assert.equal(Effect.isEffect(wake), true)
  await assert.rejects(Effect.runPromise(Effect.scoped(wake)), /schedule differs/)
})
