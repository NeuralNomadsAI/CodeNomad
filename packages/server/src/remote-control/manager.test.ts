import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { OpenRemoteTunnelOptions, RemoteTunnel } from "@codenomad/remote-tunnel"
import { createLogger } from "../logger"
import { RemoteDeviceRegistry } from "./devices"
import { RemoteControlManager } from "./manager"
import { RemoteControlOwnerLease } from "./owner-lease"

const logger = createLogger({ level: "silent" } as never)

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-manager-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "remote-control-devices.json")
  const opened: OpenRemoteTunnelOptions[] = []
  let failure: Error | null = null
  const managers: RemoteControlManager[] = []
  t.after(() => Promise.all(managers.map((manager) => manager.shutdown())))
  // Backend PIDs still running; each launch gets its own.
  const alive = new Set<number>()
  let nextPid = 100
  // Each launch is a new manager over the same config directory, as after a restart.
  const launch = () => {
    const pid = nextPid++
    alive.add(pid)
    const manager = new RemoteControlManager({
      registry: new RemoteDeviceRegistry(file),
      lease: new RemoteControlOwnerLease(path.join(directory, "remote-control.owner"), pid, (candidate) => alive.has(candidate)),
      router: () => null,
      logger,
      openTunnel: async (options) => {
        opened.push(options)
        if (failure) throw failure
        return {
          url: "https://codenomad-test.device.tunnel.test",
          hostname: "codenomad-test.device.tunnel.test",
          status: () => ({ state: "connected", connections: 0 }),
          closed: new Promise<string | undefined>(() => undefined),
          close: async () => undefined,
        } satisfies RemoteTunnel
      },
    })
    managers.push(manager)
    return Object.assign(manager, { exit: () => alive.delete(pid) })
  }
  return { file, opened, launch, fail: (error: Error | null) => { failure = error } }
}

test("only one backend sharing the configuration resumes, until it goes away", async (t) => {
  const { opened, launch } = fixture(t)
  const first = launch()
  await first.start()
  await first.shutdown()
  first.exit()

  const app = launch()
  await app.resume()
  const second = launch()
  await second.resume()
  assert.equal(opened.length, 2)
  assert.deepEqual({ enabled: second.status().enabled, state: second.status().state }, { enabled: false, state: "stopped" })

  // A crashed owner leaves its lease behind; the next launch replaces it.
  app.exit()
  const next = launch()
  await next.resume()
  assert.equal(opened.length, 3)
  assert.equal(next.status().state, "connected")
})

test("a started Remote Control reconnects at the next launch without a pairing link", async (t) => {
  const { opened, launch } = fixture(t)
  const first = launch()
  await first.start()
  await first.shutdown()

  const next = launch()
  await next.resume()
  assert.equal(opened.length, 2)
  assert.deepEqual(
    { enabled: next.status().enabled, state: next.status().state, startsOnLaunch: next.status().startsOnLaunch },
    { enabled: true, state: "connected", startsOnLaunch: true },
  )
  assert.equal(next.exchangePairing("guess", undefined), null)
})

test("only an explicit Stop prevents the next launch from reconnecting", async (t) => {
  const { opened, launch } = fixture(t)
  const first = launch()
  await first.start()
  await first.stop()

  const next = launch()
  await next.resume()
  assert.equal(opened.length, 1)
  assert.equal(next.status().state, "stopped")
  assert.equal(next.status().startsOnLaunch, false)
})

test("an installation that never started writes nothing and does not connect at launch", async (t) => {
  const { file, opened, launch } = fixture(t)
  await launch().resume()
  assert.equal(opened.length, 0)
  assert.equal(fs.existsSync(file), false)
})

test("a failed launch keeps the choice, reports the error and retries next time", async (t) => {
  const { opened, launch, fail } = fixture(t)
  const first = launch()
  await first.start()
  await first.shutdown()
  first.exit()

  fail(new Error("relay unavailable"))
  const failed = launch()
  await failed.resume()
  assert.deepEqual(
    { enabled: failed.status().enabled, state: failed.status().state, error: failed.status().error, startsOnLaunch: failed.status().startsOnLaunch },
    { enabled: false, state: "error", error: "relay unavailable", startsOnLaunch: true },
  )

  fail(null)
  const recovered = launch()
  await recovered.resume()
  assert.equal(opened.length, 3)
  assert.equal(recovered.status().state, "connected")
})

// Like OpenTunnel, the fake closes its connection whenever the start signal aborts.
function tunnelBoundTo(signal: AbortSignal | undefined): RemoteTunnel {
  const closed = new Promise<string | undefined>((resolve) => signal?.addEventListener("abort", () => resolve(undefined), { once: true }))
  return {
    url: "https://codenomad-test.device.tunnel.test",
    hostname: "codenomad-test.device.tunnel.test",
    status: () => ({ state: "connected", connections: 0 }),
    closed,
    close: async () => undefined,
  }
}

function deadlineManager(t: test.TestContext, openTunnel: (options: OpenRemoteTunnelOptions) => Promise<RemoteTunnel>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-deadline-"))
  const manager = new RemoteControlManager({
    registry: new RemoteDeviceRegistry(path.join(directory, "remote-control-devices.json")),
    router: () => null, logger, openTunnel, startTimeoutMs: 20,
  })
  t.after(async () => { await manager.shutdown(); fs.rmSync(directory, { recursive: true, force: true }) })
  return manager
}

test("the start deadline never closes a tunnel that already connected", async (t) => {
  let signal: AbortSignal | undefined
  const manager = deadlineManager(t, async (options) => {
    signal = options.signal
    return tunnelBoundTo(options.signal)
  })
  await manager.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(signal?.aborted, false)
  assert.deepEqual({ enabled: manager.status().enabled, state: manager.status().state }, { enabled: true, state: "connected" })
})

test("a start that does not connect before its deadline is abandoned with an error", async (t) => {
  const manager = deadlineManager(t, (options) => new Promise<RemoteTunnel>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true })
  }))
  await assert.rejects(manager.start(), /start timed out/)
  assert.deepEqual({ enabled: manager.status().enabled, state: manager.status().state }, { enabled: false, state: "error" })
})