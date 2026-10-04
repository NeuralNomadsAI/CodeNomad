import assert from "node:assert/strict"
import test from "node:test"
import { WorktreeDeletionFence } from "./worktree-session-evacuation"

test("display snapshots are revoked permanently across deletion and unblock", async () => {
  const fence = new WorktreeDeletionFence()
  const current = fence.captureDisplay(["/repo/worktree"])
  assert.equal(current(), true)
  await fence.run("/repo/worktree", ["/repo/worktree"], async () => {})
  assert.equal(fence.isBlocked("/repo/worktree"), false)
  assert.equal(current(), false)
  assert.equal(fence.captureDisplay(["/repo/worktree"])(), true)
})

test("display capture during overlapping deletion remains revoked after release", async () => {
  const fence = new WorktreeDeletionFence()
  let blocked: (() => boolean) | undefined
  await fence.run("/repo", ["/repo"], async () => {
    blocked = fence.captureDisplay(["/repo/child"])
    assert.equal(blocked(), false)
  })
  assert.equal(blocked!(), false)
})

test("display invalidation is conservative across unrelated directory deletions", async () => {
  const fence = new WorktreeDeletionFence()
  const current = fence.captureDisplay(["/first"])
  await fence.run("/second", ["/second"], async () => {})
  assert.equal(current(), false)
})

test("failed deletion attempts also fence an earlier display read", async () => {
  const fence = new WorktreeDeletionFence()
  const current = fence.captureDisplay(["C:/Repo"])
  await assert.rejects(fence.run("C:/Repo", ["C:/Repo"], async () => { throw new Error("refused") }), /refused/)
  assert.equal(current(), false)
  assert.equal(fence.isBlocked("c:/repo"), false)
})
