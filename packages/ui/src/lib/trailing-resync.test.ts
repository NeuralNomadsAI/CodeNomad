import assert from "node:assert/strict"
import { it } from "node:test"
import { TrailingResyncCoordinator, waitForSettledPrerequisite } from "./trailing-resync.ts"
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise; reject = rejectPromise
  })
  return { promise, resolve, reject }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const coordinatorFor = (passes: ReturnType<typeof deferred>[], errors: unknown[] = []) => {
  let calls = 0
  return {
    coordinator: new TrailingResyncCoordinator(async () => passes[calls++]!.promise, (_key, error) => errors.push(error)),
    calls: () => calls,
  }
}
it("runs a trailing resync when reconnect occurs during an active pass", async () => {
  const passes = [deferred(), deferred()]
  const { coordinator, calls } = coordinatorFor(passes)
  const settled = coordinator.request("workspace-1"); await Promise.resolve()
  coordinator.request("workspace-1")
  assert.equal(calls(), 1)
  passes[0]!.resolve(); await turn()
  assert.equal(calls(), 2)
  passes[1]!.resolve(); await settled
})
it("coalesces requests into one pending pass per key", async () => {
  const passes = [deferred(), deferred(), deferred()]
  const { coordinator, calls } = coordinatorFor(passes)
  const first = coordinator.request("workspace-1")
  const sameTick = coordinator.request("workspace-1")
  const other = coordinator.request("workspace-2"); await Promise.resolve()
  assert.equal(calls(), 2, "a request before the pass starts shares it; another key runs independently")
  const trailing = Array.from({ length: 8 }, () => coordinator.request("workspace-1"))
  passes[0]!.resolve(); await turn()
  assert.equal(calls(), 3, "requests during a pass share one trailing pass")
  passes[1]!.resolve(); passes[2]!.resolve(); await Promise.all([first, sameTick, ...trailing, other])
  assert.equal(calls(), 3)
})
it("retries a queued resync after the active pass fails", async () => {
  const passes = [deferred(), deferred()]
  const errors: unknown[] = []
  const { coordinator, calls } = coordinatorFor(passes, errors)
  const settled = coordinator.request("workspace-1"); await Promise.resolve()
  coordinator.request("workspace-1")
  passes[0]!.reject(new Error("transport reset")); await turn()
  assert.equal(calls(), 2)
  passes[1]!.resolve(); await settled
  assert.equal(errors.length, 1)
})
it("does not lose a request queued as the previous pass settles", async () => {
  const firstPass = deferred()
  let calls = 0
  const coordinator = new TrailingResyncCoordinator(async () => {
    calls += 1
    if (calls === 1) await firstPass.promise
  }, () => undefined)
  const first = coordinator.request("workspace-1")
  const boundaryRequest = firstPass.promise.then(() => coordinator.request("workspace-1"))
  firstPass.resolve(); await first; await boundaryRequest
  assert.equal(calls, 2)
})
it("continues recovery after a prerequisite rejects", async () => {
  await assert.doesNotReject(waitForSettledPrerequisite(Promise.reject(new Error("initial hydration failed"))))
})
it("retries a failed pass with bounded backoff until one succeeds", async () => {
  let calls = 0
  const errors: unknown[] = []
  const coordinator = new TrailingResyncCoordinator(async () => {
    calls += 1
    if (calls <= 2) throw new Error("reconciliation failed")
  }, (_key, error) => errors.push(error), [5, 5, 5])
  await coordinator.request("workspace-1")
  assert.equal(calls, 1)
  const deadline = Date.now() + 2000
  while (calls < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls, 3, "each failed pass is retried")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, 3, "a successful pass ends the retries")
  assert.equal(errors.length, 2)
})
it("stops retrying once the backoff budget is spent, or when cancelled", async () => {
  let calls = 0
  const coordinator = new TrailingResyncCoordinator(async () => { calls += 1; throw new Error("still failing") }, () => undefined, [5, 5])
  await coordinator.request("workspace-1")
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(calls, 3, "one pass plus two bounded retries")
  calls = 0
  await coordinator.request("workspace-2")
  coordinator.cancel("workspace-2")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, 1)
})
