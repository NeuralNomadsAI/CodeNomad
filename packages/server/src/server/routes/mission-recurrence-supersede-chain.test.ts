import assert from "node:assert/strict"
import test from "node:test"
import { holdRecurrenceControl, reconcileRecurrenceControlHold, type RecurrenceHoldOwner } from "./mission-recurrence-holds"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

type Action = "play" | "pause" | "stop" | "resume" | "check"
const connection = { assertCurrent: () => {} } as never
const owner: RecurrenceHoldOwner = { workspace: {}, projectID: "project", projectCanonical: "/project", checkout: "/project" }
const location = { directory: "/project" }
const bind = (requestID: string, action: Action, expectedRevision: number) => ({ workspaceID: "owned", scheduleID: "schedule",
  requestID, action, expectedRevision, location, connection, owner, admission: { root: "/project", profile: "stable" } })
const state = (action: Action) => action === "play" || action === "resume" ? "running" as const : action === "stop" ? "stopped" as const : "paused" as const
const unknown = (binding: ReturnType<typeof bind>) => ({ version: 1 as const, scheduleID: "schedule", requestID: binding.requestID,
  action: binding.action, expectedRevision: binding.expectedRevision, revision: binding.expectedRevision + 1,
  state: state(binding.action), outcome: "unknown" as const, controlsComplete: false })
const committed = (binding: ReturnType<typeof bind>) => ({ ...unknown(binding), outcome: "committed" as const, controlsComplete: true })
const rejected = (binding: ReturnType<typeof bind>) => ({ version: 1 as const, scheduleID: "schedule", requestID: binding.requestID,
  expectedRevision: binding.expectedRevision, outcome: "rejected" as const, reason: "control-conflict" as const })
const enter = (fence: WorktreeDeletionFence) => () => fence.enter(["/project"])
const deletes = (fence: WorktreeDeletionFence) => fence.run("/project", ["/project"], async () => true).catch(() => false)
/** An uncertain intent, optionally proven as superseding the slot's current one. */
function uncertain(fence: WorktreeDeletionFence, binding: ReturnType<typeof bind>, over?: ReturnType<typeof bind>) {
  const hold = holdRecurrenceControl(fence, binding, enter(fence))!
  if (over) hold.confirmSuperseded(unknown(over), owner)
  hold.dispatched(); hold.dispose()
}
/** Which uncertain intent the schedule slot now holds, probed by a fresh Pause. */
function slot(fence: WorktreeDeletionFence) {
  const probe = holdRecurrenceControl(fence, bind("pause_probe", "pause", 9), enter(fence))!
  const superseded = probe.superseded?.requestID
  probe.dispose()
  return superseded
}

const S = bind("play_s", "play", 0), T = bind("check_t", "check", 1), U = bind("stop_u", "stop", 1)

test("a retained middle intent rejected while a newer control prepares restores the earlier intent, never orphans it", async () => {
  const fence = new WorktreeDeletionFence(200)
  uncertain(fence, S); uncertain(fence, T, S)
  const u = holdRecurrenceControl(fence, U, enter(fence))!
  assert.equal(u.superseded?.requestID, T.requestID)
  // A second client's exact read proves T had no effect while U still proves.
  reconcileRecurrenceControlHold(fence, "owned", location, T, rejected(T), connection)
  assert.throws(() => u.confirmSuperseded(unknown(T), owner), /start intent unavailable/)
  u.dispose()
  assert.equal(slot(fence), S.requestID, "the earlier Play returns to the schedule slot")
  assert.equal(await deletes(fence), false, "still genuinely uncertain: its permit fences deletion")
  reconcileRecurrenceControlHold(fence, "owned", location, S, rejected(S), connection)
  assert.equal(slot(fence), undefined)
  assert.equal(await deletes(fence), true, "no orphaned permit remains")
})

