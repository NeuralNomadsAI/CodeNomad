import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { registerHooks } from "node:module"
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
    deadlineMs: 100,
    forceReserveMs: 80,
    force: () => { forces++; return true },
  }).then(() => { resolved = true })

  assert.equal(CLI_STOP_DEADLINE_MS, 30_000)
  assert.deepEqual(child.writes, [CLI_SHUTDOWN_COMMAND])
  await delay(50)
  assert.equal(forces, 1)
  await stopped
  assert.equal(resolved, true)
})

test("an absolute stop deadline includes work completed before stopManagedChild starts", async () => {
  const child = new FakeChild()
  const deadlineAt = Date.now() + 500
  await delay(100)
  const started = Date.now()

  await stopManagedChild({
    child,
    isExited: () => false,
    deadlineMs: 1_000,
    deadlineAt,
    forceReserveMs: 200,
    force: () => true,
  })

  assert.ok(Date.now() - started < 800)
})

test("the hard stop deadline rejects even when force never settles", { timeout: 500 }, async () => {
  const child = new FakeChild()
  const started = Date.now()

  await assert.rejects(stopManagedChild({
    child,
    isExited: () => false,
    deadlineMs: 30,
    forceReserveMs: 20,
    force: () => new Promise<boolean>(() => {}),
  }), /overall deadline/)
  assert.ok(Date.now() - started < 100)
})

test("the hard deadline also bounds enforcement for an already-exited child", { timeout: 500 }, async () => {
  const child = new FakeChild()
  child.exited = true

  await assert.rejects(stopManagedChild({
    child,
    isExited: () => true,
    isCleanupComplete: () => false,
    deadlineMs: 20,
    force: () => new Promise<boolean>(() => {}),
  }), /overall deadline/)
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
    deadlineMs: 100,
    forceReserveMs: 90,
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

test("tree capture records immutable root and nested descendant identities", async () => {
  const list = (() => ({ status: 0, stdout: "100|1|linux:boot:10\n200|100|linux:boot:20\n201|200|linux:boot:21\n999|1|linux:boot:99\n", stderr: "", pid: 1,
    signal: null, output: [] }))
  const tree = await captureProcessTree(100, "linux", list)
  assert.deepEqual(tree, { platform: "linux", members: [
    { pid: 100, startIdentity: "linux:boot:10" },
    { pid: 200, startIdentity: "linux:boot:20" },
    { pid: 201, startIdentity: "linux:boot:21" },
  ] })
})

test("Windows tree capture ignores the system idle PID without rejecting the process table", async () => {
  const list = (() => ({
    status: 0,
    error: undefined,
    stdout: "0|0|win32:system\n100|0|win32:100\n101|100|win32:101\n",
    stderr: "",
  }))
  assert.deepEqual((await captureProcessTree(100, "win32", list))?.members, [
    { pid: 100, startIdentity: "win32:100" },
    { pid: 101, startIdentity: "win32:101" },
  ])
})

test("a malformed descendant row invalidates the entire process snapshot", async () => {
  const list = (() => ({
    status: 0,
    stdout: "100|0|win32:100\n101|100|win32:\n",
    stderr: "",
  }))

  assert.equal(await captureProcessTree(100, "win32", list), undefined)
})

test("Windows verifies creation time and terminates through one native process handle", async () => {
  const commands: Array<{ command: string; args: readonly string[] }> = []
  let terminated = false
  const tree = { platform: "win32" as const, members: [{ pid: 42, startIdentity: "win32:638800000000000000" }] }
  const runner = async (command: string, args: readonly string[]) => {
    commands.push({ command, args })
    terminated = true
    return { status: 0, stdout: "terminated\n", stderr: "" }
  }
  const lookup = async () => {
    assert.equal(terminated, true, "identity was queried separately before the handle-bound termination")
    return undefined
  }
  const kill = (() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error }) as typeof process.kill

  assert.equal(await forceCapturedProcessTree(tree, lookup, runner, kill), true)
  assert.equal(commands.length, 1)
  assert.equal(commands[0]!.command, "powershell.exe")
  const script = commands[0]!.args.join(" ")
  assert.match(script, /OpenProcess/)
  assert.match(script, /GetProcessTimes/)
  assert.match(script, /TerminateProcess/)
  assert.match(script, /CloseHandle/)
  assert.match(script, /638800000000000000/)
  assert.doesNotMatch(script, /taskkill/i)
})

test("Windows native-handle termination refuses a live process with a mismatched creation time", {
  skip: process.platform !== "win32",
  timeout: 5_000,
}, async () => {
  const tree = { platform: "win32" as const, members: [{ pid: process.pid, startIdentity: "win32:1" }] }

  assert.equal(await forceCapturedProcessTree(tree), true)
  assert.doesNotThrow(() => process.kill(process.pid, 0))
})

test("Windows native-handle termination accepts CIM precision for an owned process", {
  skip: process.platform !== "win32",
  timeout: 10_000,
}, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") })
  assert.ok(child.pid)
  const exited = once(child, "exit")
  const tree = await captureProcessTree(child.pid, "win32")
  assert.ok(tree)

  assert.equal(await forceCapturedProcessTree(tree), true)
  await exited
})

