import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { sessions, setSessions } from "./session-state.ts"
import { deleteWorktree, getWorktrees } from "./worktrees.ts"

describe("worktree deletion authority", () => {
  it("keeps locations on failure and accepts authoritative refresh after DELETE succeeds", async () => {
    const instanceId = "server-owned-worktree-delete"
    const originalFetch = serverApi.fetchWorktrees
    const originalDelete = serverApi.deleteWorktree
    let deletes = 0
    let worktreeRefreshes = 0
    let refreshes = 0
    setSessions((previous) => new Map(previous).set(instanceId, new Map([["session", {
      id: "session", instanceId, parentId: null, title: "session", agent: "build",
      model: { providerId: "provider", modelId: "model" }, status: "idle", retry: null,
      idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      location: { directory: "/repo/.worktrees/feature" }, time: { created: 1, updated: 1 },
    } as Session]])))
    serverApi.fetchWorktrees = async () => {
      worktreeRefreshes += 1
      if (deletes === 2 && worktreeRefreshes === 2) throw new Error("transient worktree refresh")
      return {
        isGitRepo: true,
        worktrees: deletes < 2
          ? [{ slug: "root", directory: "/repo" }, { slug: "feature", directory: "/repo/.worktrees/feature" }]
          : [{ slug: "root", directory: "/repo" }],
      } as any
    }
    serverApi.deleteWorktree = async () => {
      deletes += 1
      if (deletes === 1) throw new Error("server rollback")
    }
    const refreshSessions = async () => {
      refreshes += 1
      if (deletes < 2) return
      if (refreshes === 2) throw new Error("transient session refresh")
      setSessions((previous) => {
        const next = new Map(previous)
        const instanceSessions = new Map(next.get(instanceId))
        const session = instanceSessions.get("session")!
        instanceSessions.set("session", { ...session, location: { directory: "/repo" } })
        next.set(instanceId, instanceSessions)
        return next
      })
    }

    try {
      await assert.rejects(deleteWorktree(instanceId, "feature", undefined, refreshSessions), /server rollback/)
      assert.equal(deletes, 1)
      assert.equal(refreshes, 1)
      assert.equal(sessions().get(instanceId)?.get("session")?.location.directory, "/repo/.worktrees/feature")
      assert.deepEqual(getWorktrees(instanceId).map((worktree) => worktree.slug), ["root", "feature"])

      await deleteWorktree(instanceId, "feature", undefined, refreshSessions)
      assert.equal(deletes, 2)
      assert.equal(refreshes, 3)
      assert.equal(worktreeRefreshes, 3)
      assert.equal(sessions().get(instanceId)?.get("session")?.location.directory, "/repo")
      assert.deepEqual(getWorktrees(instanceId).map((worktree) => worktree.slug), ["root"])
    } finally {
      serverApi.fetchWorktrees = originalFetch
      serverApi.deleteWorktree = originalDelete
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    }
  })
})
