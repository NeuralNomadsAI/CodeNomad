import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import test, { type TestContext } from "node:test"
import { getProcessStartIdentity } from "./client-state-process-identity"

const commandPlatform = process.platform === "win32" || process.platform === "darwin"
const prefix = process.platform === "darwin" ? "darwin" : "win32"
function probe(t: TestContext, result: (timeout: number, attempt: number) => { elapsed: number; value?: string }) {
  let now = 0
  const timeouts: number[] = []
  t.mock.method(performance, "now", () => now)
  t.mock.method(childProcess, "spawnSync", (...args: any[]) => {
    const timeout = args[2].timeout as number
    timeouts.push(timeout)
    const reply = result(timeout, timeouts.length)
    now += reply.elapsed
    return { pid: 1, status: reply.value ? 0 : null, signal: reply.value ? null : "SIGTERM",
      stdout: reply.value ?? "", stderr: "", output: [null, reply.value ?? "", ""],
      error: reply.value ? undefined : Object.assign(new Error("probe unavailable"), { code: "ETIMEDOUT" }) }
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return timeouts
}

test("a slow cold identity helper succeeds inside the total lookup budget", { skip: !commandPlatform }, t => {
  const timeouts = probe(t, timeout => timeout >= 6_000 ? { elapsed: 6_000, value: "birth" } : { elapsed: timeout })
  assert.equal(getProcessStartIdentity(process.pid), `${prefix}:birth`)
  assert.deepEqual(timeouts, [10_000])
})

test("a failed identity attempt leaves only its remaining budget for the retry", { skip: !commandPlatform }, t => {
  const timeouts = probe(t, (_timeout, attempt) => attempt === 1 ? { elapsed: 4_000 } : { elapsed: 1_000, value: "birth" })
  assert.equal(getProcessStartIdentity(process.pid), `${prefix}:birth`)
  assert.deepEqual(timeouts, [10_000, 6_000])
})

test("identity budget exhaustion stays unavailable without starting another helper", { skip: !commandPlatform }, t => {
  const timeouts = probe(t, timeout => ({ elapsed: timeout }))
  assert.equal(getProcessStartIdentity(process.pid), undefined)
  assert.deepEqual(timeouts, [10_000])
})
