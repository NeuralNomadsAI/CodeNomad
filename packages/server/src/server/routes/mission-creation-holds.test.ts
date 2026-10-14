import assert from "node:assert/strict"
import test from "node:test"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { holdMissionCreation, missionCreationDigest } from "./mission-creation-holds"

function fixture() {
  const fence = new WorktreeDeletionFence(20)
  const connection = { assertCurrent() {} } as ServiceConnection
  const binding = { key: "human:project:mission", workspaceID: "workspace", projectID: "project", missionID: "mission",
    sessionID: "ses_root", requestDigest: missionCreationDigest({ objective: "Original" }), connection,
    locations: [{ directory: "/private/checkout/child", identity: "/private/checkout" }] }
  let entries = 0
  const enter = () => { entries++; return fence.enter(binding.locations.map(item => item.identity)) }
  return { fence, binding, enter, get entries() { return entries } }
}

test("unknown creation retains the original permit; exact/changed retries never enter or consume a substitute", async () => {
  const f = fixture(), permit = holdMissionCreation(f.fence, f.binding, f.enter)!
  permit.dispatched(); permit.release()
  assert.throws(() => holdMissionCreation(f.fence, f.binding, f.enter), { code: "creation-uncertain" })
  const mutations = [
    { requestDigest: missionCreationDigest({ objective: "Changed" }) }, { workspaceID: "other" }, { projectID: "foreign" },
    { missionID: "other-mission" }, { sessionID: "ses_other" }, { connection: { assertCurrent() {} } as ServiceConnection },
    { locations: [{ directory: "/private/checkout/different", identity: "/private/checkout" }] },
    { locations: [{ directory: "/private/checkout/child", identity: "/foreign/physical" }] },
  ]
  for (const mutation of mutations) {
    assert.throws(() => holdMissionCreation(f.fence, { ...f.binding, ...mutation }, f.enter), { code: "creation-conflict" })
  }
  assert.equal(f.entries, 1)
  // A late local setter/second finalization is not a native receipt and cannot
  // consume a parked permit. This is a registration unit test, not qualification.
  permit.settled(); permit.release()
  let snapshot = false
  await assert.rejects(f.fence.run("/private/checkout", ["/private/checkout"], async () => { snapshot = true }), /Timed out/)
  assert.equal(snapshot, false)
})

test("creation registration reserves bounded capacity before any native effect or physical entry", async () => {
  const f = fixture(), permits = []
  for (let n = 0; n < 128; n++) permits.push(holdMissionCreation(f.fence, { ...f.binding, key: `operation-${n}` }, f.enter)!)
  assert.throws(() => holdMissionCreation(f.fence, { ...f.binding, key: "overflow" }, f.enter), { code: "creation-capacity" })
  assert.equal(f.entries, 128)
  permits[0].release()
  const next = holdMissionCreation(f.fence, { ...f.binding, key: "overflow" }, f.enter)!
  for (const permit of permits) permit.release()
  next.release()
  await f.fence.run("/private/checkout", ["/private/checkout"], async () => {})
})

test("uncertain task policy is part of exact creation identity and cannot be changed or replayed", () => {
  for (const taskMode of ["native", "independent"] as const) {
    const f = fixture(), input = { objective: "Original", taskMode }
    const binding = { ...f.binding, requestDigest: missionCreationDigest(input) }
    const permit = holdMissionCreation(f.fence, binding, f.enter)!
    permit.dispatched(); permit.release()
    assert.throws(() => holdMissionCreation(f.fence, binding, f.enter), { code: "creation-uncertain" })
    const changed = { ...input, taskMode: taskMode === "native" ? "independent" : "native" }
    assert.throws(() => holdMissionCreation(f.fence, { ...binding, requestDigest: missionCreationDigest(changed) }, f.enter), { code: "creation-conflict" })
    assert.equal(f.entries, 1)
  }
})

test("pre-dispatch failure releases only its unconsumed reservation and checks the original connection", async () => {
  const f = fixture(), connection = { assertCurrent(): void { throw new Error("Retired") } } as ServiceConnection
  const permit = holdMissionCreation(f.fence, { ...f.binding, connection }, f.enter)!
  assert.throws(() => permit.dispatched(), /Retired/)
  permit.release()
  await f.fence.run("/private/checkout", ["/private/checkout"], async () => {})
  const retry = holdMissionCreation(f.fence, f.binding, f.enter)!
  retry.release()
})
