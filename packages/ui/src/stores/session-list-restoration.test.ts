import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRoot, createEffect } from "solid-js"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { setInstanceMetadata } from "./instance-metadata.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { fetchSessions } from "./session-api.ts"
import { sessionListRestored } from "./session-list-restoration.ts"
import { loading, setSessions } from "./session-state.ts"

function setup(instanceId: string, list: () => Promise<unknown>) {
  const originalFetchWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/work", kind: "root" }] })
  const client = { session: { active: async () => ({}), list } } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  return () => {
    serverApi.fetchWorktrees = originalFetchWorktrees
    messageStoreBus.unregisterInstance(instanceId)
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
}

describe("session-list restoration gate", () => {
  it("settles when a stalled startup read is superseded by a timed-out foreground refresh", async () => {
    const instanceId = "restoration-stalled-timeout"
    const cleanup = setup(instanceId, () => new Promise(() => {}))
    const observed: boolean[] = []
    const dispose = createRoot((dispose) => {
      createEffect(() => observed.push(sessionListRestored(instanceId)))
      return dispose
    })
    try {
      void fetchSessions(instanceId).catch(() => {})
      let invalidate = () => {}
      void fetchSessions(instanceId, { strictStatus: true, registerInvalidation: (callback) => { invalidate = callback } }).catch(() => {})
      assert.equal(sessionListRestored(instanceId), false)

      // The foreground timeout abandons the latest request; neither read ends.
      invalidate()

      assert.equal(sessionListRestored(instanceId), true)
      assert.equal(observed.at(-1), true, "deferred panel demand reactivates")
      // Restoration settled without claiming the list was loaded.
      assert.equal(loading().fetchingSessions.has(instanceId), false)
    } finally {
      dispose()
      cleanup()
    }
  })

  it("does not settle from an invalidation that a newer read superseded", async () => {
    const instanceId = "restoration-superseded-invalidation"
    const cleanup = setup(instanceId, () => new Promise(() => {}))
    try {
      let invalidateOld = () => {}
      void fetchSessions(instanceId, { registerInvalidation: (callback) => { invalidateOld = callback } }).catch(() => {})
      void fetchSessions(instanceId).catch(() => {})
      invalidateOld()
      assert.equal(sessionListRestored(instanceId), false)
      assert.equal(loading().fetchingSessions.get(instanceId), true)
    } finally {
      cleanup()
    }
  })

  it("forgets an abandoned settlement when the workspace incarnation is removed", async () => {
    const instanceId = "restoration-removed"
    let cleanup = setup(instanceId, () => new Promise(() => {}))
    let invalidate = () => {}
    void fetchSessions(instanceId, { registerInvalidation: (callback) => { invalidate = callback } }).catch(() => {})
    invalidate()
    assert.equal(sessionListRestored(instanceId), true)
    cleanup()

    cleanup = setup(instanceId, () => new Promise(() => {}))
    try {
      void fetchSessions(instanceId).catch(() => {})
      assert.equal(sessionListRestored(instanceId), false)
    } finally {
      cleanup()
    }
  })

  it("settles once the first visible page and project metadata arrive while project inventory continues", async () => {
    const instanceId = "restoration-first-page"
    let resolveInventory!: (value: unknown) => void
    const inventoryPending = new Promise((resolve) => { resolveInventory = resolve })
    const cleanup = setup(instanceId, (input?: any) => {
      if (input?.parentID === null) {
        return Promise.resolve({
          data: [{
            id: "root-1", title: "root-1", projectID: "project", location: { directory: "/work" },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
          }],
          cursor: {},
        })
      }
      return inventoryPending
    })
    setInstanceMetadata(instanceId, { project: { id: "project", directory: "/work", canonical: "/work" } as any })
    const observed: boolean[] = []
    const dispose = createRoot((dispose) => {
      createEffect(() => observed.push(sessionListRestored(instanceId)))
      return dispose
    })
    try {
      const pending = fetchSessions(instanceId, { projectMetadata: Promise.resolve() })
      for (let i = 0; i < 6 && !sessionListRestored(instanceId); i++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      assert.equal(sessionListRestored(instanceId), true)
      assert.equal(observed.at(-1), true)
      assert.equal(loading().fetchingSessions.get(instanceId), true, "full inventory is still running")
      resolveInventory({ data: [], cursor: {} })
      await pending
      assert.equal(loading().fetchingSessions.get(instanceId), false)
    } finally {
      resolveInventory({ data: [], cursor: {} })
      dispose()
      cleanup()
    }
  })
})
