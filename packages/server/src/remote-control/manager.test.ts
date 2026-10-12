import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { OpenRemoteTunnelOptions, RemoteTunnel } from "@codenomad/remote-tunnel"
import { createLogger } from "../logger"
import { RemoteDeviceRegistry } from "./devices"
import { RemoteControlManager } from "./manager"

const logger = createLogger({ level: "silent" } as never)

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-manager-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "remote-control-devices.json")
  const opened: OpenRemoteTunnelOptions[] = []
  let failure: Error | null = null
  const managers: RemoteControlManager[] = []
  t.after(() => Promise.all(managers.map((manager) => manager.shutdown())))
  // Each launch is a new manager over the same registry file, as after a restart.
  const launch = () => {
    const manager = new RemoteControlManager({
      registry: new RemoteDeviceRegistry(file),
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
    return manager
  }
  return { file, opened, launch, fail: (error: Error | null) => { failure = error } }
}

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
  await launch().start()

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
