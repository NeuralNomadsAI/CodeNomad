import assert from "node:assert/strict"
import test from "node:test"
import { WorktreeDeletionFence } from "./worktree-session-evacuation"
import { captureDisplayIdentities } from "./worktree-display-identity"

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

test("a WSL service-path display read is fenced by an in-progress deletion of its worktree identity", async () => {
  const fence = new WorktreeDeletionFence()
  const manager = { getWorktreeIdentityForPath: async (_id: string, directory: string) =>
    directory.startsWith("/home/dev/repo") ? "wsl:ubuntu:/home/dev/repo" : undefined }
  let finish!: () => void
  const deletion = fence.run("wsl:ubuntu:/home/dev/repo", ["wsl:ubuntu:/home/dev/repo"], () => new Promise<void>(resolve => { finish = resolve }))
  assert.equal(fence.captureDisplay(["/home/dev/repo"])(), true, "a service path alone never overlaps the blocked identity")
  assert.equal((await captureDisplayIdentities(fence, manager, "workspace", ["/home/dev/repo/sub"]))!(), false)
  assert.equal((await captureDisplayIdentities(fence, manager, "workspace", ["/home/dev/other"]))!(), true, "unresolved paths keep the path capture")
  assert.equal(await captureDisplayIdentities(undefined, manager, "workspace", ["/home/dev/repo"]), undefined)
  finish(); await deletion
})

test("an identity capture keeps the path capture's delete-and-unblock fence across its resolution", async () => {
  const fence = new WorktreeDeletionFence()
  const pending = captureDisplayIdentities(fence, { getWorktreeIdentityForPath: async () => {
    await fence.run("/elsewhere", ["/elsewhere"], async () => {})
    return "/repo"
  } }, "workspace", ["/repo"])
  assert.equal((await pending)!(), false)
})

test("failed deletion attempts also fence an earlier display read", async () => {
  const fence = new WorktreeDeletionFence()
  const current = fence.captureDisplay(["C:/Repo"])
  await assert.rejects(fence.run("C:/Repo", ["C:/Repo"], async () => { throw new Error("refused") }), /refused/)
  assert.equal(current(), false)
  assert.equal(fence.isBlocked("c:/repo"), false)
})