test("a middle intent rejected after the newer control proved it: no-effect restores, a commit retires, the earlier intent", async () => {
  for (const applied of [false, true]) {
    const fence = new WorktreeDeletionFence(200)
    uncertain(fence, S); uncertain(fence, T, S)
    const u = holdRecurrenceControl(fence, U, enter(fence))!
    u.confirmSuperseded(unknown(T), owner)
    reconcileRecurrenceControlHold(fence, "owned", location, T, rejected(T), connection)
    u.dispatched(); u.settled(applied); u.dispose()
    assert.equal(slot(fence), applied ? undefined : S.requestID)
    if (!applied) reconcileRecurrenceControlHold(fence, "owned", location, S, committed(S), connection)
    assert.equal(await deletes(fence), true, `${applied ? "commit" : "no-effect"} leaves no orphan`)
  }
})

test("a delayed status completing the superseded Resume and Play while a newer Stop proves leaves no orphan after its no-effect", async () => {
  const fence = new WorktreeDeletionFence(200), play = bind("play_old", "play", 0), resume = bind("resume_mid", "resume", 1)
  uncertain(fence, play); uncertain(fence, resume, play)
  const stop = holdRecurrenceControl(fence, bind("stop_new", "stop", 1), enter(fence))!
  // Preparing: neither the new Stop's own identity nor any read can settle it.
  reconcileRecurrenceControlHold(fence, "owned", location, bind("stop_new", "stop", 1), rejected(bind("stop_new", "stop", 1)), connection)
  reconcileRecurrenceControlHold(fence, "owned", location, resume, committed(resume), connection)
  reconcileRecurrenceControlHold(fence, "owned", location, play, committed(play), connection)
  assert.throws(() => stop.confirmSuperseded(unknown(resume), owner))
  stop.dispose()
  assert.equal(slot(fence), undefined)
  assert.equal(await deletes(fence), true)
})

test("an earlier intent rejected under a preparing control splices out without touching that admission", async () => {
  const fence = new WorktreeDeletionFence(200)
  uncertain(fence, S); uncertain(fence, T, S)
  const u = holdRecurrenceControl(fence, U, enter(fence))!
  reconcileRecurrenceControlHold(fence, "owned", location, S, rejected(S), connection)
  u.confirmSuperseded(unknown(T), owner)
  u.dispatched(); u.settled(false); u.dispose()
  assert.equal(slot(fence), T.requestID, "no-effect restores only the still-uncertain middle intent")
  reconcileRecurrenceControlHold(fence, "owned", location, T, rejected(T), connection)
  assert.equal(await deletes(fence), true)
})

test("partial Pause/Stop permits are never superseded, nor released by a rejected read", async () => {
  const fence = new WorktreeDeletionFence(200)
  uncertain(fence, S)
  const stop = holdRecurrenceControl(fence, bind("stop_partial", "stop", 1), enter(fence))!
  stop.confirmSuperseded(unknown(S), owner)
  stop.dispatched(); stop.partial(); stop.dispose()
  assert.throws(() => holdRecurrenceControl(fence, bind("resume_over", "resume", 2), enter(fence)), /remains uncertain/)
  reconcileRecurrenceControlHold(fence, "owned", location, bind("stop_partial", "stop", 1), rejected(bind("stop_partial", "stop", 1)), connection)
  assert.equal(await deletes(fence), false, "the partial Stop still holds")
})

test("a proof-time hint releases only the permit holding that exact proof", async () => {
  const fence = new WorktreeDeletionFence(200)
  const hold = holdRecurrenceControl(fence, S, enter(fence))!
  hold.issued(1_000); hold.dispatched(); hold.dispose()
  reconcileRecurrenceControlHold(fence, "owned", location, { ...S, issuedAt: 999 }, rejected(S), connection)
  reconcileRecurrenceControlHold(fence, "owned", { directory: "/elsewhere" }, { ...S, issuedAt: 1_000 }, rejected(S), connection)
  reconcileRecurrenceControlHold(fence, "owned", location, { ...S, requestID: "play_other", issuedAt: 1_000 }, rejected(S), connection)
  reconcileRecurrenceControlHold(fence, "owned", location, { ...S, issuedAt: 1_000 }, rejected(S), { assertCurrent: () => {} } as never)
  assert.equal(await deletes(fence), false, "mismatched proof, Location, request or unproven reconnect stays held")
  reconcileRecurrenceControlHold(fence, "owned", location, { ...S, issuedAt: 1_000 }, rejected(S), connection)
  assert.equal(await deletes(fence), true)
})
