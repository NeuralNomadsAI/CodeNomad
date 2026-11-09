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
          return { projectID: "project", missions: [{ id: "source", coordinatorSessionId: "coordinator", status: "active" }] }
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
