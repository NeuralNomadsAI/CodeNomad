import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { ensureWorktreesLoaded, getWorktrees, handleWorktreeReady, reloadWorktrees } from "./worktrees.ts"

describe("handleWorktreeReady", () => {
  it("refreshes worktrees before synchronizing OpenCode workspaces", async () => {
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
      async (instanceId) => {
        calls.push(`workspaces:${instanceId}`)
      },
    )

    assert.deepEqual(calls, ["worktrees:instance-1", "workspaces:instance-1"])
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
    const refreshWorkspaces = async () => {
      calls.push(`workspaces:${refreshCount}`)
    }
    const event = {
      type: "worktree.ready" as const,
      directory: "/tmp/opencode/worktree/feature",
      properties: { name: "feature" },
    }

    const first = handleWorktreeReady("instance-concurrent", event, refreshWorktrees, refreshWorkspaces)
    await Promise.resolve()
    const second = handleWorktreeReady("instance-concurrent", event, refreshWorktrees, refreshWorkspaces)
    await Promise.resolve()

    assert.deepEqual(calls, ["worktrees:1"])

    releaseFirst()
    await Promise.all([first, second])

    assert.deepEqual(calls, ["worktrees:1", "workspaces:1", "worktrees:2", "workspaces:2"])
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
        async () => undefined,
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
      async () => {
        calls.push("workspaces")
      },
    )

    assert.deepEqual(calls, ["worktrees", "workspaces"])
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
      assert.deepEqual(getWorktrees(instanceId).map((worktree) => worktree.slug), ["root"])

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

  it("does not let an aborted waiter expose an older request to overwrite a newer reload", async () => {
    const instanceId = "instance-aborted-waiter"
    const originalFetchWorktrees = serverApi.fetchWorktrees
    const requests: Array<(value: Awaited<ReturnType<typeof serverApi.fetchWorktrees>>) => void> = []
    serverApi.fetchWorktrees = () => new Promise((resolve) => requests.push(resolve))

    try {
      const first = reloadWorktrees(instanceId)
      await Promise.resolve()
      const controller = new AbortController()
      const aborted = reloadWorktrees(instanceId, controller.signal)
      controller.abort(new Error("reload timed out"))
      await assert.rejects(aborted, /reload timed out/)

      const latest = reloadWorktrees(instanceId)
      await Promise.resolve()
      await Promise.resolve()
      requests[1]({
        isGitRepo: true,
        worktrees: [{ slug: "new", directory: "/new", kind: "worktree" }],
      })
      await latest
      requests[0]({
        isGitRepo: true,
        worktrees: [{ slug: "old", directory: "/old", kind: "worktree" }],
      })
      await first

      assert.deepEqual(getWorktrees(instanceId).map((worktree) => worktree.slug), ["new"])
    } finally {
      serverApi.fetchWorktrees = originalFetchWorktrees
    }
  })
})
