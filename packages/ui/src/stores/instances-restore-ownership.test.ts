import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { AbortCreatedWorkspaceCleanup } from "./abort-created-workspace-cleanup.ts"
import {
  createInstance, releaseRestoreCreatedInstance, removeInstance, cancelUnattachedWorkspaceCreations, resumeWorkspaceCreations,
} from "./instances.ts"

it("ordinary and restore openings own a request until their tab takes over", async () => {
  const originalCreate = serverApi.createWorkspace
  const originalRelease = serverApi.releaseWorkspaceCreation
  const originalCancel = serverApi.cancelWorkspaceCreation
  const originalTrack = AbortCreatedWorkspaceCleanup.prototype.track
  const tracked: Array<{ id: string; requestId?: string }> = []
  const released: Array<[string, string]> = []
  const cancelled: Array<[string, boolean | undefined]> = []

  serverApi.createWorkspace = async (payload) => ({
    id: payload.path.slice(1), requestId: payload.requestId, path: payload.path, status: "starting",
    proxyPath: "", binaryId: "test", binaryLabel: "Test", createdAt: "", updatedAt: "",
  })
  serverApi.releaseWorkspaceCreation = async (id, requestId) => { released.push([id, requestId]) }
  serverApi.cancelWorkspaceCreation = async (id, keepalive) => { cancelled.push([id, keepalive]) }
  AbortCreatedWorkspaceCleanup.prototype.track = function (workspace) {
    tracked.push(workspace)
    originalTrack.call(this, workspace)
  }

  try {
    const ordinary = await createInstance("/ordinary", undefined)
    assert.ok(ordinary.requestId)
    assert.equal(tracked.some(({ id, requestId }) => id === "ordinary" && requestId === ordinary.requestId), true)

    const restored = await createInstance("/restore", undefined, {
      signal: new AbortController().signal,
    })
    assert.ok(restored.requestId)
    assert.equal(tracked.some(({ id, requestId }) => id === "restore" && requestId === restored.requestId), true)
    await releaseRestoreCreatedInstance("restore", restored.requestId)
    await releaseRestoreCreatedInstance("restore", restored.requestId)
    assert.deepEqual(released, [["restore", restored.requestId]])

    const unattached = await createInstance("/unattached")
    await cancelUnattachedWorkspaceCreations(new Set(["ordinary"]))
    assert.deepEqual(cancelled, [[unattached.requestId, true]], "omit attached and released records")
  } finally {
    resumeWorkspaceCreations()
    AbortCreatedWorkspaceCleanup.prototype.track = originalTrack
    serverApi.createWorkspace = originalCreate
    serverApi.releaseWorkspaceCreation = originalRelease
    serverApi.cancelWorkspaceCreation = originalCancel
    removeInstance("ordinary", { authoritative: false })
    removeInstance("restore", { authoritative: false })
    removeInstance("unattached", { authoritative: false })
  }
})
