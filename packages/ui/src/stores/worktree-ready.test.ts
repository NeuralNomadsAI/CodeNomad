import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { handleWorktreeReady } from "./worktrees.ts"

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
})
