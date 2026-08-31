import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeNativePreferencesRequest, readPreferencesRequestFromUrl } from "./preferences-window.ts"

describe("native Preferences requests", () => {
  it("accepts current section-only events and contextual requests", () => {
    assert.deepEqual(normalizeNativePreferencesRequest("speech"), { section: "speech" })
    assert.deepEqual(normalizeNativePreferencesRequest({
      section: "providers",
      instanceId: "workspace-1",
      location: { directory: "/repo", workspaceID: "worktree-1" },
    }), {
      section: "providers",
      instanceId: "workspace-1",
      location: { directory: "/repo", workspaceID: "worktree-1" },
    })
    assert.equal(normalizeNativePreferencesRequest("workspace"), null)
  })

  it("reads initial section and provider context from the native URL", () => {
    assert.deepEqual(readPreferencesRequestFromUrl(
      "http://localhost:3000/?preferences=providers&preferencesInstanceId=workspace-1&preferencesDirectory=%2Frepo&preferencesWorkspaceId=worktree-1",
    ), {
      section: "providers",
      instanceId: "workspace-1",
      location: { directory: "/repo", workspaceID: "worktree-1" },
    })
  })
})
