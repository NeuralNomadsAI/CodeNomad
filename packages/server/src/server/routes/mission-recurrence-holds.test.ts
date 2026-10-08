import assert from "node:assert/strict"
import test from "node:test"
import { holdRecurrenceControl } from "./mission-recurrence-holds"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { recurrenceHumanRequestID } from "../../missions/recurrence-authority-contract"

test("retry without the original partial hold never allocates a new permit or adopts a new connection", () => {
  const fence = new WorktreeDeletionFence()
  const binding = { workspaceID: "owned", scheduleID: "schedule", requestID: recurrenceHumanRequestID("schedule", 2, "pause"),
    action: "pause" as const, expectedRevision: 1, expectedEpoch: 1, location: { directory: "/owned" },
    connection: { assertCurrent: () => {} } as never }
  let allocated = 0
  assert.throws(() => holdRecurrenceControl(fence, binding, () => { allocated++; return () => {} }, true), /Original partial.*unavailable/)
  assert.equal(allocated, 0)
  const original = holdRecurrenceControl(fence, binding, () => { allocated++; return () => {} })!
  original.dispatched(); original.partial(); original.dispose()
  const replacement = { ...binding, connection: { assertCurrent: () => {} } as never }
  assert.throws(() => holdRecurrenceControl(fence, replacement, () => { allocated++; return () => {} }, true), /uncertain/)
  assert.equal(allocated, 1)
  const retry = holdRecurrenceControl(fence, binding, () => { allocated++; return () => {} }, true)!
  retry.dispatched(); retry.settled(); retry.dispose()
  assert.equal(allocated, 1, "a valid explicit retry reuses only the original physical permit")
})
