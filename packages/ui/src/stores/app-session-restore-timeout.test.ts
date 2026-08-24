import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RestoreTimeoutError, runAbortable } from "./app-session-restore-timeout.ts"
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
describe("app session restore timeouts", () => {
  it("rejects an operation that does not settle within its bound", async () => {
    let operationSignal: AbortSignal | undefined
    await assert.rejects(runAbortable((signal) => {
      operationSignal = signal; return new Promise<never>(() => {})
    }, { timeoutMs: 5, message: "restore stalled" }), (error) => error instanceof RestoreTimeoutError && error.message === "restore stalled")
    assert.equal(operationSignal?.aborted, true)
  })
  it("deactivates a timed-out restore before its late completion", async () => {
    const pending = deferred()
    let lateWrite = false
    await assert.rejects(runAbortable(async (signal) => {
      await pending.promise
      if (!signal.aborted) lateWrite = true
    }, { timeoutMs: 5, message: "startup restore stalled" }), RestoreTimeoutError)
    pending.resolve()
    await tick()
    assert.equal(lateWrite, false)
  })
  it("propagates a deadline abort signal into a nested operation", async () => {
    let nestedSignal: AbortSignal | undefined
    await assert.rejects(runAbortable((deadlineSignal) => runAbortable((signal) => {
      nestedSignal = signal; return new Promise<never>(() => {})
    }, { timeoutMs: 1000, message: "nested stalled", signal: deadlineSignal }), { timeoutMs: 5, message: "deadline stalled" }), RestoreTimeoutError)
    assert.equal(nestedSignal?.aborted, true)
  })
  it("cancels the restore deadline when its owner is disposed", async () => {
    const controller = new AbortController()
    let restoreSignal: AbortSignal | undefined
    const completion = runAbortable(async (signal) => {
      restoreSignal = signal; await new Promise<never>(() => undefined)
    }, { timeoutMs: 1_000, message: "deadline stalled", signal: controller.signal })
    controller.abort(new Error("restore disposed"))
    await assert.rejects(completion, /restore disposed/)
    assert.equal(restoreSignal?.aborted, true)
  })
  it("rejects a SideCar load that completes after its restore signal aborts", async () => {
    const load = deferred()
    const controller = new AbortController()
    const completion = runAbortable(() => load.promise, { signal: controller.signal })
    controller.abort(new Error("SideCar restore timed out")); load.resolve()
    await assert.rejects(completion, /SideCar restore timed out/)
  })
})
