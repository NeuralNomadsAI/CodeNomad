import assert from "node:assert/strict"
import type { SpawnSyncReturns } from "node:child_process"
import { describe, it } from "node:test"

import {
  LAUNCH_CLEANUP_TOKEN_ENV,
  probeLaunchCleanupToken,
  signalLaunchCleanupToken,
} from "./launch-cleanup"

type SpawnCommand = typeof import("node:child_process").spawnSync

function result(stdout = "", status = 0, stderr = ""): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null }
}

describe("launch cleanup token adapter", () => {
  it("passes the exact token to a bounded Linux environ probe", () => {
    const token = "a".repeat(64)
    let invocation: { command: string; args: readonly string[]; timeout?: number } | undefined
    const probe = probeLaunchCleanupToken(((command: string, args: readonly string[], options: { timeout?: number }) => {
      invocation = { command, args, timeout: options.timeout }
      return result("5000|1|4242|150|boot-a|150\n")
    }) as unknown as SpawnCommand, token, 25)

    assert.equal(probe.ok && probe.processes.get(5000)?.startOrder, "150")
    assert.equal(invocation?.command, "sh")
    assert.equal(invocation?.timeout, 25)
    assert.ok(invocation?.args.includes(LAUNCH_CLEANUP_TOKEN_ENV))
    assert.ok(invocation?.args.includes(token))
    assert.match(invocation?.args[1] ?? "", /\/proc\/\$1\/environ/)
  })

  it("signals every exact-token target returned by the bounded adapter", () => {
    const cleanup = signalLaunchCleanupToken((() => result(
      "CODENOMAD_TARGET|4242|1|4242|100|boot-a|100\n" +
      "CODENOMAD_TARGET|5000|1|4242|150|boot-a|150\n" +
      "CODENOMAD_RESULT|1\n",
    )) as unknown as SpawnCommand, "b".repeat(64), "SIGKILL", 25)

    assert.equal(cleanup.ok, true)
    assert.deepEqual(cleanup.targets.map((target) => target.pid), [4242, 5000])
  })

  it("rejects malformed cleanup records conservatively", () => {
    const probe = probeLaunchCleanupToken((() => result("5000|1|4242|150|boot-a|150|truncated\n")) as unknown as SpawnCommand, "c".repeat(64), 25)

    assert.equal(probe.ok, false)
  })
})
