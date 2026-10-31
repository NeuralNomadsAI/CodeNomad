import assert from "node:assert/strict"
import test from "node:test"
import { acknowledgeLaunchConnection, type ConnectLaunchHost } from "./connect-launch"
import { LocalWindowRegistry, type LocalWindowRecord } from "./local-window-registry"

const launchId = "11111111-1111-4111-8111-111111111111"
const restoredId = "22222222-2222-4222-8222-222222222222"

function fakeRecord(id: string, contentsId: number, connectOnly = false): LocalWindowRecord & { calls: string[] } {
  const calls: string[] = []
  const webContents = { id: contentsId, isDestroyed: () => false, send: (channel: string) => calls.push(channel) }
  const window = { webContents, isDestroyed: () => false, isMinimized: () => false, show: () => {}, focus: () => {}, restore: () => {} }
  return { id, persisted: !connectOnly, connectOnly, window: window as never, navigation: {} as never, tracker: null, loading: false, backendUrl: null, pendingFolders: [], calls }
}

function harness() {
  const registry = new LocalWindowRegistry(() => {})
  const launch = fakeRecord(launchId, 1, true)
  registry.add(launch)
  const closed: string[] = []
  let restores = 0
  const host: ConnectLaunchHost = {
    acknowledgeConnection: (id, target) => registry.acknowledgeConnection(id, target),
    queueConnection: (id, connection) => registry.queueConnection(id, connection),
    restoreNormalStart: async () => {
      restores++
      const restored = fakeRecord(restoredId, 2)
      registry.add(restored)
      return restored
    },
    close: (record) => closed.push(record.id),
  }
  return { registry, launch, host, closed, restores: () => restores }
}

test("a connect-only window defers failures and closes once its connection succeeds", async () => {
  const { registry, host, closed, restores } = harness()
  registry.queueConnection(launchId, { target: "prod" })
  assert.deepEqual(registry.nextConnection(launchId), { target: "prod", deferFailure: true })
  await acknowledgeLaunchConnection(host, launchId, "prod", null)
  assert.deepEqual(closed, [launchId])
  assert.equal(restores(), 0, "a successful connection leaves only the remote window")
})

test("a failed connection starts normally and shows the failure there, with any queued connection", async () => {
  const { registry, host, closed, restores } = harness()
  registry.queueConnection(launchId, { target: "missing" })
  registry.queueConnection(launchId, { target: "https://later.example.com" })
  await acknowledgeLaunchConnection(host, launchId, "missing", "No saved server is named \"missing\".")
  assert.equal(restores(), 1)
  assert.deepEqual(closed, [launchId])
  assert.equal(registry.nextConnection(launchId), null)
  assert.deepEqual(registry.nextConnection(restoredId), { target: "missing", failure: "No saved server is named \"missing\".", deferFailure: false })
  await acknowledgeLaunchConnection(host, restoredId, "missing", null)
  assert.deepEqual(registry.nextConnection(restoredId), { target: "https://later.example.com", deferFailure: false })
  await acknowledgeLaunchConnection(host, restoredId, "https://later.example.com", "unreachable")
  assert.equal(restores(), 1, "an ordinary window reports its own failures and stays open")
  assert.deepEqual(closed, [launchId])
})

test("a connect-only window stays open while connections remain and refuses out-of-order acknowledgements", async () => {
  const { registry, host, closed } = harness()
  registry.queueConnection(launchId, { target: "one" })
  registry.queueConnection(launchId, { target: "two" })
  await assert.rejects(acknowledgeLaunchConnection(host, launchId, "two", null), /out of order/)
  await acknowledgeLaunchConnection(host, launchId, "one", null)
  assert.deepEqual(closed, [])
  await acknowledgeLaunchConnection(host, launchId, "two", null)
  assert.deepEqual(closed, [launchId])
})

test("queued connections wake the renderer", () => {
  const { registry, launch } = harness()
  registry.queueConnection(launchId, { target: "prod" })
  assert.deepEqual(launch.calls, ["window:connections-pending"])
})
