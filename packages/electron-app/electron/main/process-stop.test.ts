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
  mergeCapturedProcessTrees,
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

test("Windows tree capture ignores the system idle PID without rejecting the process table", () => {
  const list = (() => ({
    status: 0,
    error: undefined,
    stdout: "0|0|win32:system\n100|0|win32:root\n101|100|win32:child\n",
  })) as unknown as typeof spawnSync
  assert.deepEqual(captureProcessTree(100, "win32", list)?.members, [
    { pid: 100, startIdentity: "win32:root" },
    { pid: 101, startIdentity: "win32:child" },
  ])
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

test("later captures preserve root ownership and add every descendant identity", () => {
  const captured = { platform: "linux" as const, members: [
    { pid: 100, startIdentity: "root" },
    { pid: 200, startIdentity: "old-child" },
  ] }
  const latest = { platform: "linux" as const, members: [
    { pid: 100, startIdentity: "root" },
    { pid: 200, startIdentity: "reused-child" },
    { pid: 300, startIdentity: "new-child" },
  ] }

  const merged = mergeCapturedProcessTrees(captured, latest, 100)!
  assert.deepEqual(merged.members, [
    { pid: 100, startIdentity: "root" },
    { pid: 200, startIdentity: "old-child" },
    { pid: 200, startIdentity: "reused-child" },
    { pid: 300, startIdentity: "new-child" },
  ])
  const identities = new Map([[100, "root"], [200, "reused-child"], [300, "new-child"]])
  const signals: number[] = []
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
  assert.equal(forceCapturedProcessTree(merged, (pid) => identities.get(pid), spawnSync, kill), true)
  assert.deepEqual(signals, [300, 200, 100])

  const survivingIdentities = new Map([[100, "root"], [200, "reused-child"], [300, "new-child"]])
  assert.equal(forceCapturedProcessTree(
    merged,
    (pid) => survivingIdentities.get(pid),
    spawnSync,
    (() => true) as typeof process.kill,
  ), false)

  const reusedRoot = mergeCapturedProcessTrees(captured, {
    platform: "linux",
    members: [{ pid: 100, startIdentity: "reused-root" }, { pid: 400, startIdentity: "foreign-child" }],
  }, 100)
  assert.deepEqual(reusedRoot, captured)
  const rootSignals: number[] = []
  assert.equal(forceCapturedProcessTree(
    reusedRoot!,
    (pid) => pid === 100 ? "reused-root" : undefined,
    spawnSync,
    ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const error = new Error("gone") as NodeJS.ErrnoException
        error.code = "ESRCH"
        throw error
      }
      rootSignals.push(pid)
      return true
    }) as typeof process.kill,
  ), true)
  assert.deepEqual(rootSignals, [])
  assert.equal(mergeCapturedProcessTrees(undefined, latest, 100), undefined)
})

test("a matching late capture becomes the baseline after the initial capture fails", () => {
  const latest = { platform: "linux" as const, members: [
    { pid: 100, startIdentity: "original-root" },
    { pid: 200, startIdentity: "child" },
  ] }

  assert.deepEqual(mergeCapturedProcessTrees(undefined, latest, 100, "original-root"), latest)
  assert.equal(mergeCapturedProcessTrees(undefined, latest, 100, "reused-root"), undefined)
})

test("an exited root without a trustworthy capture cannot confirm containment", async () => {
  const child = new FakeChild()
  child.exited = true
  let tree: ReturnType<typeof mergeCapturedProcessTrees>

  await assert.rejects(stopManagedChild({
    child,
    isExited: () => child.exited,
    isCleanupComplete: () => false,
    forceAttempts: 1,
    force: () => {
      tree = mergeCapturedProcessTrees(tree, undefined, 100, "original-root")
      return tree ? forceCapturedProcessTree(tree) : false
    },
  }), /termination was not confirmed/)
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
