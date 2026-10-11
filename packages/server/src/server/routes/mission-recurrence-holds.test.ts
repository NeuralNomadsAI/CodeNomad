import assert from "node:assert/strict"
import test from "node:test"
import { holdRecurrenceControl, reconcileRecurrenceControlHold, recurrenceControlHeldElsewhere, type RecurrenceHoldOwner } from "./mission-recurrence-holds"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const workspace = {}
const owner: RecurrenceHoldOwner = { workspace, projectID: "project", projectCanonical: "/project", checkout: "/project" }
const connection = () => ({ assertCurrent: () => {} }) as never
function playHold(fence: WorktreeDeletionFence, original = connection()) {
  const binding = { workspaceID: "owned", scheduleID: "schedule", requestID: "play_lost", action: "play" as const,
    expectedRevision: 0, location: { directory: "/project" }, connection: original, owner,
    admission: { root: "/project", profile: "stable" } }
  const hold = holdRecurrenceControl(fence, binding, () => fence.enter(["/project"]))!
  hold.dispatched(); hold.dispose()
  return binding
}
const committed = { version: 1 as const, scheduleID: "schedule", requestID: "play_lost", expectedRevision: 0, revision: 1,
  state: "running" as const, controlsComplete: true, outcome: "committed" as const }
const pause = (binding: ReturnType<typeof playHold>, fence: WorktreeDeletionFence) =>
  holdRecurrenceControl(fence, { ...binding, requestID: "pause_next", action: "pause", expectedRevision: 2 }, () => fence.enter(["/project"]))
/** A new Pause over the uncertain Play gets at most a superseding hold that cannot
 * dispatch without exact native proof; disposing it returns the Play's retained permit. */
function blocked(binding: ReturnType<typeof playHold>, fence: WorktreeDeletionFence, message?: string) {
  let hold: ReturnType<typeof pause>
  try { hold = pause(binding, fence) } catch (error) { assert.match(String(error), /remains uncertain/, message); return }
  assert.ok(hold?.superseded, message)
  assert.throws(() => hold!.dispatched(), /dispatch unavailable/, message)
  hold!.dispose()
}

test("an exact committed Play receipt releases its retained permit: later controls and deletion proceed", async () => {
  const fence = new WorktreeDeletionFence(), binding = playHold(fence)
  blocked(binding, fence)
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, { ...committed, controlsComplete: false, outcome: "unknown" }, binding.connection)
  blocked(binding, fence, "unknown never releases")
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
    blocked({ ...binding, connection: replacement }, fence, `${label} owner refused`)
  }
  const fence = new WorktreeDeletionFence(), binding = playHold(fence), replacement = connection()
  reconcileRecurrenceControlHold(fence, "owned", { directory: "/elsewhere" }, binding, committed, replacement, { ...owner })
  blocked({ ...binding, connection: replacement }, fence, "different directory refused")
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, { ...committed, controlsComplete: false, outcome: "unknown" }, replacement, { ...owner })
  assert.throws(() => holdRecurrenceControl(fence, { ...binding, connection: replacement, action: "pause" }, () => fence.enter(["/project"]), true),
    /uncertain/, "a replacement never inherits partial-retry admission")
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, committed, replacement, { ...owner })
  assert.equal(recurrenceControlHeldElsewhere(fence, "owned", binding, replacement), false)
  const next = pause({ ...binding, connection: replacement }, fence)!
  next.dispatched(); next.settled(); next.dispose()
})

test("a retired connection's partial permit is retired only at the proven successor's dispatch, with identical owner, root and profile", async () => {
  const retired = () => { let live = true; return { retire: () => { live = false },
    connection: { assertCurrent: () => { if (!live) throw new Error("retired") } } as never } }
  const admission = { root: "root", profile: "profile" }
  const partial = { version: 1 as const, scheduleID: "schedule", requestID: "pause_one", expectedRevision: 1, revision: 2,
    action: "pause" as const, state: "paused" as const, controlsComplete: false, outcome: "unknown" as const }
  const fence = new WorktreeDeletionFence(50), old = retired()
  const binding = { workspaceID: "owned", scheduleID: "schedule", requestID: "pause_one", action: "pause" as const,
    expectedRevision: 1, location: { directory: "/project" }, connection: old.connection, owner, admission }
  const original = holdRecurrenceControl(fence, binding, () => fence.enter(["/project"]))!
  original.dispatched(); original.partial(); original.dispose()
  const fresh = { ...binding, connection: retired().connection }
  assert.throws(() => holdRecurrenceControl(fence, fresh, () => fence.enter(["/project"]), true), /uncertain/, "a live original connection keeps its permit")
  old.retire()
  for (const [label, changed] of [["root", { ...fresh, admission: { ...admission, root: "other" } }],
    ["profile", { ...fresh, admission: { ...admission, profile: "other" } }], ["unknown admission", { ...fresh, admission: undefined }],
    ["project", { ...fresh, owner: { ...owner, projectID: "other" } }], ["plain repeat", fresh]] as const) {
    assert.throws(() => holdRecurrenceControl(fence, changed, () => fence.enter(["/project"]), label !== "plain repeat"), /uncertain/, label)
  }
  const successor = holdRecurrenceControl(fence, fresh, () => fence.enter(["/project"]), true)!
  assert.equal(successor.requiresPartialProof, true)
  assert.throws(() => holdRecurrenceControl(fence, fresh, () => fence.enter(["/project"]), true), /uncertain/, "one successor at a time")
  assert.throws(() => successor.dispatched(), /dispatch unavailable/, "unproven successor never dispatches")
  successor.dispose()
  assert.equal(await fence.run("/project", ["/project"], async () => true).catch(() => false), false, "the predecessor still holds")
  const proven = holdRecurrenceControl(fence, fresh, () => fence.enter(["/project"]), true)!
  proven.confirmPartial(partial)
  proven.dispatched(); proven.settled(); proven.dispose()
  assert.equal(await fence.run("/project", ["/project"], async () => true), true, "both permits released after settlement")
})

