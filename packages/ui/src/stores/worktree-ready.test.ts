import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { ensureWorktreesLoaded, getWorktrees, handleWorktreeReady, reloadWorktrees, setWorktreeSlugForParentSession } from "./worktrees.ts"
import type { Session } from "../types/session.ts"
import { setSessions } from "./session-state.ts"

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
  it("moves a descendant's family root and refreshes authoritatively", async () => {
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

    try {
      const calls: string[] = []
      await setWorktreeSlugForParentSession(instanceId, child.id, "feature", {
        moveFamily: async (_id, rootSessionId, slug) => { calls.push(`move:${rootSessionId}:${slug}`) },
        refreshSessions: async () => { calls.push("refresh") },
      })
      assert.deepEqual(calls, ["move:root:feature", "refresh"])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
      setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    }
  })
})
