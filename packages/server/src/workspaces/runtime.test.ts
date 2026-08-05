import assert from "node:assert/strict"
import type { ChildProcess, SpawnSyncReturns } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"
import pino from "pino"

import { EventBus } from "../events/bus"
import { WorkspaceRuntime, WorkspaceRuntimeIdentityCaptureError, WorkspaceStopTimeoutError,
  WorkspaceWindowsTreeCleanupIncompleteError, type WorkspaceRuntimeOptions } from "./runtime"
type Timer = ReturnType<typeof setTimeout>
type Command = typeof import("node:child_process").spawnSync
type Call = { command: string; args: readonly string[] }
class ManualTimers {
  private id = 0
  private pending = new Map<number, { callback: () => void; delay: number }>()
  set = (callback: () => void, delay: number) => { const id = ++this.id; this.pending.set(id, { callback, delay }); return id as unknown as Timer }
  clear = (timer: Timer) => this.pending.delete(timer as unknown as number)
  run(): void {
    const next = [...this.pending].sort((a, b) => a[1].delay - b[1].delay || a[0] - b[0])[0]
    assert.ok(next, "expected a pending timer")
    this.pending.delete(next[0])
    next[1].callback()
  }
}
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  signals: NodeJS.Signals[] = []
  constructor(readonly pid: number | undefined = 4242) { super() }
  kill(signal: NodeJS.Signals = "SIGTERM") { this.signals.push(signal); return true }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) { this.exitCode = code; this.signalCode = signal; this.emit("exit", code, signal) }
}
const result = (stdout = "", status = 0, stderr = ""): SpawnSyncReturns<string> =>
  ({ pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null })
const posix = (rows: Array<[number, number, number, string]>, boot = "boot-a") =>
  rows.map(([pid, ppid, pgid, start]) => `${pid}|${ppid}|${pgid}|${start}|${boot}|${start}`).join("\n")
const portable = (rows: Array<[number, number, number, string, string]>) =>
  rows.map(([pid, ppid, pgid, start, command]) => `${pid} ${ppid} ${pgid} ${start} ${command}`).join("\n")
const windows = (rows: Array<[number, number, string]>) =>
  rows.map(([pid, ppid, start], i) => `${pid}|${ppid}|0|${start}||${100 + i}`).join("\n")