test("retry without the original partial hold dispatches only after an exact native partial receipt; it never adopts a new connection", () => {
  const fence = new WorktreeDeletionFence()
  const binding = { workspaceID: "owned", scheduleID: "schedule", requestID: "request_one",
    action: "pause" as const, expectedRevision: 1, location: { directory: "/owned" },
    connection: { assertCurrent: () => {} } as never }
  let allocated = 0, released = 0
  const partial = { version: 1 as const, scheduleID: "schedule", requestID: "request_one", expectedRevision: 1, revision: 2,
    action: "pause" as const, state: "paused" as const, controlsComplete: false, outcome: "unknown" as const }
  for (const receipt of [{ ...partial, controlsComplete: true, outcome: "committed" as const }, { ...partial, requestID: "request_two" },
    { ...partial, revision: 3 }, { ...partial, state: "running" as const }, { ...partial, controlsComplete: undefined }]) {
    const reacquired = holdRecurrenceControl(fence, binding, () => { allocated++; return () => { released++ } }, true)!
    assert.equal(reacquired.requiresPartialProof, true)
    assert.throws(() => reacquired.dispatched(), /dispatch unavailable/, "unproven reacquisition never dispatches")
    assert.throws(() => reacquired.confirmPartial(receipt), /Exact native partial/)
    reacquired.dispose()
  }
  assert.deepEqual([allocated, released], [5, 5], "each refused reacquisition released its fresh permit")
  const original = holdRecurrenceControl(fence, binding, () => { allocated++; return () => {} })!
  original.dispatched(); original.partial(); original.dispose()
  const replacement = { ...binding, connection: { assertCurrent: () => {} } as never }
  assert.throws(() => holdRecurrenceControl(fence, replacement, () => { allocated++; return () => {} }, true), /uncertain/)
  assert.equal(allocated, 6)
  const retry = holdRecurrenceControl(fence, binding, () => { allocated++; return () => {} }, true)!
  assert.equal(retry.requiresPartialProof, false)
  retry.dispatched(); retry.settled(); retry.dispose()
  assert.equal(allocated, 6, "a valid explicit retry reuses only the original physical permit")
  const restarted = new WorktreeDeletionFence(), proven = holdRecurrenceControl(restarted, binding, () => () => {}, true)!
  proven.confirmPartial(partial); proven.dispatched(); proven.partial(); proven.dispose()
  assert.throws(() => holdRecurrenceControl(restarted, { ...binding, requestID: "request_two" }, () => () => {}), /uncertain/,
    "a proven reacquisition retains its partial permit like the original")
})

