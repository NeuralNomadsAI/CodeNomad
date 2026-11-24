import assert from "node:assert/strict"
import test from "node:test"
import { resolveManagedProcessExit, shouldReportManagedProcessError } from "./process-exit"

test("requested and invalidated process exits do not become failures", () => {
  assert.deepEqual(resolveManagedProcessExit(undefined, 0, null, true, true), { state: "stopped" })
  assert.equal(resolveManagedProcessExit(undefined, 1, null, false, false), null)
})

test("unexpected exits report their code or signal", () => {
  assert.deepEqual(resolveManagedProcessExit(undefined, 0, null, false, true), {
    state: "error",
    error: "CLI exited unexpectedly (code 0)",
  })
  assert.match(resolveManagedProcessExit(undefined, null, "SIGTERM", false, true)?.error ?? "", /signal SIGTERM/)
  assert.equal(resolveManagedProcessExit("startup failed", 1, null, false, true)?.error, "startup failed")
})

test("child errors are reported only for the current process outside a requested stop", () => {
  assert.equal(shouldReportManagedProcessError(false, true), true)
  assert.equal(shouldReportManagedProcessError(true, true), false)
  assert.equal(shouldReportManagedProcessError(false, false), false)
})
