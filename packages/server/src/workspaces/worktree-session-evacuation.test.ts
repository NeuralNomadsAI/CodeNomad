import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { WorktreeDeletionFence } from "./worktree-session-evacuation"

describe("WorktreeDeletionFence", () => {
  it("serializes deletion attempts for the same worktree", async () => {
    const fence = new WorktreeDeletionFence()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const first = fence.run("/repo/worktree", ["/repo/worktree"], async () => {
      calls.push("first:start")
      await gate
      calls.push("first:end")
    })
    const second = fence.run("/repo/worktree", ["/repo/worktree"], async () => { calls.push("second") })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, ["first:start"])
    assert.equal(fence.isBlocked("/repo/worktree/"), true)
    release()
    await Promise.all([first, second])
    assert.deepEqual(calls, ["first:start", "first:end", "second"])
    assert.equal(fence.isBlocked("/repo/worktree"), false)
  })

  it("waits for admitted mutations before deleting and rejects later admission", async () => {
    const fence = new WorktreeDeletionFence()
    const releaseMutation = fence.enter(["/repo/worktree"])
    assert.ok(releaseMutation)
    const calls: string[] = []
    const deletion = fence.run("/repo/worktree", ["/repo/worktree"], async () => { calls.push("delete") })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [])
    assert.equal(fence.enter(["/repo/worktree"]), undefined)
    releaseMutation()
    await deletion
    assert.deepEqual(calls, ["delete"])
  })

  it("fails deletion closed when an admitted mutation does not finish", async () => {
    const fence = new WorktreeDeletionFence(1)
    const releaseMutation = fence.enter(["/repo/worktree"])
    assert.ok(releaseMutation)

    await assert.rejects(
      fence.run("/repo/worktree", ["/repo/worktree"], async () => {}),
      /Timed out waiting for worktree mutations/,
    )
    assert.equal(fence.isBlocked("/repo/worktree"), false)
    releaseMutation()
  })

})
