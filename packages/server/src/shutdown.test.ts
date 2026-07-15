import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createServerShutdownHandler, orchestrateServerShutdown, type ServerShutdownOperations } from "./shutdown"

const logger = { info() {}, warn() {}, error() {} }
const operations = (overrides: Partial<ServerShutdownOperations> = {}): ServerShutdownOperations => ({
  stopInstanceEventBridge() {}, stopSidecars() {}, stopClientConnections() {},
  stopRemoteProxySessions() {}, stopWorkspaces() {}, stopHttpServers() {}, stopReleaseMonitor() {},
  ...overrides,
})

describe("server shutdown orchestration", () => {
  it("retries workspace cleanup and preserves shutdown order", async () => {
    const calls: string[] = []
    let attempts = 0
    await orchestrateServerShutdown(operations({
      stopRemoteProxySessions: () => { calls.push("remote-proxy") },
      stopWorkspaces: () => { calls.push(`workspaces-${++attempts}`); if (attempts === 1) throw new Error("still alive") },
      stopHttpServers: () => { calls.push("http") },
    }), logger)
    assert.deepEqual(calls, ["remote-proxy", "workspaces-1", "workspaces-2", "http"])
  })

  it("closes remaining resources and aggregates the concrete current error", async () => {
    const failure = new Error("workspace abc POSIX process group is still alive")
    const closed: string[] = []
    let attempts = 0
    await assert.rejects(orchestrateServerShutdown(operations({
      stopWorkspaces: () => { attempts++; throw failure },
      stopHttpServers: () => { closed.push("http") },
      stopReleaseMonitor: () => { closed.push("release-monitor") },
    }), logger), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 1)
      assert.match(error.errors[0].message, /^stopWorkspaces failed:/)
      assert.strictEqual(error.errors[0].cause, failure)
      return true
    })
    assert.deepEqual([attempts, closed], [2, ["http", "release-monitor"]])
  })
})

describe("server shutdown signal boundary", () => {
  it("forces a nonzero exit when first-signal cleanup fails", async () => {
    const calls: string[] = []
    const exits: number[] = []
    const handler = createServerShutdownHandler({
      shutdown: async () => { calls.push("cleanup"); throw new Error("retained child survived") },
      logger: { info: () => calls.push("info"), warn() {}, error: () => calls.push("error") },
      forceExit: (code) => { calls.push("force-exit"); exits.push(code) },
    })
    await handler("SIGTERM")
    assert.deepEqual([exits, calls], [[1], ["info", "cleanup", "error", "force-exit"]])
  })

  it("escalates a second signal while sharing first-signal cleanup", async () => {
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => { finish = resolve })
    const exits: number[] = [], exitCodes: number[] = []
    const handler = createServerShutdownHandler({ shutdown: () => cleanup, logger,
      forceExit: (code) => exits.push(code), setExitCode: (code) => exitCodes.push(code) })
    const first = handler("SIGINT"), second = handler("SIGTERM")
    assert.strictEqual(first, second)
    assert.deepEqual(exits, [1])
    finish(); await first
    assert.deepEqual(exitCodes, [0])
  })
})
