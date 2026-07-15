import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import {
  CLI_SHUTDOWN_COMMAND,
  CLI_STOP_DEADLINE_MS,
  forcePosixProcessTree,
  forceWindowsProcessTree,
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

test("graceful CLI stop waits for confirmed exit after the force deadline", async () => {
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
  assert.equal(resolved, false)

  child.exited = true
  child.emit("exit")
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

test("Windows tree enforcement requires successful taskkill completion", () => {
  const calls: string[][] = []
  const completed = ((_command: string, args: readonly string[]) => {
    calls.push([...args])
    return { status: 0, stdout: "", stderr: "", pid: 1, signal: null, output: [] }
  }) as unknown as typeof spawnSync
  const failed = (() => ({ status: 1, stdout: "", stderr: "failed", pid: 1, signal: null, output: [] })) as unknown as typeof spawnSync

  assert.equal(forceWindowsProcessTree(4242, completed), true)
  assert.equal(forceWindowsProcessTree(4242, failed), false)
  assert.deepEqual(calls, [["/PID", "4242", "/T", "/F"]])
})

test("Windows taskkill confirms termination of a real child tree", { skip: process.platform !== "win32", timeout: 5_000 }, async () => {
  const root = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `], { stdio: ["ignore", "pipe", "ignore"] })
  const [pidChunk] = await once(root.stdout!, "data")
  const descendantPid = Number(String(pidChunk).trim())

  assert.equal(forceWindowsProcessTree(root.pid!), true)
  await once(root, "exit")
  assert.throws(() => process.kill(descendantPid, 0), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ESRCH")
})

test("POSIX final enforcement targets nested detached groups", () => {
  const signals: number[] = []
  const ps = (() => ({
    status: 0,
    stdout: "100 1 100\n200 100 200\n201 200 200\n",
    stderr: "",
    pid: 1,
    signal: null,
    output: [],
  })) as unknown as typeof spawnSync
  const kill = ((pid: number) => { signals.push(pid); return true }) as typeof process.kill

  assert.equal(forcePosixProcessTree(100, ps, kill), true)
  assert.deepEqual(signals, [-100, -200, 100, 200, 201])
})

test("POSIX final enforcement includes detached descendant groups", { skip: process.platform === "win32" }, async () => {
  const root = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
  const [pidChunk] = await once(root.stdout!, "data")
  const detachedPid = Number(String(pidChunk).trim())

  assert.equal(forcePosixProcessTree(root.pid!, spawnSync), true)
  await once(root, "exit")
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(detachedPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return
      throw error
    }
    await delay(25)
  }
  assert.fail(`detached descendant ${detachedPid} remained alive`)
})
