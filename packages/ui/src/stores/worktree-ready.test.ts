import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { deleteWorktree, ensureWorktreesLoaded, getWorktrees, handleWorktreeReady, reloadWorktrees, setWorktreeSlugForParentSession } from "./worktrees.ts"
import type { Session } from "../types/session.ts"
import { sessions, setSessions } from "./session-state.ts"

describe("handleWorktreeReady", () => {
  it("refreshes worktrees", async () => {
    const calls: string[] = []

    await handleWorktreeReady(
      "instance-1",
      {
        type: "worktree.ready",
        directory: "/tmp/opencode/worktree/feature",
        properties: { name: "feature", branch: "opencode/feature" },
      },
      async (instanceId) => {
        calls.push(`worktrees:${instanceId}`)
      },
    )

    assert.deepEqual(calls, ["worktrees:instance-1"])
  })

  it("serializes overlapping ready events for the same instance", async () => {
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let refreshCount = 0

    const refreshWorktrees = async () => {
      refreshCount += 1
      calls.push(`worktrees:${refreshCount}`)
      if (refreshCount === 1) await firstPending
    }
    const event = {
      type: "worktree.ready" as const,
      directory: "/tmp/opencode/worktree/feature",
      properties: { name: "feature" },
    }

    const first = handleWorktreeReady("instance-concurrent", event, refreshWorktrees)
    await Promise.resolve()
    const second = handleWorktreeReady("instance-concurrent", event, refreshWorktrees)
    await Promise.resolve()

    assert.deepEqual(calls, ["worktrees:1"])

    releaseFirst()
    await Promise.all([first, second])

    assert.deepEqual(calls, ["worktrees:1", "worktrees:2"])
  })

  it("continues processing after an earlier refresh rejects", async () => {
    const event = {
      type: "worktree.ready" as const,
      properties: { name: "feature" },
    }

    await assert.rejects(
      handleWorktreeReady(
        "instance-recovery",
        event,
        async () => {
          throw new Error("refresh failed")
        },
      ),
      /refresh failed/,
    )

    const calls: string[] = []
    await handleWorktreeReady(
      "instance-recovery",
      event,
      async () => {
        calls.push("worktrees")
      },
    )

    assert.deepEqual(calls, ["worktrees"])
  })

  it("orders initial hydration before a trailing reload", async () => {
    const instanceId = "instance-initial-reload"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    let resolveInitial!: (value: Awaited<ReturnType<typeof serverApi.fetchWorktrees>>) => void
    let resolveReload!: (value: Awaited<ReturnType<typeof serverApi.fetchWorktrees>>) => void
    const initialResponse = new Promise<Awaited<ReturnType<typeof serverApi.fetchWorktrees>>>((resolve) => {
      resolveInitial = resolve
    })
    const reloadResponse = new Promise<Awaited<ReturnType<typeof serverApi.fetchWorktrees>>>((resolve) => {
      resolveReload = resolve
    })
    let requestCount = 0

    serverApi.fetchWorktrees = async () => {
      requestCount += 1
      return requestCount === 1 ? initialResponse : reloadResponse
    }

    try {
      const initial = ensureWorktreesLoaded(instanceId)
      const reload = reloadWorktrees(instanceId)
      await Promise.resolve()

      assert.equal(requestCount, 1)

      resolveInitial({
        isGitRepo: true,
        worktrees: [{ slug: "root", directory: "/repo", kind: "root" }],
      })
      await initial
      await Promise.resolve()

      assert.equal(requestCount, 2)

      resolveReload({
        isGitRepo: true,
        worktrees: [
          { slug: "root", directory: "/repo", kind: "root" },
          { slug: "feature", directory: "/repo-feature", kind: "worktree" },
        ],
      })
      await reload

      assert.deepEqual(getWorktrees(instanceId).map((worktree) => worktree.slug), ["root", "feature"])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
    }
  })
})

describe("session family worktree moves", () => {
  it("resolves descendants to the root, serializes moves, and refreshes authoritatively", async () => {
    const instanceId = "family-move"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    serverApi.fetchWorktrees = async () => ({
      isGitRepo: true,
      worktrees: [
        { slug: "root", directory: "/repo", kind: "root" },
        { slug: "feature", directory: "/repo-feature", kind: "worktree" },
      ],
    })
    const root = { id: "root", parentId: null, location: { directory: "/repo" } } as Session
    const child = { id: "child", parentId: "root", location: { directory: "/repo" } } as Session
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[root.id, root], [child.id, child]])))
    await reloadWorktrees(instanceId)

    const calls: string[] = []
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const moveFamily = async (_instanceId: string, rootSessionId: string, worktreeSlug: string) => {
      calls.push(`move:${rootSessionId}:${worktreeSlug}`)
      if (calls.length === 1) await firstPending
    }
    const refreshSessions = async () => { calls.push("refresh") }

    try {
      const first = setWorktreeSlugForParentSession(instanceId, child.id, "feature", { moveFamily, refreshSessions })
      await Promise.resolve()
      const second = setWorktreeSlugForParentSession(instanceId, root.id, "root", { moveFamily, refreshSessions })
      await Promise.resolve()
      assert.deepEqual(calls, ["move:root:feature"])
      assert.equal(sessions().get(instanceId)?.get(root.id)?.location.directory, "/repo")

      releaseFirst()
      await Promise.all([first, second])
      assert.deepEqual(calls, ["move:root:feature", "refresh", "move:root:root", "refresh"])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    }
  })

  it("refreshes sessions and worktrees after a deletion error", async () => {
    const instanceId = "delete-error"
    const originalDeleteWorktree = serverApi.deleteWorktree
    const originalFetchWorktrees = serverApi.fetchWorktrees
    const calls: string[] = []
    serverApi.deleteWorktree = async () => {
      calls.push("delete")
      throw new Error("transaction rolled back")
    }
    serverApi.fetchWorktrees = async () => {
      calls.push("worktrees")
      return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] }
    }

    try {
      await assert.rejects(
        deleteWorktree(instanceId, "feature", undefined, async () => { calls.push("sessions") }),
        /transaction rolled back/,
      )
      assert.equal(calls[0], "delete")
      assert.deepEqual(calls.slice(1).sort(), ["sessions", "worktrees"])
    } finally {
      serverApi.deleteWorktree = originalDeleteWorktree
      serverApi.fetchWorktrees = originalFetchWorktrees
    }
  })
})
