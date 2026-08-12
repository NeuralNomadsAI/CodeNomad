import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { armInstanceMutationUploadTimeout, normalizeInstanceSearch } from "./http-server"
import { classifyWorktreeError } from "./routes/worktrees"
import { WorktreeSessionBusyError } from "../workspaces/worktree-transactions"

test("instance proxy replaces caller-controlled directory selectors", () => {
  const search = normalizeInstanceSearch(
    "?directory=%2Foutside&workspace=allowed&limit=10",
    "/repo",
    new Set(["allowed"]),
  )
  const params = new URLSearchParams(search)
  assert.equal(params.get("directory"), "/repo")
  assert.equal(params.get("workspace"), "allowed")
  assert.equal(params.get("limit"), "10")
  assert.throws(() => normalizeInstanceSearch("?workspace=outside", "/repo", new Set(["allowed"])))
})

test("worktree route errors distinguish conflicts, absence, and server failures", () => {
  assert.equal(classifyWorktreeError(new WorktreeSessionBusyError()), 409)
  assert.equal(classifyWorktreeError(new Error("Worktree not found")), 404)
  assert.equal(classifyWorktreeError(new Error("Workspace instance is not ready")), 503)
  assert.equal(classifyWorktreeError(new Error("disk failed")), 500)
})

test("mutation uploads are destroyed after inactivity and clear their socket timeout on completion", () => {
  const response = new EventEmitter()
  const timeouts: number[] = []
  let timeout!: () => void
  let destroyed = false
  const request = {
    setTimeout(milliseconds: number, callback?: () => void) {
      timeouts.push(milliseconds)
      if (callback) timeout = callback
      return this
    },
    destroy() { destroyed = true; return this },
  }
  armInstanceMutationUploadTimeout(request as never, response as never, 25)
  assert.deepEqual(timeouts, [25])
  timeout()
  assert.equal(destroyed, true)
  response.emit("finish")
  assert.deepEqual(timeouts, [25, 0])
})
