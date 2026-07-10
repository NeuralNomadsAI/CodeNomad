import assert from "node:assert/strict"
import type { ChildProcess, SpawnSyncReturns } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"
import pino from "pino"

import { EventBus } from "../events/bus"
import {
  WorkspaceRuntime,
  WorkspaceRuntimeIdentityCaptureError,
  WorkspaceRuntimeLaunchCancelledError,
  WorkspaceStopTimeoutError,
  WorkspaceWindowsTreeCleanupIncompleteError,
  type WorkspaceRuntimeOptions,
} from "./runtime"

type TimerHandle = ReturnType<typeof setTimeout>
type SpawnCommand = typeof import("node:child_process").spawnSync

class ManualTimers {
  private nextId = 1
  private readonly pending = new Map<number, { callback: () => void; delayMs: number }>()

  readonly setTimeout = (callback: () => void, delayMs: number): TimerHandle => {
    const id = this.nextId++
    this.pending.set(id, { callback, delayMs })
    return id as unknown as TimerHandle
  }

  readonly clearTimeout = (timer: TimerHandle): void => {
    this.pending.delete(timer as unknown as number)
  }

  runNext(): void {
    const next = Array.from(this.pending.entries()).sort((left, right) => left[1].delayMs - right[1].delayMs || left[0] - right[0])[0]
    assert.ok(next, "expected a pending timer")
    this.pending.delete(next[0])
    next[1].callback()
  }

  get size(): number {
    return this.pending.size
  }
}

class FakeChild extends EventEmitter {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly liveSignals: NodeJS.Signals[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.liveSignals.push(signal)
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
  }
}

function result(stdout = "", status = 0, stderr = ""): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null }
}

function linuxRows(rows: Array<[number, number, number, string]>, bootId = "boot-a"): string {
  return rows.map(([pid, parentPid, groupId, start]) => `${pid}|${parentPid}|${groupId}|${start}|${bootId}|${start}`).join("\n")
}

function windowsRows(rows: Array<[number, number, string]>): string {
  return rows.map(([pid, parentPid, start], index) => `${pid}|${parentPid}|0|${start}||${100 + index}`).join("\n")
}

function guardedRows(matched: boolean, rows: Array<[number, number, number, string]>, cutoff?: string, bootId = "boot-a"): string {
  const targets = rows.map(([pid, parentPid, groupId, start]) =>
    `CODENOMAD_TARGET|${pid}|${parentPid}|${groupId}|${start}|${bootId}|${start}`,
  )
  return [...targets, `CODENOMAD_RESULT|${matched ? "1" : "0"}|${cutoff ?? ""}|${targets.length > 0 ? "1" : "0"}`].join("\n")
}

function tokenSignalRows(rows: Array<[number, number, number, string]>, bootId = "boot-a"): string {
  return [
    ...rows.map(([pid, parentPid, groupId, start]) =>
      `CODENOMAD_TARGET|${pid}|${parentPid}|${groupId}|${start}|${bootId}|${start}`,
    ),
    `CODENOMAD_RESULT|${rows.length > 0 ? "1" : "0"}`,
  ].join("\n")
}

function isTokenCleanup(args: readonly string[]): boolean {
  return args.includes("codenomad-token-cleanup")
}

function isTokenSignal(args: readonly string[]): boolean {
  return isTokenCleanup(args) && args.some((arg) => arg.includes("for pass in 1 2 3"))
}

function isGuarded(args: readonly string[]): boolean {
  return !isTokenCleanup(args) && args.some((arg) => arg.includes("guarded-signal") || arg.includes("CODENOMAD_RESULT"))
}

