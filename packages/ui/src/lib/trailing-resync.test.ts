import assert from "node:assert/strict"
import { it } from "node:test"

import { TrailingResyncCoordinator } from "./trailing-resync.ts"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

it("runs a trailing resync when reconnect occurs during an active pass", async () => {
  const passes = [deferred(), deferred()]
  let calls = 0
  const coordinator = new TrailingResyncCoordinator(
    async () => passes[calls++]!.promise,
    () => undefined,
  )

  const settled = coordinator.request("workspace-1")
  coordinator.request("workspace-1")
  await Promise.resolve()
  assert.equal(calls, 1)

  passes[0]!.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  passes[1]!.resolve()
  await settled
})

it("retries a queued resync after the active pass fails", async () => {
  const passes = [deferred(), deferred()]
  const errors: unknown[] = []
  let calls = 0
  const coordinator = new TrailingResyncCoordinator(
    async () => passes[calls++]!.promise,
    (_key, error) => errors.push(error),
  )

  const settled = coordinator.request("workspace-1")
  coordinator.request("workspace-1")
  await Promise.resolve()
  passes[0]!.reject(new Error("transport reset"))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  passes[1]!.resolve()
  await settled

  assert.equal(errors.length, 1)
})

it("does not lose a request queued as the previous pass settles", async () => {
  const firstPass = deferred()
  let calls = 0
  const coordinator = new TrailingResyncCoordinator(
    async () => {
      calls += 1
      if (calls === 1) await firstPass.promise
    },
    () => undefined,
  )

  const first = coordinator.request("workspace-1")
  const boundaryRequest = firstPass.promise.then(() => coordinator.request("workspace-1"))
  firstPass.resolve()
  await first
  await boundaryRequest

  assert.equal(calls, 2)
})
