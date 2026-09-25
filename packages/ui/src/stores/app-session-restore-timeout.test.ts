import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RestoreTimeoutError, runAbortable } from "./app-session-restore-timeout.ts"
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
describe("app session restore timeouts", () => {
  it("deactivates a timed-out restore before its late completion", async () => {
    const pending = deferred()
    let lateWrite = false
    await assert.rejects(runAbortable(async (signal) => {
      await pending.promise
      if (!signal.aborted) lateWrite = true
    }, { timeoutMs: 5, message: "startup restore stalled" }), RestoreTimeoutError)
    pending.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(lateWrite, false)
  })
})
