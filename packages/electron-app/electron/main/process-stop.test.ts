import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import {
  CLI_SHUTDOWN_COMMAND,
  CLI_STOP_DEADLINE_MS,
  captureProcessTree,
  forceCapturedProcessTree,
  stopManagedChild,
} from "./process-stop"

class FakeChild extends EventEmitter {
  writes: string[] = []
  exited = false
  stdin = {
    writable: true,
    destroyed: false,
    end: (chunk: string, callback: (error?: Error | null) => void) => {
      this.writes.push(chunk)
      callback()
    },
  }
}

test("force success terminates stop without requiring an exit event", async () => {
  const child = new FakeChild()
  let forces = 0
  let resolved = false
  const stopped = stopManagedChild({
    child,
    isExited: () => child.exited,
    deadlineMs: 10,
    force: () => { forces++; return true },
  }).then(() => { resolved = true })

  assert.equal(CLI_STOP_DEADLINE_MS, 30_000)
  assert.deepEqual(child.writes, [CLI_SHUTDOWN_COMMAND])
  await delay(25)
  assert.equal(forces, 1)
  await stopped
  assert.equal(resolved, true)
})

test("confirmed exit cancels the delayed force command", async () => {
  const child = new FakeChild()
  let forces = 0
  const stopped = stopManagedChild({
    child,
    isExited: () => child.exited,
    deadlineMs: 15,
    force: () => { forces++; return true },
  })

  child.exited = true
  child.emit("exit")
  await stopped
  await delay(30)
  assert.equal(forces, 0)
})

test("unconfirmed final enforcement retries until the process exits", async () => {
  const child = new FakeChild()
  let forces = 0
  const stopped = stopManagedChild({
    child,
    isExited: () => child.exited,
    deadlineMs: 5,
    forceRetryMs: 5,
    force: () => {
      forces++
      if (forces < 2) return false
      child.exited = true
      child.emit("exit")
      return true
    },
  })

  await stopped
  assert.equal(forces, 2)
})

test("exit without a complete shutdown handshake enforces the captured tree", async () => {
  const child = new FakeChild()
  let forces = 0
  const stopped = stopManagedChild({
    child,
    isExited: () => child.exited,
    isCleanupComplete: () => false,
    force: () => { forces++; return true },
  })

  child.exited = true
  child.emit("exit")
  await stopped
  assert.equal(forces, 1)
})

test("ending CLI stdin permits a real child to exit naturally", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["-e", `
    let buffer = ""
    process.stdin.on("data", (chunk) => {
      buffer += chunk
      if (!buffer.includes(${JSON.stringify(CLI_SHUTDOWN_COMMAND.trim())})) return
      process.stdin.removeAllListeners("data")
      process.stdin.pause()
      setTimeout(() => { process.exitCode = 0 }, 10)
    })
  `], { stdio: ["pipe", "ignore", "inherit"] })
  let forces = 0

  await stopManagedChild({
    child,
    isExited: () => child.exitCode !== null || child.signalCode !== null,
    deadlineMs: 1_000,
    force: () => { forces++; child.kill("SIGKILL"); return true },
  })

  assert.equal(child.exitCode, 0)
  assert.equal(forces, 0)
})

test("utility-style shutdown requests a signal without pretending stdin is available", async () => {
  const child = new FakeChild()
  child.stdin = null as never
  let gracefulRequests = 0
  const stopped = stopManagedChild({
    child,
    isExited: () => child.exited,
    useStdinShutdown: false,
    requestGracefulStop: () => { gracefulRequests++ },
    force: () => true,
  })
  assert.equal(gracefulRequests, 1)
  child.exited = true
  child.emit("exit")
  await stopped
})

test("tree capture records immutable root and nested descendant identities", () => {
  const list = (() => ({ status: 0, stdout: "100|1|linux:boot:10\n200|100|linux:boot:20\n201|200|linux:boot:21\n999|1|linux:boot:99\n", stderr: "", pid: 1,
    signal: null, output: [] })) as unknown as typeof spawnSync
  const tree = captureProcessTree(100, "linux", list)
  assert.deepEqual(tree, { platform: "linux", members: [
    { pid: 100, startIdentity: "linux:boot:10" },
    { pid: 200, startIdentity: "linux:boot:20" },
    { pid: 201, startIdentity: "linux:boot:21" },
  ] })
})

test("PID reuse is identity-guarded on Windows and POSIX", () => {
  for (const platform of ["win32", "linux"] as const) {
    const taskkills: string[][] = []
    const signals: number[] = []
    const tree = { platform, members: [{ pid: 42, startIdentity: "old" }] }
    const runTaskkill = ((_command: string, args: readonly string[]) => {
      taskkills.push([...args])
      return { status: 0, stdout: "", stderr: "", pid: 1, signal: null, output: [] }
    }) as unknown as typeof spawnSync
    const kill = ((pid: number) => { signals.push(pid); return true }) as typeof process.kill

    assert.equal(forceCapturedProcessTree(tree, () => "reused", runTaskkill, kill), true)
    assert.deepEqual(taskkills, [])
    assert.deepEqual(signals, [])
  }
})

test("captured descendants are forced individually in child-first order", () => {
  const signals: number[] = []
  const tree = { platform: "linux" as const, members: [
    { pid: 100, startIdentity: "a" }, { pid: 200, startIdentity: "b" }, { pid: 201, startIdentity: "c" },
  ] }
  const identities = new Map([[100, "a"], [200, "b"], [201, "c"]])
  const kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) {
      if (identities.has(pid)) return true
      const error = new Error("gone") as NodeJS.ErrnoException
      error.code = "ESRCH"
      throw error
    }
    signals.push(pid)
    identities.delete(pid)
    return true
  }) as typeof process.kill

  assert.equal(forceCapturedProcessTree(tree, (pid) => identities.get(pid), spawnSync, kill), true)
  assert.deepEqual(signals, [201, 200, 100])
})

test("signal dispatch is not confirmation while the captured identity remains", () => {
  const tree = { platform: "linux" as const, members: [{ pid: 42, startIdentity: "owned" }] }
  const kill = (() => true) as typeof process.kill

  assert.equal(forceCapturedProcessTree(tree, () => "owned", spawnSync, kill), false)
})
