import assert from "node:assert/strict"
import test from "node:test"
import { holdScheduledMission, scheduledMissionHold, type ScheduledHoldBinding } from "./mission-scheduled-holds"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { missionSchedulePayloadDigest } from "../../missions/mission-schedule-contract"
import { missionCreationDigest } from "./mission-creation-holds"

test("only an exact positive deletion receipt releases the retained deletion permit", () => {
  const fence = new WorktreeDeletionFence()
  const binding = { missionID: "owned", workspaceID: "workspace", requestID: "original_delete", action: "delete", expectedRevision: 4,
    digest: "same", owner: { workspace: {}, projectID: "project", projectCanonical: "/owned", checkout: "/owned" },
    connection: { assertCurrent() {} }, location: { directory: "/owned" }, base: { directory: "/owned" },
    profile: "profile", configYamlPath: "/profile/config.yaml", executionHost: "local", deleteManagedSessions: false } as ScheduledHoldBinding
  let released = 0
  const hold = holdScheduledMission(fence, binding, () => { released++ })
  hold.dispatch(); hold.dispose()
  assert.equal(hold.settle(binding, { document: null, pending: false, deleted: true }), false)
  const receipt = { id: binding.missionID, requestID: binding.requestID, expectedRevision: 4, deleteManagedSessions: false }
  for (const invalid of [{ ...receipt, id: "foreign" }, { ...receipt, requestID: "different" }, { ...receipt, expectedRevision: 5 }, { ...receipt, deleteManagedSessions: true }])
    assert.equal(hold.settle(binding, { document: null, pending: false, deletionReceipt: invalid }), false)
  assert.equal(released, 0)
  assert.equal(hold.settle(binding, { document: null, pending: false, deletionReceipt: receipt }), true)
  assert.equal(released, 1)
  assert.equal(scheduledMissionHold(fence, binding.missionID), undefined)
})

test("a proven refusal releases only the exact initial request, never an applied partial retry", () => {
  const fence = new WorktreeDeletionFence(), payloadDigest = missionSchedulePayloadDigest({})
  const binding = { missionID: "owned", workspaceID: "workspace", requestID: "original_play", action: "play", expectedRevision: 4,
    digest: missionCreationDigest(["original_play", 4, "play", payloadDigest]),
    owner: { workspace: {}, projectID: "project", projectCanonical: "/owned", checkout: "/owned" },
    connection: { assertCurrent() {} }, location: { directory: "/owned" }, base: { directory: "/owned" },
    profile: "profile", configYamlPath: "/profile/config.yaml", executionHost: "local" } as ScheduledHoldBinding
  let released = 0
  const hold = holdScheduledMission(fence, binding, () => { released++ })
  const refusal = { missionID: "owned", requestID: "original_play", action: "play", expectedRevision: 4, payloadDigest, reason: "date-passed" }
  hold.dispatch()
  assert.equal(hold.refuse(binding, { pending: false, refusal: { ...refusal, requestID: "different" } }), false)
  assert.equal(hold.refuse(binding, { pending: false, refusal: { ...refusal, payloadDigest: "a".repeat(64) } }), false)
  assert.equal(released, 0)
  assert.equal(hold.refuse(binding, { pending: false, refusal }), true)
  assert.equal(released, 1)
  const partial = holdScheduledMission(fence, binding, () => { released++ })
  partial.dispatch(); partial.dispose()
  partial.retry(binding, { pending: true, document: { id: "owned", control: { requestID: "original_play", action: "play", expectedRevision: 4, pending: true } } })
  assert.equal(partial.refuse(binding, { pending: false, refusal }), false)
  assert.equal(released, 1)
})
