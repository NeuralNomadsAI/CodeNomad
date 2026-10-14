import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { normalizeSessionMessage } from "./normalizers"
import { isDuplicateRunFailure } from "./run-failure"

const model = { id: "model", providerID: "provider" }
const user = { id: "user", type: "user", text: "prompt", time: { created: 1 } }
const quota = { type: "provider.quota", message: "Usage limit reached" }
const step = (id: string, error?: { type: string; message: string }, content: unknown[] = []) =>
  ({ id, type: "assistant", agent: "build", model, content, ...(error ? { error } : {}), time: { created: 2, completed: 3 } })
const idle = (id: string, error = quota) => ({ id, type: "idle", outcome: "failed", error, time: { created: 4 } })

function duplicates(sources: unknown[]) {
  const infos = new Map(sources.map((source) => {
    const { info } = normalizeSessionMessage("session", source as SessionMessageInfo)
    return [info.id, info]
  }))
  const ids = [...infos.keys()]
  return ids.filter((_, index) => isDuplicateRunFailure(ids, index, (id) => infos.get(id)))
}

describe("failed run duplicate detection", () => {
  it("hides the idle failure already shown by the run's last step or failed compaction", () => {
    assert.deepEqual(duplicates([user, step("step", quota), idle("idle")]), ["idle"])
    // Notices between the step and the idle record do not own the failure.
    assert.deepEqual(duplicates([user, step("step", quota),
      { id: "switch", type: "model-switched", model, time: { created: 3 } }, idle("idle")]), ["idle"])
    assert.deepEqual(duplicates([user, step("step"), { id: "compaction", type: "compaction", status: "failed", reason: "auto",
      error: { type: "provider.context", message: "Too long" }, time: { created: 3 } }, idle("idle")]), ["idle"])
  })

  it("keeps failures no step shows, including exhausted restarts after an interrupted step", () => {
    assert.deepEqual(duplicates([user, idle("idle")]), [])
    assert.deepEqual(duplicates([user, step("step", undefined, [{ type: "text", text: "done" }]), idle("idle")]), [])
    assert.deepEqual(duplicates([user, step("step", { type: "aborted", message: "Step interrupted" }),
      idle("idle", { type: "aborted", message: "Execution was interrupted repeatedly and will not be resumed automatically." })]), [])
    // A step from an earlier turn never owns this run's failure.
    assert.deepEqual(duplicates([step("old", quota), user, idle("idle")]), [])
    // An earlier visible run failure is the last step of the turn.
    assert.deepEqual(duplicates([user, idle("first"), idle("second")]), [])
    assert.deepEqual(duplicates([user, step("step", quota), idle("first"), idle("second")]), ["first", "second"])
  })
})
