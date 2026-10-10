import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { lookupProcess, ownerState } from "./process-identity"

test("owner identity ambiguity never becomes permission to replace a live process", async () => {
  const owner = { pid: 123, startIdentity: "original" }
  assert.equal(await ownerState(owner, async () => ({ state: "unknown" })), "unknown")
  assert.equal(await ownerState(owner, async () => ({ state: "live", startIdentity: "original" })), "live")
  assert.equal(await ownerState(owner, async () => ({ state: "live", startIdentity: "reused" })), "dead")
  for (const pid of [0, -1, NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(await lookupProcess(pid), { state: "unknown" })
})

test("native start identity observes only a private child and its confirmed exit", {
  skip: process.platform !== "linux" && process.platform !== "win32", timeout: 15_000,
}, async t => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  await once(child, "spawn")
  const live = await lookupProcess(child.pid!)
  assert.equal(live.state, "live")
  if (live.state !== "live") return
  const owner = { pid: child.pid!, startIdentity: live.startIdentity }
  assert.equal(await ownerState(owner, lookupProcess), "live")
  const exited = once(child, "exit")
  child.stdin!.end()
  await exited
  assert.equal(await ownerState(owner, lookupProcess), "dead")
})
