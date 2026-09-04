import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup.ts"
import {
  createInstance, releaseRestoreCreatedInstance, removeInstance,
} from "./instances.ts"

it("only restore-scoped creations are owned by abort cleanup", async () => {
  const originalCreate = serverApi.createWorkspace
  const originalRelease = serverApi.releaseWorkspaceCreation
  const originalTrack = AbortCreatedWorkspaceCleanup.prototype.track
  const tracked: Array<{ id: string; requestId?: string }> = []
  const released: Array<[string, string]> = []

  serverApi.createWorkspace = async (payload) => ({
    id: payload.path.slice(1), requestId: payload.requestId, path: payload.path, status: "starting",
    proxyPath: "", binaryId: "test", binaryLabel: "Test", createdAt: "", updatedAt: "",
  })
  serverApi.releaseWorkspaceCreation = async (id, requestId) => { released.push([id, requestId]) }
  AbortCreatedWorkspaceCleanup.prototype.track = function (workspace) {
    tracked.push(workspace)
    originalTrack.call(this, workspace)
  }

  try {
    await createInstance("/ordinary", undefined)
    assert.equal(tracked.some(({ id }) => id === "ordinary"), false)

    const restored = await createInstance("/restore", undefined, {
      signal: new AbortController().signal,
    })
    assert.ok(restored.requestId)
    assert.equal(tracked.some(({ id, requestId }) => id === "restore" && requestId === restored.requestId), true)
    await releaseRestoreCreatedInstance("restore", restored.requestId)
    await releaseRestoreCreatedInstance("restore", restored.requestId)
    assert.deepEqual(released, [["restore", restored.requestId]])
  } finally {
    AbortCreatedWorkspaceCleanup.prototype.track = originalTrack
    serverApi.createWorkspace = originalCreate
    serverApi.releaseWorkspaceCreation = originalRelease
    removeInstance("ordinary", { authoritative: false })
    removeInstance("restore", { authoritative: false })
  }
})