test("Windows native-handle termination refuses a sub-microsecond identity mismatch", {
  skip: process.platform !== "win32",
  timeout: 10_000,
}, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") })
  assert.ok(child.pid)
  const tree = await captureProcessTree(child.pid, "win32")
  assert.ok(tree)
  tree.members[0]!.startIdentity = `win32:${BigInt(tree.members[0]!.startIdentity.slice(6)) + 1n}`

  assert.equal(await forceCapturedProcessTree(tree), true)
  assert.doesNotThrow(() => process.kill(child.pid!, 0))
})

test("PID reuse is identity-guarded on Windows and POSIX", async () => {
  for (const platform of ["win32", "linux"] as const) {
    const commands: string[][] = []
    const signals: number[] = []
    const tree = { platform, members: [{ pid: 42, startIdentity: platform === "win32" ? "win32:1" : "old" }] }
    const runTaskkill = ((_command: string, args: readonly string[]) => {
      commands.push([...args])
      return { status: 0, stdout: "mismatch\n", stderr: "", pid: 1, signal: null, output: [] }
    })
    const kill = ((pid: number) => { signals.push(pid); return true }) as typeof process.kill

    assert.equal(await forceCapturedProcessTree(tree, () => "reused", runTaskkill, kill), true)
    assert.equal(commands.length, platform === "win32" ? 1 : 0)
    assert.deepEqual(signals, [])
  }
})

test("a stale captured identity cannot authorize termination after handle-bound PID reuse", async () => {
  let commands = 0
  const tree = { platform: "win32" as const, members: [{ pid: 42, startIdentity: "win32:1" }] }
  const runTaskkill = (() => {
    commands++
    return { status: 0, stdout: "mismatch\n", stderr: "", pid: 1, signal: null, output: [] }
  })

  assert.equal(await forceCapturedProcessTree(tree, undefined, runTaskkill, process.kill, {
    revalidateIdentity: async () => "reused",
  }), true)
  assert.equal(commands, 1)
})

test("a successful snapshot omission still requires a liveness check", async () => {
  let lookups = 0
  let livenessChecks = 0
  const tree = { platform: "win32" as const, members: [{ pid: 42, startIdentity: "win32:1" }] }
  const runTaskkill = (() => ({ status: 0, stdout: "terminated\n", stderr: "", pid: 1, signal: null, output: [] }))
  const kill = ((_pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) livenessChecks++
    return true
  }) as typeof process.kill

  assert.equal(await forceCapturedProcessTree(
    tree,
    () => { lookups++; return undefined },
    runTaskkill,
    kill,
  ), false)
  assert.equal(lookups, 1)
  assert.equal(livenessChecks, 1)
})

test("enforcement awaits asynchronous commands without blocking timers", async () => {
  let settled = false
  let timerFired = false
  const tree = { platform: "win32" as const, members: [{ pid: 42, startIdentity: "win32:1" }] }
  const enforcement = Promise.resolve(forceCapturedProcessTree(
    tree,
    async () => undefined,
    (async () => {
      await delay(30)
      return { status: 0, stdout: "terminated\n", stderr: "", pid: 1, signal: null, output: [] }
    }),
    (() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error }) as typeof process.kill,
  )).then((value) => { settled = true; return value })
  setTimeout(() => { timerFired = true }, 1)

  await delay(5)
  assert.equal(timerFired, true)
  assert.equal(settled, false)
  assert.equal(await enforcement, true)
})

