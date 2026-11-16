import assert from "node:assert/strict"
import test from "node:test"
import { missionRecoveryControlError } from "../../missions/recovery-error"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { prepareCoordinatorMission } from "./mission-prepare"

test("preparation maps only the two fixed Compare errors to actionable codes", async () => {
  const model = { model: { providerID: "fixture", id: "same" } }
  for (const code of ["compare-models-required", "compare-models-identical", "compare-models-private-detail"] as const) {
    const manager = {
      list: () => [{ id: "workspace" }],
      ownsLocation: async () => true,
      getSharedServiceConnection: async () => ({ client: {
        session: { get: async () => ({ id: "coordinator", projectID: "project", location: { directory: "/fixture" } }) },
        rpc: () => ({ snapshot: async () => {
          if (code === "compare-models-private-detail") throw new Error(code)
          return { projectID: "project", missions: [{ id: "source", coordinatorSessionId: "coordinator", status: "active",
            actors: [{ sessionId: "coordinator" }] }] }
        } }),
      } }),
    }
    const expected = missionRecoveryControlError(code === "compare-models-private-detail" ? "prepare-refused" : code)
    await assert.rejects(prepareCoordinatorMission(manager as never, new WorktreeDeletionFence(), "coordinator", {
      kind: "prepare", input: { missionID: "source", requestID: "private-comparison", objective: "Compare", template: "compare",
        ...(code === "compare-models-identical" ? { profiles: { roles: { "model-a": model, "model-b": model } } } : {}) },
    }, new AbortController().signal), { code: expected.code, message: expected.message })
  }
})

test("the backend independently refuses ineligible authors, stale source selectors and missing ownership before creation", async () => {
  const base = { id: "ses_author", projectID: "project", location: { directory: "/fixture" } }
  const membership = (coordinatorSessionId: string, status = "active") => ({ id: "source", coordinatorSessionId, status,
    actors: [{ sessionId: base.id }] })
  const cases = [
    { session: { ...base, parentID: "ses_parent" } },
    { session: { ...base, id: "ses_other" } },
    { session: { ...base, projectID: "foreign" } },
    { session: { ...base, metadata: { "codenomad.mission": { kind: "coordinator", missionID: "old",
      recurrence: { scheduleID: "daily", passageID: "old" } } } } },
    { session: { ...base, metadata: { "codenomad.mission": { kind: "coordinator", missionID: "old",
      document: { missionID: "schedule", passageID: "old" } } } } },
    { session: { ...base, metadata: { "codenomad.mission": { kind: "task", missionID: "old" } } } },
    { missions: [membership("ses_coordinator")] },
    { missions: [membership("ses_coordinator", "completed")] },
    { missions: [membership(base.id)] }, // Active coordinator must name its exact source.
    { missionID: "missing" },
    { workspaces: [] },
    { controlUnavailable: true },
  ]
  for (const scenario of cases) {
    let creationReads = 0
    const manager = {
      list: () => "workspaces" in scenario ? scenario.workspaces : [{ id: "workspace" }],
      get: () => { creationReads++; assert.fail("Ineligible caller reached creation") },
      ownsLocation: async () => true,
      getSharedServiceConnection: async () => ({ client: {
        session: { get: async () => "session" in scenario ? scenario.session : base },
        rpc: () => ({ snapshot: async () => ({ projectID: "project", missions: "missions" in scenario ? scenario.missions : [],
          controlUnavailable: "controlUnavailable" in scenario && scenario.controlUnavailable }) }),
      } }),
    }
    await assert.rejects(prepareCoordinatorMission(manager as never, new WorktreeDeletionFence(), base.id, { kind: "prepare",
      input: { requestID: "refused", objective: "Never create", template: "custom",
        ...("missionID" in scenario ? { missionID: scenario.missionID } : {}) } }, new AbortController().signal),
    (error: any) => error.code === "prepare-refused")
    assert.equal(creationReads, 0)
  }
})
