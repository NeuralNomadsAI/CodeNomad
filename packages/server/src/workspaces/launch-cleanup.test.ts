import assert from "node:assert/strict"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { describe, it } from "node:test"
import { LAUNCH_CLEANUP_TOKEN_ENV, probeLaunchCleanupToken, signalLaunchCleanupToken } from "./process-identity"

type Spawn = typeof import("node:child_process").spawnSync
const result = (stdout: string): SpawnSyncReturns<string> => ({ pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null })

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
})
