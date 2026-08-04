import assert from "node:assert/strict"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { describe, it } from "node:test"
import { LAUNCH_CLEANUP_TOKEN_ENV, probeLaunchCleanupToken, signalLaunchCleanupToken } from "./process-identity"

type Spawn = typeof import("node:child_process").spawnSync
const result = (stdout: string): SpawnSyncReturns<string> => ({ pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null })
const b64 = (value: string) => Buffer.from(value).toString("base64")

describe("launch cleanup token adapter", () => {
  it("passes the exact token to the bounded Linux environ probe", () => {
    const token = "a".repeat(64), calls: any[] = []
    const run = ((command: string, args: string[], options: object) => { calls.push(command, args, options); return result("CODENOMAD_PROCESS|5000|1|4242|150|boot-a|150\n") }) as unknown as Spawn
    const probe = probeLaunchCleanupToken(run, token, 25)
    assert.equal(probe.ok && probe.processes.get(5000)?.startOrder, "150")
    assert.equal(calls[0], "sh")
    assert.deepEqual([calls[2].timeout, calls[1].includes(LAUNCH_CLEANUP_TOKEN_ENV), calls[1].includes(token)], [25, true, true])
    assert.match(calls[1][1], /\/proc\/\$1\/environ/)
    assert.doesNotMatch(calls[1][1], /\bseq\b/)
  })

  it("executes a successful empty Linux token probe", { skip: process.platform !== "linux" }, () => {
    const probe = probeLaunchCleanupToken(spawnSync, "f".repeat(64), 1_000)
    assert.deepEqual(probe, { ok: true, processes: new Map() })
  })

  it("signals every exact-token target and rejects malformed records", () => {
    const rows = "CODENOMAD_TARGET|4242|1|4242|100|boot-a|100\nCODENOMAD_TARGET|5000|1|4242|150|boot-a|150\nCODENOMAD_RESULT|1\n"
    const run = ((() => result(rows)) as unknown) as Spawn
    const cleanup = signalLaunchCleanupToken(run, "b".repeat(64), "SIGKILL", 25)
    assert.deepEqual([cleanup.ok, cleanup.targets.map(({ pid }) => pid)], [true, [4242, 5000]])
    const malformed = ((() => result("5000|1|4242|150|boot-a|150|truncated\n")) as unknown) as Spawn
    assert.equal(probeLaunchCleanupToken(malformed, "c".repeat(64), 25).ok, false)
  })

  it("probes and signals escaped cleanup-token processes with portable POSIX ps", () => {
    const token = "d".repeat(64)
    const processRow = `CODENOMAD_PROCESS_B64|5000|1|9000|${b64("Tue Aug  4 12:00:00 2026")}|${b64("git helper")}\n`
    const probeCalls: any[] = []
    const probeRun = ((command: string, args: string[], options: object) => {
      probeCalls.push(command, args, options)
      return result(processRow)
    }) as unknown as Spawn
    const probe = probeLaunchCleanupToken(probeRun, token, 25, undefined, "darwin")
    assert.equal(probe.ok && probe.processes.get(5000)?.groupId, 9000)
    assert.equal(probeCalls[0], "sh")
    assert.match(probeCalls[1][1], /ps -axo pid=/)
    assert.match(probeCalls[1][1], /ps eww -p/)
    assert.equal(probeCalls[1].includes(token), true)

    const targetRow = processRow.replace("CODENOMAD_PROCESS_B64", "CODENOMAD_TARGET_B64")
    const cleanup = signalLaunchCleanupToken(
      ((() => result(`${targetRow}CODENOMAD_RESULT|1\n`)) as unknown) as Spawn,
      token, "SIGKILL", 25, undefined, "darwin",
    )
    assert.deepEqual([cleanup.ok, cleanup.signalSent, cleanup.targets[0]?.pid], [true, true, 5000])
  })

  it("uses a bounded PowerShell probe instead of POSIX sh on Windows", () => {
    const calls: any[] = []
    const run = ((command: string, args: string[], options: object) => {
      calls.push(command, args, options)
      return result("CODENOMAD_INCONCLUSIVE\n")
    }) as unknown as Spawn
    const token = "e".repeat(64)
    const probe = probeLaunchCleanupToken(run, token, 25, undefined, "win32")
    assert.equal(probe.ok, false)
    assert.equal(calls[0], "powershell.exe")
    assert.equal(calls[1].includes("sh"), false)
    assert.match(calls[1].at(-1), /Get-CimInstance Win32_Process/)
    assert.deepEqual([calls[2].timeout, calls[2].input], [25, token])

    const matched = probeLaunchCleanupToken(
      ((() => result("CODENOMAD_PROCESS|4242|1|0|638899200000000000||638899200000000000\n")) as unknown) as Spawn,
      token, 25, undefined, "win32",
    )
    assert.equal(matched.ok && matched.processes.get(4242)?.startTime, "638899200000000000")
  })
})
