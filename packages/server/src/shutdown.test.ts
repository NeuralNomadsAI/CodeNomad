import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createServerShutdownHandler,
  orchestrateServerShutdown,
  ServerShutdownError,
  type ServerShutdownOperations,
} from "./shutdown"

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function operations(overrides: Partial<ServerShutdownOperations> = {}): ServerShutdownOperations {
  return {
    stopInstanceEventBridge: () => undefined,
    stopSidecars: () => undefined,
    stopClientConnections: () => undefined,
    stopWorkspaces: () => undefined,
    stopHttpServers: () => undefined,
    stopReleaseMonitor: () => undefined,
    ...overrides,
  }
}

describe("server shutdown orchestration", () => {
  it("retries workspace cleanup before reporting success", async () => {
    let attempts = 0
    await orchestrateServerShutdown(
      operations({
        stopWorkspaces: () => {
          attempts += 1
          if (attempts === 1) throw new Error("detached process still alive")
        },
      }),
      logger,
    )

    assert.equal(attempts, 2)
  })

  it("closes other resources and rejects with the concrete workspace failure", async () => {
    const closed: string[] = []
    const cleanupFailure = new Error("workspace abc POSIX process group is still alive")
    let attempts = 0

    await assert.rejects(
      orchestrateServerShutdown(
        operations({
          stopWorkspaces: () => {
            attempts += 1
            throw cleanupFailure
          },
          stopHttpServers: () => {
            closed.push("http")
          },
          stopReleaseMonitor: () => {
            closed.push("release-monitor")
          },
        }),
        logger,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ServerShutdownError)
        assert.equal(error.failures[0]?.resource, "Workspace manager")
        assert.strictEqual(error.failures[0]?.error, cleanupFailure)
        return true
      },
    )

    assert.equal(attempts, 2)
    assert.deepEqual(closed, ["http", "release-monitor"])
  })
})

describe("server shutdown signal boundary", () => {
  it("forces a nonzero exit after failed bounded cleanup returns", async () => {
    const calls: string[] = []
    const exits: number[] = []
    const handler = createServerShutdownHandler({
      shutdown: async () => {
        calls.push("cleanup")
        throw new Error("retained child survived")
      },
      logger: {
        info: () => calls.push("info"),
        warn: () => undefined,
        error: () => calls.push("error"),
      },
      forceExit: (code) => {
        calls.push("force-exit")
        exits.push(code)
      },
    })

    await handler("SIGTERM")

    assert.deepEqual(exits, [1])
    assert.deepEqual(calls, ["info", "cleanup", "error", "force-exit"])
  })

  it("escalates a second signal while shutdown is still pending", async () => {
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const exits: number[] = []
    const exitCodes: number[] = []
    const handler = createServerShutdownHandler({
      shutdown: () => cleanup,
      logger,
      forceExit: (code) => exits.push(code),
      setExitCode: (code) => exitCodes.push(code),
    })

    const first = handler("SIGINT")
    const second = handler("SIGTERM")
    assert.strictEqual(first, second)
    assert.deepEqual(exits, [1])

    finishCleanup()
    await first
    assert.deepEqual(exitCodes, [0])
  })
})
