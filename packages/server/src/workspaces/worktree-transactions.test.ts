import assert from "node:assert/strict"
import test from "node:test"
import { assertMovable, completeFamily, WorktreeSessionBusyError } from "./worktree-transactions"

test("completeFamily includes a root when only its descendant is selected", () => {
  const root = { id: "root" }
  const child = { id: "child", parentID: "root" }
  assert.deepEqual(completeFamily({ sessions: [root, child] }, "child"), { root, members: [root, child] })
})

test("authoritative non-idle status blocks family moves", () => {
  assert.throws(
    () => assertMovable({ statuses: { child: { type: "working" } } }, [{ id: "root" }, { id: "child" }]),
    WorktreeSessionBusyError,
  )
})
