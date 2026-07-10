import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { installShutdownSignalHandlers } from "./index"
import { createServerShutdownHandler } from "./shutdown"

describe("CLI shutdown signal registration", () => {
  it("routes a second process signal to forced nonzero escalation", async () => {
    const listeners = new Map<string, () => void>()
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const exits: number[] = []
    const shutdown = createServerShutdownHandler({
      shutdown: () => cleanup,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      forceExit: (code) => exits.push(code),
      setExitCode: () => undefined,
    })

    installShutdownSignalHandlers(
      {
        on: (signal, listener) => listeners.set(signal, listener),
      },
      shutdown,
    )

    listeners.get("SIGINT")?.()
    listeners.get("SIGTERM")?.()
    assert.deepEqual(exits, [1])

    finishCleanup()
    await cleanup
  })
})
