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
})
