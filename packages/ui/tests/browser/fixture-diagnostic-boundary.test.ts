import assert from "node:assert/strict"
import { test } from "node:test"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"

async function capture(run: () => Promise<unknown>) {
  let caught = false
  let thrown: unknown
  try {
    await run()
  } catch (error) {
    caught = true
    thrown = error
  }
  return { caught, thrown }
}

test("diagnostic and cleanup failures preserve the primary error identity and stack", async () => {
  const primary = new Error("primary")
  const stack = primary.stack
  const observation = new Error("observation")
  const cleanup = new Error("cleanup")
  const observations: unknown[] = []
  const cleanups: unknown[] = []
  const result = await capture(() => runWithDiagnosticCleanup({
    run: async () => { throw primary },
    diagnose: async () => { throw observation },
    cleanup: async () => { throw cleanup },
    onObservationError: error => observations.push(error),
    onCleanupError: error => cleanups.push(error),
  }))
  assert.equal(result.caught, true)
  assert.equal(result.thrown, primary)
  assert.equal((result.thrown as Error).stack, stack)
  assert.deepEqual(observations, [observation])
  assert.deepEqual(cleanups, [cleanup])
})

test("a successful snapshot and failed cleanup still preserve the primary error", async () => {
  const primary = new Error("primary")
  const cleanup = new Error("cleanup")
  let diagnosed = false
  const cleanups: unknown[] = []
  const result = await capture(() => runWithDiagnosticCleanup({
    run: async () => { throw primary },
    diagnose: async () => { diagnosed = true },
    cleanup: async () => { throw cleanup },
    onObservationError: () => assert.fail("unexpected observation error"),
    onCleanupError: error => cleanups.push(error),
  }))
  assert.equal(diagnosed, true)
  assert.equal(result.thrown, primary)
  assert.deepEqual(cleanups, [cleanup])
})

test("falsy primary errors are preserved when cleanup fails", async () => {
  for (const primary of [undefined, null]) {
    const cleanup = new Error("cleanup")
    const cleanups: unknown[] = []
    const result = await capture(() => runWithDiagnosticCleanup({
      run: async () => { throw primary },
      diagnose: async () => {},
      cleanup: async () => { throw cleanup },
      onObservationError: () => assert.fail("unexpected observation error"),
      onCleanupError: error => cleanups.push(error),
    }))
    assert.equal(result.caught, true)
    assert.equal(result.thrown, primary)
    assert.deepEqual(cleanups, [cleanup])
  }
})

test("cleanup failure after success remains the test failure", async () => {
  const cleanup = new Error("cleanup")
  const result = await capture(() => runWithDiagnosticCleanup({
    run: async () => "success",
    diagnose: async () => assert.fail("diagnostics must not run after success"),
    cleanup: async () => { throw cleanup },
    onObservationError: () => assert.fail("unexpected observation error"),
    onCleanupError: () => assert.fail("cleanup must propagate after success"),
  }))
  assert.equal(result.caught, true)
  assert.equal(result.thrown, cleanup)
})

test("success and cleanup success preserve the result", async () => {
  const result = await runWithDiagnosticCleanup({
    run: async () => "success",
    diagnose: async () => assert.fail("diagnostics must not run after success"),
    cleanup: async () => {},
    onObservationError: () => assert.fail("unexpected observation error"),
    onCleanupError: () => assert.fail("unexpected cleanup error"),
  })
  assert.equal(result, "success")
})
