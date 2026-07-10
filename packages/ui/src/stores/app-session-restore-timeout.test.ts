import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  awaitRestoreStep,
  RestoreTimeoutError,
  runWithRestoreDeadline,
  withRestoreTimeout,
} from "./app-session-restore-timeout.ts"

describe("app session restore timeouts", () => {
  it("rejects an operation that does not settle within its bound", async () => {
    let operationSignal: AbortSignal | undefined
    await assert.rejects(
      withRestoreTimeout((signal) => {
        operationSignal = signal
        return new Promise<never>(() => {})
      }, 5, "restore stalled"),
      (error) => error instanceof RestoreTimeoutError && error.message === "restore stalled",
    )
    assert.equal(operationSignal?.aborted, true)
  })

  it("deactivates a timed-out restore before its late completion", async () => {
    let finish: (() => void) | undefined
    let lateWrite = false
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })

    await assert.rejects(
      runWithRestoreDeadline(async (isActive) => {
        await pending
        if (isActive()) lateWrite = true
      }, 5, "startup restore stalled"),
      RestoreTimeoutError,
    )

    finish?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(lateWrite, false)
  })

  it("propagates a deadline abort signal into a nested operation", async () => {
    let nestedSignal: AbortSignal | undefined
    await assert.rejects(
      runWithRestoreDeadline(
        (_isActive, deadlineSignal) => withRestoreTimeout((signal) => {
          nestedSignal = signal
          return new Promise<never>(() => {})
        }, 1000, "nested stalled", deadlineSignal),
        5,
        "deadline stalled",
      ),
      RestoreTimeoutError,
    )
    assert.equal(nestedSignal?.aborted, true)
  })

  it("rejects a SideCar load that completes after its restore signal aborts", async () => {
    let finish: (() => void) | undefined
    const load = new Promise<void>((resolve) => {
      finish = resolve
    })
    const controller = new AbortController()
    const completion = awaitRestoreStep(load, controller.signal)
    controller.abort(new Error("SideCar restore timed out"))
    finish?.()
    await assert.rejects(completion, /SideCar restore timed out/)
  })
})
