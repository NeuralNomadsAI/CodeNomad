import assert from "node:assert/strict"
import test from "node:test"
import {
  acquireWorkspaceMutation,
  isForbiddenDirectWorktreeMutation,
  isPromptControlMutation,
} from "./workspace-mutation-gate"

test("prompt controls bypass the mutation lane while destructive internals are forbidden", () => {
  assert.equal(isPromptControlMutation("POST", "/session/s1/permission/p1/reply"), true)
  assert.equal(isPromptControlMutation("POST", "/session/s1/abort"), true)
  assert.equal(isForbiddenDirectWorktreeMutation("POST", "/experimental/control-plane/move-session"), true)
  assert.equal(isForbiddenDirectWorktreeMutation("DELETE", "/experimental/worktree"), true)
})

test("workspace mutation lane serializes callers", async () => {
  const releaseFirst = await acquireWorkspaceMutation("instance")
  let entered = false
  const second = acquireWorkspaceMutation("instance").then((release) => { entered = true; return release })
  await Promise.resolve()
  assert.equal(entered, false)
  releaseFirst()
  const releaseSecond = await second
  assert.equal(entered, true)
  releaseSecond()
})

test("workspace mutation lane removes an aborted waiter", async () => {
  const releaseFirst = await acquireWorkspaceMutation("aborted-instance")
  const controller = new AbortController()
  const waiting = acquireWorkspaceMutation("aborted-instance", controller.signal)
  controller.abort(new Error("disconnected"))
  await assert.rejects(waiting, /disconnected/)
  releaseFirst()
  const releaseNext = await acquireWorkspaceMutation("aborted-instance")
  releaseNext()
})