async function createRuntime(
  options: Omit<WorkspaceRuntimeOptions, "spawn" | "setTimeout" | "clearTimeout"> = {},
  reportPort = true,
  binaryPath = "opencode",
) {
  const child = new FakeChild()
  const timers = new ManualTimers()
  const platform = options.platform ?? "linux"
  const defaultCommand = ((command: string, args: readonly string[]) => {
    if (isTokenCleanup(args)) {
      return isTokenSignal(args)
        ? result(tokenSignalRows([[4242, 1, 4242, "100"]]))
        : result(linuxRows([[4242, 1, 4242, "100"]]))
    }
    if (isGuarded(args)) {
      return platform === "win32"
        ? result("CODENOMAD_TARGET|4242|1|0|win-start||100\nCODENOMAD_RESULT|1||1")
        : result(guardedRows(true, [[4242, 1, 4242, "100"]], "200"))
    }
    return platform === "win32"
      ? result(windowsRows([[4242, 1, "win-start"]]))
      : result(linuxRows([[4242, 1, 4242, "100"]]))
  }) as unknown as SpawnCommand
  const runtime = new WorkspaceRuntime(new EventBus(), pino({ level: "silent" }), {
    gracefulStopTimeoutMs: 10,
    forcedStopTimeoutMs: 10,
    spawnSync: defaultCommand,
    ...options,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    spawn: (() => {
      if (reportPort) queueMicrotask(() => child.stdout.write("opencode server listening on http://127.0.0.1:4321\n"))
      return child as unknown as ChildProcess
    }) as typeof import("node:child_process").spawn,
  })
  const launch = runtime.launch({ workspaceId: "workspace-1", folder: process.cwd(), binaryPath })
  if (reportPort) await launch
  return { runtime, child, timers, launch }
}

function setWslIdentity(runtime: WorkspaceRuntime): void {
  const managed = (runtime as unknown as {
    processes: Map<string, { processKind: string; wsl?: Record<string, unknown> }>
  }).processes.get("workspace-1")
  assert.ok(managed)
  managed.processKind = "wsl"
  managed.wsl = {
    distro: "Ubuntu",
    linuxPid: 99,
    linuxPgid: 99,
    leaderStartTime: "50",
    bootId: "wsl-boot",
    members: new Map([[99, { pid: 99, parentPid: 1, groupId: 99, startTime: "50", bootId: "wsl-boot", startOrder: "50" }]]),
  }
}

