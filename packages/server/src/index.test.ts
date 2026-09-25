import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { describe, it } from "node:test"

import { installShutdownSignalHandlers, installShutdownStdinHandler, resolveHost, STDIN_SHUTDOWN_COMMAND } from "./index"
import { createServerShutdownHandler } from "./shutdown"

describe("CLI shutdown signal registration", () => {
  it("routes a second process signal to forced nonzero escalation", async () => {
    const listeners = new Map<string, () => void>()
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const exits: number[] = []
    let handled: Promise<void> | undefined
    const shutdown = createServerShutdownHandler({
      shutdown: () => cleanup,
      logger: { info() {}, warn() {}, error() {} },
      forceExit: (code) => exits.push(code),
      setExitCode: () => undefined,
      reportStatus: () => undefined,
    })
    installShutdownSignalHandlers(
      { on: (signal, listener) => listeners.set(signal, listener) },
      (signal) => (handled = shutdown(signal)),
    )

    listeners.get("SIGINT")?.()
    listeners.get("SIGTERM")?.()
    assert.deepEqual(exits, [1])

    finishCleanup()
    await handled
  })

  it("coalesces chunked and repeated stdin shutdown commands through the same handler", async () => {
    const listeners = new Map<string, (chunk: Buffer | string) => void>()
    const triggers: string[] = []
    let destroys = 0
    const source = {
      on: (event: "data", listener: (chunk: Buffer | string) => void) => listeners.set(event, listener),
      off: (event: "data", listener: (chunk: Buffer | string) => void) => {
        if (listeners.get(event) === listener) listeners.delete(event)
      },
      destroy: () => { destroys++ },
    }
    installShutdownStdinHandler(source, async (trigger) => { triggers.push(trigger) })

    const listener = listeners.get("data")!
    listener(STDIN_SHUTDOWN_COMMAND.slice(0, 8))
    listener(`${STDIN_SHUTDOWN_COMMAND.slice(8)}\n${STDIN_SHUTDOWN_COMMAND}\n`)
    listener(`${STDIN_SHUTDOWN_COMMAND}\n`)
    await Promise.resolve()

    assert.deepEqual(triggers, ["stdin"])
    assert.equal(destroys, 1)
    assert.equal(listeners.has("data"), false)
  })

  it("allows a real piped process to exit naturally after the shutdown command", { timeout: 5_000 }, async () => {
    const moduleUrl = new URL("./index.ts", import.meta.url).href
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { installShutdownStdinHandler } from ${JSON.stringify(moduleUrl)}
      installShutdownStdinHandler(process.stdin, async () => { process.exitCode = 0 })
    `], { stdio: ["pipe", "ignore", "inherit"] })

    child.stdin.end(`${STDIN_SHUTDOWN_COMMAND}\n`)
    const [code] = await once(child, "exit")
    assert.equal(code, 0)
  })
})

describe("CLI host normalization", () => {
  it("normalizes mapped and internationalized hosts and rejects IPv6 zones", () => {
    assert.equal(resolveHost("::ffff:0:0"), "0.0.0.0")
    assert.equal(resolveHost("::ffff:7f00:1"), "127.0.0.1")
    assert.equal(resolveHost("münchen.local"), "xn--mnchen-3ya.local")
    assert.throws(() => resolveHost("fe80::1%12"), /IPv6 zone identifiers/)
  })
})