test("an explicit control supersedes an uncertain start intent only after exact native proof, retiring it once committed", async () => {
  const recorded = { ...committed, action: "play" as const, controlsComplete: false, outcome: "unknown" as const }
  const deleted = (fence: WorktreeDeletionFence) => Promise.race([fence.run("/project", ["/project"], async () => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 200))])
  // Wrong identity, completion, revision, state or owner never dispatches; each attempt releases its own permit.
  for (const [receipt, fresh] of [[{ ...recorded, requestID: "other" }, owner], [{ ...recorded, controlsComplete: true, outcome: "committed" as const }, owner],
    [{ ...recorded, revision: 2 }, owner], [{ ...recorded, state: "paused" as const }, owner], [{ ...recorded, action: "resume" as const }, owner],
    [recorded, { ...owner, checkout: "/other" }], [recorded, { ...owner, workspace: {} }]] as const) {
    const fence = new WorktreeDeletionFence(), binding = playHold(fence), next = pause(binding, fence)!
    assert.throws(() => next.confirmSuperseded(receipt, fresh), /start intent unavailable/)
    assert.throws(() => next.dispatched(), /dispatch unavailable/)
    next.dispose()
    blocked(binding, fence, "the Play's permit is back in place")
  }
  // A no-effect refusal of the superseding request leaves the Play held.
  let fence = new WorktreeDeletionFence(), binding = playHold(fence), next = pause(binding, fence)!
  next.confirmSuperseded(recorded, owner); next.dispatched(); next.settled(false); next.dispose()
  assert.equal(await deleted(fence), false, "the Play's permit is still retained")
  // A committed superseding control retires the Play's permit with its own.
  fence = new WorktreeDeletionFence(); binding = playHold(fence); next = pause(binding, fence)!
  assert.deepEqual(next.superseded, { scheduleID: "schedule", requestID: "play_lost", action: "play", expectedRevision: 0 })
  next.confirmSuperseded(recorded, { ...owner })
  next.dispatched(); next.settled(); next.dispose()
  assert.equal(await deleted(fence), true)
  // An uncertain superseding request keeps both; its own committed read retires both.
  fence = new WorktreeDeletionFence(); binding = playHold(fence); next = pause(binding, fence)!
  next.confirmSuperseded(recorded, owner); next.dispatched(); next.dispose()
  const pauseRequest = { ...binding, requestID: "pause_next", action: "pause" as const, expectedRevision: 2 }
  reconcileRecurrenceControlHold(fence, "owned", binding.location, pauseRequest, { ...committed, requestID: "pause_next",
    expectedRevision: 2, revision: 3, state: "paused" }, binding.connection)
  assert.equal(await deleted(fence), true)
  // In flight, preparing or a partial Pause/Stop: never superseded.
  fence = new WorktreeDeletionFence()
  const inflight = holdRecurrenceControl(fence, { ...binding, requestID: "play_inflight" }, () => fence.enter(["/project"]))!
  inflight.dispatched()
  assert.throws(() => pause(binding, fence), /remains uncertain/)
  inflight.settled(); inflight.dispose()
  const partialPause = holdRecurrenceControl(fence, pauseRequest, () => fence.enter(["/project"]))!
  partialPause.dispatched(); partialPause.partial(); partialPause.dispose()
  assert.throws(() => holdRecurrenceControl(fence, { ...pauseRequest, requestID: "stop_next", action: "stop" }, () => fence.enter(["/project"])), /remains uncertain/)
})

test("supersession preserves reconnect admission guards and cannot steal a proving successor", async () => {
  const fence = new WorktreeDeletionFence(), binding = playHold(fence)
  for (const admission of [{ ...binding.admission, root: "/other" }, { ...binding.admission, profile: "other" }]) {
    assert.throws(() => pause({ ...binding, admission }, fence), /remains uncertain/)
  }
  reconcileRecurrenceControlHold(fence, "owned", binding.location, binding, committed, binding.connection)
  let live = true
  const original = { ...binding, requestID: "partial_stop", action: "stop" as const,
    connection: { assertCurrent() { if (!live) throw new Error("retired") } } as never }
  const first = holdRecurrenceControl(fence, original, () => fence.enter(["/project"]))!
  first.dispatched(); first.partial(); first.dispose(); live = false
  const fresh = { ...original, connection: connection() }
  const successor = holdRecurrenceControl(fence, fresh, () => fence.enter(["/project"]), true)!
  assert.throws(() => holdRecurrenceControl(fence, fresh, () => fence.enter(["/project"]), true), /remains uncertain/)
  assert.throws(() => holdRecurrenceControl(fence, { ...fresh, requestID: "another_stop" }, () => fence.enter(["/project"])), /remains uncertain/)
  successor.confirmPartial({ version: 1, scheduleID: original.scheduleID, requestID: original.requestID,
    action: "stop", expectedRevision: original.expectedRevision, revision: original.expectedRevision + 1,
    state: "stopped", controlsComplete: false, outcome: "unknown" })
  successor.dispatched(); successor.settled(); successor.dispose()
  assert.equal(await fence.run("/project", ["/project"], async () => "deleted"), "deleted")
})

for (const replace of [false, true]) test(`a partial superseding Pause retains its older start intent through an exact ${replace ? "reconnection" : "same-connection"} retry`, async () => {
  let live = true
  const conn = { assertCurrent() { if (!live) throw new Error("retired") } } as never
  const fence = new WorktreeDeletionFence(), binding = playHold(fence, conn)
  const first = pause(binding, fence)!
  first.confirmSuperseded({ ...committed, action: "play", controlsComplete: false, outcome: "unknown" }, owner)
  first.dispatched(); first.partial(); first.dispose()
  const request = { ...binding, action: "pause" as const, requestID: "pause_next", expectedRevision: 2 }
  if (replace) live = false
  const retry = holdRecurrenceControl(fence, { ...request, connection: replace ? connection() : conn }, () => fence.enter(["/project"]), true)!
  if (retry.requiresPartialProof) retry.confirmPartial({ version: 1, scheduleID: request.scheduleID, requestID: request.requestID,
    action: "pause", expectedRevision: 2, revision: 3, state: "paused", outcome: "unknown", controlsComplete: false })
  retry.dispatched(); retry.settled(); retry.dispose()
  assert.equal(await fence.run("/project", ["/project"], async () => "deleted"), "deleted", "both the Pause and older Play permit settle")
})