test("failed initial capture retains a bounded spawn-time root identity", async () => {
  const module = await import("./process-stop") as typeof import("./process-stop") & {
    captureInitialProcessTree(...args: unknown[]): Promise<{ tree?: unknown; rootStartIdentity?: string }>
  }
  const timeouts: number[] = []
  let lookupStarted = false
  const result = await module.captureInitialProcessTree(
    100,
    "win32",
    async () => {
      assert.equal(lookupStarted, true)
      return { status: 1, stdout: "", stderr: "" }
    },
    async (_pid: number, timeoutMs: number) => { lookupStarted = true; timeouts.push(timeoutMs); return "win32:100" },
    Date.now() + 500,
  )

  assert.equal(result.rootStartIdentity, "win32:100")
  assert.ok(timeouts[0]! > 0 && timeouts[0]! <= 500)
  assert.deepEqual(mergeCapturedProcessTrees(undefined, {
    platform: "win32",
    members: [{ pid: 100, startIdentity: "win32:100" }],
  }, 100, result.rootStartIdentity), {
    platform: "win32",
    members: [{ pid: 100, startIdentity: "win32:100" }],
  })
})

test("tree enforcement stops launching commands when its deadline is spent", async () => {
  const tree = { platform: "win32" as const, members: [
    { pid: 101, startIdentity: "win32:1" },
    { pid: 102, startIdentity: "win32:2" },
    { pid: 103, startIdentity: "win32:3" },
  ] }
  const timeouts: number[] = []
  let now = 0
  const runTaskkill = ((_command: string, _args: readonly string[], options: { timeout?: number }) => {
    timeouts.push(options.timeout ?? 0)
    now += options.timeout ?? 0
    return { status: 0, stdout: "terminated\n", stderr: "", pid: 1, signal: null, output: [] }
  })

  assert.equal(await forceCapturedProcessTree(tree, undefined, runTaskkill, process.kill, {
    deadlineAt: 2_500,
    now: () => now,
  }), false)
  assert.deepEqual(timeouts, [1_500, 1_000])
})

test("later captures preserve root ownership and add every descendant identity", async () => {
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
  assert.equal(await forceCapturedProcessTree(merged, (pid) => identities.get(pid), undefined, kill), true)
  assert.deepEqual(signals, [300, 200, 100])

  const survivingIdentities = new Map([[100, "root"], [200, "reused-child"], [300, "new-child"]])
  assert.equal(await forceCapturedProcessTree(
    merged,
    (pid) => survivingIdentities.get(pid),
    undefined,
    (() => true) as typeof process.kill,
  ), false)

  const reusedRoot = mergeCapturedProcessTrees(captured, {
    platform: "linux",
    members: [{ pid: 100, startIdentity: "reused-root" }, { pid: 400, startIdentity: "foreign-child" }],
  }, 100)
  assert.deepEqual(reusedRoot, captured)
  const rootSignals: number[] = []
  assert.equal(await forceCapturedProcessTree(
    reusedRoot!,
    (pid) => pid === 100 ? "reused-root" : undefined,
    undefined,
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

test("captured descendants are forced individually in child-first order", async () => {
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

  assert.equal(await forceCapturedProcessTree(tree, (pid) => identities.get(pid), undefined, kill), true)
  assert.deepEqual(signals, [201, 200, 100])
})

test("signal dispatch is not confirmation while the captured identity remains", async () => {
  const tree = { platform: "linux" as const, members: [{ pid: 42, startIdentity: "owned" }] }
  const kill = (() => true) as typeof process.kill

  assert.equal(await forceCapturedProcessTree(tree, () => "owned", undefined, kill), false)
})

test("process manager keeps incomplete shutdown terminal and interrupts a pending startup", async () => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron") {
        return { shortCircuit: true, url: "data:text/javascript,export const app={isPackaged:false,getAppPath(){return ''}}" }
      }
      return nextResolve(specifier, context)
    },
  })
  try {
    const { CliProcessManager } = await import("./process-manager")
    const manager = new CliProcessManager()
    let enforcements = 0
    ;(manager as EventEmitter).on("shutdownIncomplete", () => { enforcements++ })

    ;(manager as any).handleStream(
      "CODENOMAD_SHUTDOWN_STATUS:incomplete\nCODENOMAD_SHUTDOWN_STATUS:complete\n",
      "stdout",
    )

    assert.equal((manager as any).shutdownStatus, "incomplete")
    assert.equal(enforcements, 1)

    const pending = new CliProcessManager()
    ;(pending as any).resolveCliEntry = () => new Promise(() => {})
    const startup = pending.start({ dev: false })
    await new Promise((resolve) => setImmediate(resolve))
    const shutdown = pending.shutdown()
    await assert.rejects(startup, /startup interrupted by shutdown/)
    await shutdown
  } finally {
    hooks.deregister()
  }
})