describe("workspace runtime verified stop", () => {
  it("launches a direct Windows child without CIM identity discovery", async () => {
    let commandCalls = 0
    const harness = await createRuntime({
      platform: "win32",
      spawnSync: (() => {
        commandCalls += 1
        return result("", 1, "CIM unavailable")
      }) as unknown as SpawnCommand,
    }, true, "opencode.exe")

    assert.equal(commandCalls, 0)
    harness.child.exit(0, null)
  })

  it("stops a direct Windows child without invoking taskkill or PowerShell", async () => {
    const commands: string[] = []
    const harness = await createRuntime({
      platform: "win32",
      spawnSync: ((command: string) => {
        commands.push(command)
        return result("", 1, "ETIMEDOUT")
      }) as unknown as SpawnCommand,
    }, true, "opencode.exe")

    const stop = harness.runtime.stop("workspace-1")
    assert.deepEqual(harness.child.liveSignals, ["SIGTERM"])
    harness.child.exit(null, "SIGTERM")
    await stop
    assert.deepEqual(commands, [])
  })

  it("keeps direct Windows stop bounded when the child ignores termination", async () => {
    let commandCalls = 0
    const harness = await createRuntime({
      platform: "win32",
      spawnSync: (() => {
        commandCalls += 1
        return result()
      }) as unknown as SpawnCommand,
    }, true, "opencode.exe")

    const stop = harness.runtime.stop("workspace-1")
    harness.timers.runNext()
    assert.deepEqual(harness.child.liveSignals, ["SIGTERM", "SIGKILL"])
    harness.timers.runNext()
    await assert.rejects(stop, WorkspaceStopTimeoutError)
    assert.equal(commandCalls, 0)
  })

  it("cleans a token-matching descendant that survives its unidentified wrapper", async () => {
    const child = new FakeChild()
    const timers = new ManualTimers()
    let tokenAlive = true
    let spawnedToken = ""
    let logs = ""
    const tokenSignals: number[][] = []
    const runtime = new WorkspaceRuntime(new EventBus(), pino({ level: "trace" }, {
      write: (chunk: string) => { logs += chunk },
    }), {
      platform: "linux",
      spawnSync: ((_command: string, args: readonly string[]) => {
        if (isTokenCleanup(args)) {
          if (isTokenSignal(args)) {
            const rows: Array<[number, number, number, string]> = tokenAlive
              ? [[5000, 1, 4242, "150"]]
              : []
            tokenSignals.push(rows.map(([pid]) => pid))
            tokenAlive = false
            return result(tokenSignalRows(rows))
          }
          return result(tokenAlive ? linuxRows([[5000, 1, 4242, "150"]]) : "")
        }
        return result("", 1, "proc unavailable")
      }) as unknown as SpawnCommand,
      spawn: ((_command, _args, options) => {
        spawnedToken = String(options?.env?.CODENOMAD_LAUNCH_CLEANUP_TOKEN ?? "")
        return child as unknown as ChildProcess
      }) as typeof import("node:child_process").spawn,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    })

    await assert.rejects(
      runtime.launch({ workspaceId: "workspace-1", folder: process.cwd(), binaryPath: "opencode" }),
      WorkspaceRuntimeIdentityCaptureError,
    )
    assert.equal((runtime as unknown as { processes: Map<string, unknown> }).processes.size, 0)
    assert.deepEqual(child.liveSignals, ["SIGTERM"])
    assert.match(spawnedToken, /^[a-f0-9]{64}$/)
    assert.equal(logs.includes(spawnedToken), false)
    assert.match(logs, /\[REDACTED\]/)
    assert.deepEqual(tokenSignals, [[5000]])
  })

  it("uses one guarded command per signal", async () => {
    const guardedInvocations: readonly string[][] = []
    const mutableInvocations = guardedInvocations as string[][]
    const spawnCommand = ((_command: string, args: readonly string[]) => {
      if (isTokenCleanup(args)) {
        return isTokenSignal(args)
          ? result(tokenSignalRows([[4242, 1, 4242, "100"]]))
          : result(linuxRows([[4242, 1, 4242, "100"]]))
      }
      if (isGuarded(args)) {
        mutableInvocations.push([...args])
        return result(guardedRows(true, [[4242, 1, 4242, "100"]], "200"))
      }
      return result(linuxRows([[4242, 1, 4242, "100"]]))
    }) as unknown as SpawnCommand
    const harness = await createRuntime({
      platform: "linux",
      spawnSync: spawnCommand,
    })

    const stop = harness.runtime.stop("workspace-1")
    harness.timers.runNext()
    harness.timers.runNext()
    await assert.rejects(stop, WorkspaceStopTimeoutError)
    assert.equal(guardedInvocations.length, 2)
    assert.ok(guardedInvocations.every((args) => args.includes("codenomad-guarded-signal")))
  })

  it("sends no second command when the guarded operation reports identity mismatch", async () => {
    let launchProbe = true
    let guardedCommands = 0
    const spawnCommand = ((_command: string, args: readonly string[]) => {
      if (isTokenCleanup(args)) return result(isTokenSignal(args) ? tokenSignalRows([]) : "")
      if (isGuarded(args)) {
        guardedCommands += 1
        return result("CODENOMAD_RESULT|0||0")
      }
      if (launchProbe) {
        launchProbe = false
        return result(linuxRows([[4242, 1, 4242, "100"]]))
      }
      return result(linuxRows([[4242, 1, 4242, "300"]]))
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "linux", spawnSync: spawnCommand })

    const stop = harness.runtime.stop("workspace-1")
    await stop
    assert.equal(guardedCommands, 1)
  })

  it("tracks a descendant forked between the precheck and SIGTERM dispatch", async () => {
    let phase: "launch" | "after-term" | "after-kill" = "launch"
    const guardedTargets: string[][] = []
    const spawnCommand = ((_command: string, args: readonly string[]) => {
      if (isTokenCleanup(args)) {
        const rows: Array<[number, number, number, string]> = phase === "after-term" ? [[5000, 4242, 4242, "120"]] : []
        return result(isTokenSignal(args) ? tokenSignalRows(rows) : linuxRows(rows))
      }
      if (isGuarded(args)) {
        guardedTargets.push([...args])
        if (phase === "launch") {
          phase = "after-term"
          return result(guardedRows(true, [[4242, 1, 4242, "100"], [5000, 4242, 4242, "120"]], "200"))
        }
        phase = "after-kill"
        return result(guardedRows(false, [[5000, 4242, 4242, "120"]]))
      }
      if (phase === "launch") return result(linuxRows([[4242, 1, 4242, "100"]]))
      if (phase === "after-term") return result(linuxRows([[5000, 1, 4242, "120"]]))
      return result(linuxRows([[7, 1, 7, "10"]]))
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "linux", spawnSync: spawnCommand })

    const stop = harness.runtime.stop("workspace-1")
    harness.timers.runNext()
    harness.timers.runNext()
    await stop

    assert.ok(guardedTargets[1]?.includes("5000"))
    assert.ok(guardedTargets[1]?.includes("120"))
  })

  it("adopts a descendant forked after SIGTERM and before the returned cutoff", async () => {
    let phase: "launch" | "after-term" | "after-kill" = "launch"
    const guardedTargets: string[][] = []
    const spawnCommand = ((_command: string, args: readonly string[]) => {
      if (isTokenCleanup(args)) {
        const rows: Array<[number, number, number, string]> = phase === "after-term" ? [[5000, 1, 4242, "150"]] : []
        return result(isTokenSignal(args) ? tokenSignalRows(rows) : linuxRows(rows))
      }
      if (isGuarded(args)) {
        guardedTargets.push([...args])
        if (phase === "launch") {
          phase = "after-term"
          return result(guardedRows(true, [[4242, 1, 4242, "100"]], "200"))
        }
        phase = "after-kill"
        return result(guardedRows(false, [[5000, 4242, 4242, "150"]]))
      }
      if (phase === "launch") return result(linuxRows([[4242, 1, 4242, "100"]]))
      if (phase === "after-term") {
        return result(linuxRows([[5000, 1, 4242, "150"]]))
      }
      return result(linuxRows([[7, 1, 7, "10"]]))
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "linux", spawnSync: spawnCommand })

    const stop = harness.runtime.stop("workspace-1")
    harness.child.exit(0, null)
    harness.timers.runNext()
    harness.timers.runNext()
    await stop

    assert.equal(guardedTargets.length, 2)
    assert.ok(guardedTargets[1]?.includes("5000"), "SIGKILL must include the newly tracked immutable descendant")
    assert.ok(guardedTargets[1]?.includes("150"))
  })

  it("does not adopt a newly reused process group after original ownership is lost", async () => {
    let launched = false
    let termSent = false
    let guardedCommands = 0
    const spawnCommand = ((_command: string, args: readonly string[]) => {
      if (isTokenCleanup(args)) return result(isTokenSignal(args) ? tokenSignalRows([]) : "")
      if (isGuarded(args)) {
        guardedCommands += 1
        termSent = true
        return result(guardedRows(true, [[4242, 1, 4242, "100"]], "200"))
      }
      if (!launched) {
        launched = true
        return result(linuxRows([[4242, 1, 4242, "100"]]))
      }
      return termSent
        ? result(linuxRows([[4242, 1, 4242, "300"], [6000, 4242, 4242, "150"]]))
        : result(linuxRows([[4242, 1, 4242, "100"]]))
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "linux", spawnSync: spawnCommand })

    const stop = harness.runtime.stop("workspace-1")
    await stop
    assert.equal(guardedCommands, 1)
  })

  it("uses a guarded WSL command and retains immutable Linux identities", async () => {
    let alive = true
    const guardedCommands: string[][] = []
    const spawnCommand = ((command: string, args: readonly string[]) => {
      if (command === "powershell.exe") return result(windowsRows([[4242, 1, "host-start"]]))
      if (isTokenCleanup(args)) {
        const rows: Array<[number, number, number, string]> = alive ? [[99, 1, 99, "50"]] : []
        if (isTokenSignal(args)) alive = false
        return result(isTokenSignal(args) ? tokenSignalRows(rows, "wsl-boot") : linuxRows(rows, "wsl-boot"))
      }
      if (args.includes("codenomad-wsl-guarded-signal")) {
        guardedCommands.push([...args])
        alive = false
        return result(guardedRows(true, [[99, 1, 99, "50"]], "80", "wsl-boot"))
      }
      if (args.includes("codenomad-wsl-identity")) {
        return result(alive ? linuxRows([[99, 1, 99, "50"]], "wsl-boot") : linuxRows([[7, 1, 7, "10"]], "wsl-boot"))
      }
      return result()
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "win32", spawnSync: spawnCommand }, true, "opencode.cmd")
    setWslIdentity(harness.runtime)

    const stop = harness.runtime.stop("workspace-1")
    await stop
    assert.equal(guardedCommands.length, 1)
    assert.ok(guardedCommands[0]?.includes("wsl-boot"))
  })

  it("launches and stops a bare opencode cmd shim without PowerShell", async () => {
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const spawnCommand = ((command: string, args: readonly string[]) => {
      commands.push({ command, args: [...args] })
      return command === "powershell.exe" ? result("", 1, "ETIMEDOUT") : result()
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "win32", spawnSync: spawnCommand }, true, "opencode")

    const stop = harness.runtime.stop("workspace-1")
    assert.deepEqual(commands, [{ command: "taskkill.exe", args: ["/PID", "4242", "/T"] }])
    harness.child.exit(0, null)
    await stop
    assert.equal(commands.some(({ command }) => command === "powershell.exe"), false)
  })

  it("adds force only when Windows wrapper cleanup escalates", async () => {
    const invocations: readonly string[][] = []
    const harness = await createRuntime({
      platform: "win32",
      spawnSync: ((_command: string, args: readonly string[]) => {
        (invocations as string[][]).push([...args])
        return result()
      }) as unknown as SpawnCommand,
    }, true, "opencode.cmd")

    const stop = harness.runtime.stop("workspace-1")
    harness.timers.runNext()
    assert.deepEqual(invocations, [
      ["/PID", "4242", "/T"],
      ["/PID", "4242", "/T", "/F"],
    ])
    harness.child.exit(0, null)
    await stop
  })

  it("keeps failed Windows wrapper cleanup bounded and retryable", async () => {
    let available = false
    const harness = await createRuntime({
      platform: "win32",
      spawnSync: (() => available ? result() : result("", 1, "taskkill unavailable")) as unknown as SpawnCommand,
    }, true, "opencode.cmd")

    const first = harness.runtime.stop("workspace-1")
    harness.timers.runNext()
    harness.timers.runNext()
    await assert.rejects(first, (error: unknown) => {
      assert.ok(error instanceof WorkspaceStopTimeoutError)
      assert.match(error.message, /taskkill \/T failed: taskkill unavailable/)
      assert.match(error.message, /taskkill \/T \/F failed: taskkill unavailable/)
      return true
    })

    available = true
    const retry = harness.runtime.stop("workspace-1")
    harness.child.exit(0, null)
    await retry
  })

  it("never signals an exited wrapper PID after tree cleanup was not confirmed", async () => {
    const invocations: readonly string[][] = []
    const harness = await createRuntime({
      platform: "win32",
      spawnSync: ((_command: string, args: readonly string[]) => {
        (invocations as string[][]).push([...args])
        return result("", 1, "taskkill unavailable")
      }) as unknown as SpawnCommand,
    }, true, "opencode")

    const first = harness.runtime.stop("workspace-1")
    harness.child.exit(1, null)
    await assert.rejects(first, WorkspaceWindowsTreeCleanupIncompleteError)
    assert.equal((harness.runtime as unknown as { processes: Map<string, unknown> }).processes.size, 1)
    assert.deepEqual(invocations, [["/PID", "4242", "/T"]])

    const second = harness.runtime.stop("workspace-1")
    await assert.rejects(second, (error: unknown) => {
      assert.ok(error instanceof WorkspaceWindowsTreeCleanupIncompleteError)
      assert.match(error.message, /taskkill unavailable/)
      return true
    })
    assert.equal((harness.runtime as unknown as { processes: Map<string, unknown> }).processes.size, 1)
    assert.deepEqual(invocations, [["/PID", "4242", "/T"]])
  })

  it("persists confirmed wrapper tree cleanup across a later exit and retry", async () => {
    const invocations: readonly string[][] = []
    const harness = await createRuntime({
      platform: "win32",
      spawnSync: ((_command: string, args: readonly string[]) => {
        (invocations as string[][]).push([...args])
        return result()
      }) as unknown as SpawnCommand,
    }, true, "opencode.cmd")

    const first = harness.runtime.stop("workspace-1")
    harness.timers.runNext()
    harness.timers.runNext()
    await assert.rejects(first, WorkspaceStopTimeoutError)
    harness.child.exit(0, null)

    await harness.runtime.stop("workspace-1")
    assert.deepEqual(invocations, [
      ["/PID", "4242", "/T"],
      ["/PID", "4242", "/T", "/F"],
    ])
    assert.equal((harness.runtime as unknown as { processes: Map<string, unknown> }).processes.size, 0)
  })

  it("retains launch identity so a transient stop failure can recover on retry", async () => {
    let available = true
    let alive = true
    let guardedCommands = 0
    const spawnCommand = ((_command: string, args: readonly string[]) => {
      if (isTokenCleanup(args)) {
        if (!available) return result("", 1, "identity service unavailable")
        const rows: Array<[number, number, number, string]> = alive ? [[4242, 1, 4242, "100"]] : []
        if (isTokenSignal(args)) alive = false
        return result(isTokenSignal(args) ? tokenSignalRows(rows) : linuxRows(rows))
      }
      if (isGuarded(args)) {
        guardedCommands += 1
        if (!available) return result("", 1, "identity service unavailable")
        alive = false
        return result(guardedRows(true, [[4242, 1, 4242, "100"]], "200"))
      }
      if (!available) return result("", 1, "identity service unavailable")
      return result(alive ? linuxRows([[4242, 1, 4242, "100"]]) : linuxRows([[7, 1, 7, "10"]]))
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "linux", spawnSync: spawnCommand })

    available = false
    const first = harness.runtime.stop("workspace-1")
    harness.timers.runNext()
    harness.timers.runNext()
    await assert.rejects(first, /cleanup could not be confirmed/)

    available = true
    const retry = harness.runtime.stop("workspace-1")
    await retry
    assert.equal(guardedCommands, 3)
  })

  it("shares one bounded stop operation across concurrent callers", async () => {
    const harness = await createRuntime({ platform: "linux" })
    const first = harness.runtime.stop("workspace-1")
    const second = harness.runtime.stop("workspace-1")
    assert.strictEqual(first, second)
    harness.timers.runNext()
    harness.timers.runNext()
    const results = await Promise.allSettled([first, second])
    assert.equal(results[0].status, "rejected")
    assert.equal(results[1].status, "rejected")
  })

  it("cancels a no-port launch while retaining retryable stop state", async () => {
    let alive = true
    const spawnCommand = ((_command: string, args: readonly string[]) => {
      if (isTokenCleanup(args)) {
        const rows: Array<[number, number, number, string]> = alive ? [[4242, 1, 4242, "100"]] : []
        return result(isTokenSignal(args) ? tokenSignalRows(rows) : linuxRows(rows))
      }
      if (isGuarded(args)) return result(guardedRows(true, [[4242, 1, 4242, "100"]], "200"))
      return result(alive ? linuxRows([[4242, 1, 4242, "100"]]) : linuxRows([[7, 1, 7, "10"]]))
    }) as unknown as SpawnCommand
    const harness = await createRuntime({ platform: "linux", spawnSync: spawnCommand }, false)

    const firstStop = harness.runtime.stop("workspace-1")
    await assert.rejects(harness.launch, WorkspaceRuntimeLaunchCancelledError)
    harness.timers.runNext()
    harness.timers.runNext()
    await assert.rejects(firstStop, WorkspaceStopTimeoutError)

    alive = false
    const retry = harness.runtime.stop("workspace-1")
    await retry
  })
})
