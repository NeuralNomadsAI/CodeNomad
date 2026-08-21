import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { sessions, setSessions } from "./session-state.ts"
import { deleteWorktree, ensureWorktreesLoaded } from "./worktrees.ts"

describe("worktree deletion authority", () => {
  it("keeps locations on failure and reconciles them locally only after DELETE succeeds", async () => {
    const instanceId = "server-owned-worktree-delete"
    const originalFetch = serverApi.fetchWorktrees
    const originalDelete = serverApi.deleteWorktree
    let moves = 0
    let deletes = 0
    const client = { session: { move: async () => { moves += 1 } } } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions((previous) => new Map(previous).set(instanceId, new Map([["session", {
      id: "session", instanceId, parentId: null, title: "session", agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      location: { directory: "/repo/.worktrees/feature" }, time: { created: 1, updated: 1 },
    } as Session]])))
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
      { slug: "root", directory: "/repo" },
      { slug: "feature", directory: "/repo/.worktrees/feature" },
    ] }) as any
    serverApi.deleteWorktree = async () => {
      deletes += 1
      if (deletes === 1) throw new Error("server rollback")
    }

    try {
      await ensureWorktreesLoaded(instanceId)
      await assert.rejects(deleteWorktree(instanceId, "feature"), /server rollback/)
      assert.equal(deletes, 1)
      assert.equal(moves, 0)
      assert.equal(sessions().get(instanceId)?.get("session")?.location.directory, "/repo/.worktrees/feature")

      await deleteWorktree(instanceId, "feature")
      assert.equal(deletes, 2)
      assert.equal(moves, 0)
      assert.equal(sessions().get(instanceId)?.get("session")?.location.directory, "/repo")
    } finally {
      serverApi.fetchWorktrees = originalFetch
      serverApi.deleteWorktree = originalDelete
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })
})