const guarded = (matched: boolean, rows: Array<[number, number, number, string]>, boot = "boot-a") => [
  ...rows.map(([pid, ppid, pgid, start]) => `CODENOMAD_TARGET|${pid}|${ppid}|${pgid}|${start}|${boot}|${start}`),
  `CODENOMAD_RESULT|${matched ? "1" : "0"}|200|${rows.length ? "1" : "0"}`,
].join("\n")
const token = (rows: Array<[number, number, number, string]>, signal: boolean, boot = "boot-a") => [
  ...rows.map(([pid, ppid, pgid, start]) => `${signal ? "CODENOMAD_TARGET" : "CODENOMAD_PROCESS"}|${pid}|${ppid}|${pgid}|${start}|${boot}|${start}`),
  ...(signal ? [`CODENOMAD_RESULT|${rows.length ? "1" : "0"}`] : []),
].join("\n")
const isToken = (args: readonly string[]) => args.includes("codenomad-token-cleanup")
const isSignal = (args: readonly string[]) => isToken(args) && (args.includes("TERM") || args.includes("KILL"))
const isGuarded = (args: readonly string[]) => !isToken(args) && args.some((arg) => arg.includes("guarded-signal") || arg.includes("CODENOMAD_RESULT"))
async function harness(options: WorkspaceRuntimeOptions & {
  binary?: string
  output?: string
  report?: boolean
  persistProcessIdentities?: (identities: import("./process-identity").ProcessIdentity[]) => Promise<void>
} = {}) {
  const child = new FakeChild()
  const timers = new ManualTimers()
  const calls: Call[] = []
  const platform = options.platform ?? "linux"
  const command = options.spawnSync ?? ((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] })
    const alive = child.exitCode === null && child.signalCode === null
    if (isToken(args)) return result(token(alive ? [[4242, 1, 4242, "100"]] : [], isSignal(args)))
    if (isGuarded(args)) return result(platform === "win32"
      ? "CODENOMAD_TARGET|4242|1|0|win-start||100\nCODENOMAD_RESULT|1||1"
      : guarded(true, [[4242, 1, 4242, "100"]]))
    return result(platform === "win32"
      ? windows(alive ? [[4242, 1, "win-start"]] : [])
      : posix(alive ? [[4242, 1, 4242, "100"]] : [[1, 0, 1, "10"]]))
  }) as Command
  const runtime = new WorkspaceRuntime(new EventBus(), pino({ level: "silent" }), {
    platform, gracefulStopTimeoutMs: 10, forcedStopTimeoutMs: 10, ...options,
    spawnSync: command, setTimeout: timers.set, clearTimeout: timers.clear,
    spawn: (() => child as unknown as ChildProcess) as typeof import("node:child_process").spawn,
  })
  const abort = new AbortController()
  const folder = platform === "win32" && process.platform !== "win32" ? `/${process.cwd()}` : process.cwd()
  const launch = runtime.launch({
    workspaceId: "w", folder, binaryPath: options.binary ?? "opencode", signal: abort.signal,
    persistProcessIdentities: options.persistProcessIdentities,
  })
  if (options.report !== false) {
    queueMicrotask(() => child.stdout.write(options.output ?? "opencode server listening on http://127.0.0.1:4321\n"))
    await launch
  }
  return { runtime, child, timers, calls, launch, abort }
}
describe("workspace runtime lifecycle contracts", () => {
  it("captures the Linux launch group with one bounded shell command", async () => {
    let launchCall: Call | undefined
    await harness({ spawnSync: ((command: string, args: readonly string[]) => {
      launchCall ??= { command, args: [...args] }
      return result(posix([[4242, 1, 4242, "100"]]))
    }) as unknown as Command })
    assert.deepEqual(launchCall?.args.slice(-1), ["4242"])
  })

  it("persists a Windows wrapper and its launch descendants before publishing the port", async () => {
    let persisted: number[] = []
    await harness({
      platform: "win32",
      binary: "opencode.cmd",
      persistProcessIdentities: async (identities) => { persisted = identities.map(({ pid }) => pid) },
      spawnSync: ((command: string) => command === "powershell.exe"
        ? result(windows([[4242, 1, "wrapper-start"], [5000, 4242, "child-start"]]))
        : result()) as unknown as Command,
    })
    assert.deepEqual(persisted, [4242, 5000])
  })

  it("cancels before spawn and while waiting for a port without losing retryable cleanup", async () => {
    let spawned = false
    const runtime = new WorkspaceRuntime(new EventBus(), pino({ level: "silent" }), {
      spawn: (() => { spawned = true; return new FakeChild() as unknown as ChildProcess }) as typeof import("node:child_process").spawn,
    })
    const pre = new AbortController(); pre.abort(new Error("pre-cancelled"))
    await assert.rejects(runtime.launch({ workspaceId: "pre", folder: process.cwd(), binaryPath: "opencode", signal: pre.signal }), /pre-cancelled/)
    assert.equal(spawned, false)

    let alive = true
    const h = await harness({ report: false, spawnSync: ((_command: string, args: readonly string[]) => {
      if (isToken(args)) return result(token(alive ? [[4242, 1, 4242, "100"]] : [], isSignal(args)))
      if (isGuarded(args)) return result(guarded(true, [[4242, 1, 4242, "100"]]))
      return result(posix(alive ? [[4242, 1, 4242, "100"]] : [[1, 0, 1, "10"]]))
    }) as unknown as Command })
    h.abort.abort(new Error("port-cancelled"))
    await assert.rejects(h.launch, /port-cancelled/)
    const first = h.runtime.stop("w"); h.timers.run(); h.timers.run()
    await assert.rejects(first, WorkspaceStopTimeoutError)
    alive = false
    const retry = h.runtime.stop("w"); h.child.exit(); await retry

    const direct = await harness({ report: false })
    const stopped = direct.runtime.stop("w")
    await assert.rejects(direct.launch, /runtime launch was cancelled/)
    direct.child.exit()
    await stopped
  })
  it("rejects launches whose immutable identity cannot be captured and safely cleans up", async () => {
    for (const scenario of [{ platform: "linux" as const, binary: "opencode" }, { platform: "win32" as const, binary: "opencode.exe" }]) {
      const child = new FakeChild(scenario.platform === "linux" ? undefined : 4242)
      const runtime = new WorkspaceRuntime(new EventBus(), pino({ level: "silent" }), {
        platform: scenario.platform,
        spawn: (() => child as unknown as ChildProcess) as typeof import("node:child_process").spawn,
        spawnSync: (() => result("", 1, "identity unavailable")) as unknown as Command,
      })
      await assert.rejects(runtime.launch({ workspaceId: scenario.platform, folder: process.cwd(), binaryPath: scenario.binary }), WorkspaceRuntimeIdentityCaptureError)
      assert.deepEqual(child.signals, ["SIGTERM"])
      assert.doesNotThrow(() => child.emit("error", new Error("late spawn error")))
    }
  })
  it("signals identity-matched POSIX, Windows, and WSL processes", async () => {
    const scenarios = [
      { name: "POSIX", platform: "linux" as const, binary: "opencode", marker: "codenomad-guarded-signal" },
      { name: "Windows", platform: "win32" as const, binary: "opencode.exe", marker: "CODENOMAD_RESULT" },
      { name: "WSL", platform: "win32" as const, binary: "\\\\wsl$\\Ubuntu\\usr\\bin\\opencode", marker: "codenomad-wsl-guarded-signal",
        output: "__CODENOMAD_WSL_PID__:99:99:50:wsl-boot\nopencode server listening on http://127.0.0.1:4321\n" },
    ]
    for (const scenario of scenarios) {
      let alive = true
      const calls: Call[] = []
      const h = await harness({ platform: scenario.platform, binary: scenario.binary, output: scenario.output, spawnSync: ((command: string, args: readonly string[]) => {
        calls.push({ command, args: [...args] })
        const wsl = scenario.name === "WSL"
        if (wsl && command === "powershell.exe") return result(windows([[4242, 1, "host-start"]]))
        if (isToken(args)) { const rows: Array<[number, number, number, string]> = alive ? [[wsl ? 99 : 4242, 1, wsl ? 99 : 4242, wsl ? "50" : "100"]] : []; if (isSignal(args)) alive = false; return result(token(rows, isSignal(args), wsl ? "wsl-boot" : "boot-a")) }
        if (isGuarded(args)) { alive = false; return result(wsl ? guarded(true, [[99, 1, 99, "50"]], "wsl-boot") : scenario.platform === "win32" ? "CODENOMAD_TARGET|4242|1|0|win-start||100\nCODENOMAD_RESULT|1||1" : guarded(true, [[4242, 1, 4242, "100"]])) }
        return result(wsl
          ? posix(alive ? [[99, 1, 99, "50"]] : [[1, 0, 1, "10"]], "wsl-boot")
          : scenario.platform === "win32"
            ? windows(alive ? [[4242, 1, "win-start"]] : [[1, 0, "system-start"]])
            : posix(alive ? [[4242, 1, 4242, "100"]] : [[1, 0, 1, "10"]]))
      }) as unknown as Command })
      const stop = h.runtime.stop("w")
      h.child.exit()
      await stop
      assert.ok(calls.some(({ args }) => args.some((arg) => arg.includes(scenario.marker))), `${scenario.name} signal`)
      assert.equal(calls.some(({ command }) => command === "taskkill.exe"), false)
    }
  })
  it("does not signal a reused PID or process group", async () => {
    let launched = false
    const calls: string[][] = []
    const h = await harness({ spawnSync: ((_command: string, args: readonly string[]) => {
      calls.push([...args])
      if (isToken(args)) return result(token([], isSignal(args)))
      if (isGuarded(args)) return result(guarded(true, [[4242, 1, 4242, "100"]]))
      if (!launched) { launched = true; return result(posix([[4242, 1, 4242, "100"]])) }
      return result(posix([[4242, 1, 4242, "300"], [6000, 4242, 4242, "150"]]))
    }) as unknown as Command })
    await h.runtime.stop("w")
    assert.ok(calls.every((args) => !args.includes("6000") && !args.includes("300")))
  })
  it("retains and cleans a portable process group after its leader exits", async () => {
    const start = "Fri Jul 10 12:34:56 2026"
    let alive = true
    let leaderExited = false
    const guardedCalls: readonly string[][] = []
    const h = await harness({ platform: "darwin", spawnSync: ((_command: string, args: readonly string[]) => {
      if (isGuarded(args)) {
        (guardedCalls as string[][]).push([...args])
        alive = false
        return result(`CODENOMAD_TARGET_B64|5000|1|4242|${Buffer.from(start).toString("base64")}|${Buffer.from("opencode-child").toString("base64")}\nCODENOMAD_RESULT|1||1`)
      }
      const rows: Array<[number, number, number, string, string]> = !alive
        ? []
        : leaderExited
          ? [[5000, 4242, 4242, start, "opencode-child"]]
          : [[4242, 1, 4242, start, "opencode"]]
      return result(portable(rows))
    }) as unknown as Command })

    leaderExited = true
    h.child.exit(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(guardedCalls.length, 1)
    assert.equal(guardedCalls[0]?.[7], "1")
    assert.equal((h.runtime as unknown as { processes: Map<string, unknown> }).processes.size, 0)
  })
  it("refuses a leaderless portable group when no retained identity anchor remains", async () => {
    const start = "Fri Jul 10 12:34:56 2026"
    let leaderExited = false
    const guardedCalls: readonly string[][] = []
    const h = await harness({ platform: "darwin", spawnSync: ((_command: string, args: readonly string[]) => {
      if (isGuarded(args)) {
        (guardedCalls as string[][]).push([...args])
        return result("CODENOMAD_RESULT|0||0")
      }
      return result(portable(leaderExited
        ? [[6000, 1, 4242, "Fri Jul 10 99:99:99 2026", "unverified-process"]]
        : [[4242, 1, 4242, start, "opencode"]]))
    }) as unknown as Command })

    leaderExited = true
    h.child.exit(1)
    const cleanup = h.runtime.stop("w")
    h.timers.run(); h.timers.run()
    await assert.rejects(cleanup, (error: unknown) =>
      error instanceof WorkspaceStopTimeoutError && /no longer has a verified identity anchor/.test(error.message))
    assert.equal(guardedCalls.length, 2)
    assert.ok(guardedCalls.every((args) => args[7] === "1" && !args.includes("6000")))
    assert.equal((h.runtime as unknown as { processes: Map<string, unknown> }).processes.size, 1)
  })
  it("bounds direct Windows cleanup without falling back to taskkill", async () => {
    const calls: Call[] = []
    const h = await harness({ platform: "win32", binary: "opencode.exe", spawnSync: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] })
      return isGuarded(args) ? result("CODENOMAD_TARGET|4242|1|0|win-start||100\nCODENOMAD_RESULT|1||1") : result(windows([[4242, 1, "win-start"]]))
    }) as unknown as Command })
    const stop = h.runtime.stop("w"); h.timers.run(); h.timers.run()
    await assert.rejects(stop, WorkspaceStopTimeoutError)
    assert.equal(calls.some(({ command }) => command === "taskkill.exe"), false)
    assert.equal(calls.filter(({ args }) => isGuarded(args)).length, 2)
  })
  it("escalates wrapper cleanup, reports incomplete exited trees, and permits retry", async () => {
    let available = false
    const calls: Call[] = []
    const h = await harness({ platform: "win32", binary: "opencode.cmd", spawnSync: ((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] })
      if (command === "powershell.exe") return result(windows([[4242, 1, "wrapper-start"]]))
      return available ? result() : result("", 1, "taskkill unavailable")
    }) as unknown as Command })
    const first = h.runtime.stop("w"); h.timers.run(); h.timers.run()
    await assert.rejects(first, (error: unknown) => error instanceof WorkspaceStopTimeoutError && /\/T \/F failed/.test(error.message))
    assert.deepEqual(calls.filter(({ command }) => command === "taskkill.exe").map(({ args }) => args),
      [["/PID", "4242", "/T"], ["/PID", "4242", "/T", "/F"]])
    available = true
    const retry = h.runtime.stop("w"); h.child.exit(); await retry

    const exited = await harness({ platform: "win32", binary: "opencode.cmd", spawnSync: ((command: string) =>
      command === "powershell.exe" ? result(windows([[4242, 1, "wrapper-start"]])) : result("", 1, "taskkill unavailable")) as unknown as Command })
    const incomplete = exited.runtime.stop("w"); exited.child.exit(1)
    await assert.rejects(incomplete, WorkspaceWindowsTreeCleanupIncompleteError)
    await assert.rejects(exited.runtime.stop("w"), WorkspaceWindowsTreeCleanupIncompleteError)
  })
  it("shares one bounded stop operation across concurrent callers", async () => {
    const h = await harness()
    const first = h.runtime.stop("w"); const second = h.runtime.stop("w")
    assert.strictEqual(first, second)
    h.timers.run(); h.timers.run()
    const outcomes = await Promise.allSettled([first, second])
    assert.deepEqual(outcomes.map(({ status }) => status), ["rejected", "rejected"])
  })
})
