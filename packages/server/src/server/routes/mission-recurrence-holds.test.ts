import assert from "node:assert/strict"
import test from "node:test"
import { holdRecurrenceControl, reconcileRecurrenceControlHold, recurrenceControlHeldElsewhere, type RecurrenceHoldOwner } from "./mission-recurrence-holds"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const workspace = {}
const owner: RecurrenceHoldOwner = { workspace, projectID: "project", projectCanonical: "/project", checkout: "/project" }
const connection = () => ({ assertCurrent: () => {} }) as never
function playHold(fence: WorktreeDeletionFence, original = connection()) {
  const binding = { workspaceID: "owned", scheduleID: "schedule", requestID: "play_lost", action: "play" as const,
    expectedRevision: 0, location: { directory: "/project" }, connection: original, owner }
  const hold = holdRecurrenceControl(fence, binding, () => fence.enter(["/project"]))!
  hold.dispatched(); hold.dispose()
  return binding
}
const committed = { version: 1 as const, scheduleID: "schedule", requestID: "play_lost", expectedRevision: 0, revision: 1,
  state: "running" as const, controlsComplete: true, outcome: "committed" as const }
const pause = (binding: ReturnType<typeof playHold>, fence: WorktreeDeletionFence) =>
  holdRecurrenceControl(fence, { ...binding, requestID: "pause_next", action: "pause", expectedRevision: 2 }, () => fence.enter(["/project"]))

test("an exact committed Play receipt releases its retained permit: later controls and deletion proceed", async () => {
  const fence = new WorktreeDeletionFence(), binding = playHold(fence)
  assert.throws(() => pause(binding, fence), /remains uncertain/)
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, { ...committed, controlsComplete: false, outcome: "unknown" }, binding.connection)
  assert.throws(() => pause(binding, fence), /remains uncertain/, "unknown never releases")
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, committed, binding.connection)
  const next = pause(binding, fence)!
  next.dispatched(); next.settled(); next.dispose()
  assert.equal(await fence.run("/project", ["/project"], async () => "deleted"), "deleted")
})

test("a replacement connection settles the original permit only with a freshly re-proven identical owner", () => {
  for (const [label, fresh] of [["missing", undefined], ["workspace", { ...owner, workspace: {} }],
    ["project", { ...owner, projectID: "other" }], ["storage", { ...owner, projectCanonical: "/other" }],
    ["checkout", { ...owner, checkout: "/other" }]] as const) {
    const fence = new WorktreeDeletionFence(), binding = playHold(fence), replacement = connection()
    assert.equal(recurrenceControlHeldElsewhere(fence, "owned", binding, replacement), true)
    reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, committed, replacement, fresh)
    assert.throws(() => pause({ ...binding, connection: replacement }, fence), /remains uncertain/, `${label} owner refused`)
  }
  const fence = new WorktreeDeletionFence(), binding = playHold(fence), replacement = connection()
  reconcileRecurrenceControlHold(fence, "owned", { directory: "/elsewhere" }, binding, committed, replacement, { ...owner })
  assert.throws(() => pause({ ...binding, connection: replacement }, fence), /remains uncertain/, "different directory refused")
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, { ...committed, controlsComplete: false, outcome: "unknown" }, replacement, { ...owner })
  assert.throws(() => holdRecurrenceControl(fence, { ...binding, connection: replacement, action: "pause" }, () => fence.enter(["/project"]), true),
    /uncertain/, "a replacement never inherits partial-retry admission")
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, committed, replacement, { ...owner })
  assert.equal(recurrenceControlHeldElsewhere(fence, "owned", binding, replacement), false)
  const next = pause({ ...binding, connection: replacement }, fence)!
  next.dispatched(); next.settled(); next.dispose()
})

test("retry without the original partial hold never allocates a new permit or adopts a new connection", () => {
  const fence = new WorktreeDeletionFence()
  const binding = { workspaceID: "owned", scheduleID: "schedule", requestID: "request_one",
    action: "pause" as const, expectedRevision: 1, location: { directory: "/owned" },
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
