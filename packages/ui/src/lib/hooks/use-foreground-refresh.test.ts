import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createForegroundRefreshController } from "./foreground-refresh-controller.ts"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("foreground refresh controller", () => {
  it("refreshes only after a disconnect and reconnect", async () => {
    let calls = 0
    const controller = createForegroundRefreshController(() => {
      calls += 1
    })

    controller.handle("connected")
    await tick()
    assert.equal(calls, 0)

    controller.handle("disconnected")
    controller.handle("connected")
    await tick()
    assert.equal(calls, 1)
    controller.dispose()
  })

  it("refreshes when the internal stream generation changes", async () => {
    let calls = 0
    const controller = createForegroundRefreshController(() => { calls += 1 })
    controller.handle("connected")
    controller.invalidate()
    await tick()
    assert.equal(calls, 1)
    controller.dispose()
  })

  it("runs a trailing refresh when another gap happens during recovery", async () => {
    const first = deferred()
    let calls = 0
    const controller = createForegroundRefreshController(() => {
      calls += 1
      return calls === 1 ? first.promise : undefined
    })

    controller.handle("disconnected")
    controller.handle("connected")
    await tick()
    controller.handle("disconnected")
    controller.handle("connected")
    first.resolve()
    await tick()
    await tick()

    assert.equal(calls, 2)
    controller.dispose()
  })

  it("retries a failed refresh while the transport stays connected", async () => {
    const timers: Array<() => void> = []
    let calls = 0
    const controller = createForegroundRefreshController(
      () => {
        calls += 1
        if (calls === 1) throw new Error("temporary")
      },
      {
        retryDelaysMs: [1],
        setTimer: (callback) => {
          timers.push(callback)
          return timers.length as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: () => {},
      },
    )

    controller.handle("disconnected")
    controller.handle("connected")
    await tick()
    assert.equal(calls, 1)
    assert.equal(timers.length, 1)

    timers[0]()
    await tick()
    assert.equal(calls, 2)
    controller.dispose()
  })

})
