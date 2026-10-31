import assert from "node:assert/strict"
import test from "node:test"
import { abandonLaunchWindow, acknowledgeLaunchConnection, type ConnectLaunchHost } from "./connect-launch"
import { LocalWindowRegistry, MAX_LOCAL_WINDOWS, type LocalWindowRecord } from "./local-window-registry"
import { loadNewRemoteWindow } from "./remote-window-registry"

const launchId = "11111111-1111-4111-8111-111111111111"
const userId = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`

let contents = 0
function fakeRecord(id: string, connectOnly = false): LocalWindowRecord & { calls: string[] } {
  const calls: string[] = []
  const webContents = { id: ++contents, isDestroyed: () => false, send: (channel: string) => calls.push(channel) }
  const window = { webContents, isDestroyed: () => false, isMinimized: () => false, show: () => calls.push("show"), focus: () => {}, restore: () => {} }
  return { id, persisted: !connectOnly, ...(connectOnly ? { connectOnly } : {}), window: window as never, navigation: {} as never, tracker: null, loading: false, backendUrl: null, pendingFolders: [], calls }
}

function harness(savedWindows = 1, restore?: () => Promise<{ id: string }>) {
  const registry = new LocalWindowRegistry(() => {})
  const launch = fakeRecord(launchId, true)
  registry.add(launch)
  const closed: string[] = []
  let restores = 0
  const host: ConnectLaunchHost = {
    registry,
    restoreNormalStart: restore ?? (async () => {
      restores++
      // The normal start of main.ts: every saved window, then the active one.
      for (let index = 0; index < savedWindows; index++) registry.add(fakeRecord(userId(index)))
      return registry.focus(userId(0))!
    }),
    close: (record) => closed.push(record.id),
    show: (record) => { registry.focus(record.id) },
  }
  return { registry, launch, host, closed, restores: () => restores }
}

test("a hidden launch window connects without prompting and closes once the remote window opened", async () => {
  const { registry, launch, host, closed, restores } = harness()
  registry.queueConnection(launchId, { target: "prod" })
  assert.deepEqual(registry.nextConnection(launchId), { target: "prod", hidden: true })
  await acknowledgeLaunchConnection(host, launchId, "prod", null, false)
  assert.deepEqual(closed, [launchId])
  assert.equal(restores(), 0, "a successful connection leaves only the remote window")
  assert.equal(launch.calls.includes("show"), false, "the launch window is never shown")
})

test("a failed connection starts normally and shows the failure there, with any queued connection", async () => {
  const { registry, host, closed, restores } = harness()
  registry.queueConnection(launchId, { target: "missing" })
  registry.queueConnection(launchId, { target: "https://later.example.com" })
  await acknowledgeLaunchConnection(host, launchId, "missing", "No saved server is named \"missing\".", false)
  assert.equal(restores(), 1)
  assert.deepEqual(closed, [launchId])
  assert.deepEqual(registry.nextConnection(userId(0)), { target: "missing", failure: "No saved server is named \"missing\".", hidden: false })
  await acknowledgeLaunchConnection(host, userId(0), "missing", null, false)
  assert.deepEqual(registry.nextConnection(userId(0)), { target: "https://later.example.com", hidden: false })
  await acknowledgeLaunchConnection(host, userId(0), "https://later.example.com", "unreachable", false)
  assert.equal(restores(), 1, "an ordinary window reports its own failures and stays open")
  assert.deepEqual(closed, [launchId])
})

test("a connection that needs a prompt is handed to a visible window to run there", async () => {
  const { registry, host, closed } = harness()
  registry.queueConnection(launchId, { target: "self-signed" })
  await acknowledgeLaunchConnection(host, launchId, "self-signed", null, true)
  assert.deepEqual(closed, [launchId])
  assert.deepEqual(registry.nextConnection(userId(0)), { target: "self-signed", hidden: false })
})

test("a backend failure or timeout hands every pending connection to a normal start", async () => {
  const { registry, host, closed } = harness()
  registry.queueConnection(launchId, { target: "one" })
  registry.queueConnection(launchId, { target: "two" })
  await abandonLaunchWindow(host, launchId)
  assert.deepEqual(closed, [launchId])
  assert.equal(registry.nextConnection(launchId), null)
  assert.deepEqual(registry.nextConnection(userId(0)), { target: "one", hidden: false })
  await abandonLaunchWindow(host, launchId)
  assert.deepEqual(closed, [launchId], "a settled launch window is abandoned only once")
})

test("ordinary launches never land in the hidden launch window", () => {
  const { registry, launch } = harness()
  registry.queueConnection(launchId, { target: "prod" })
  // handleIntent sends folders to focusMru() ?? ensureLocalWindow(): neither may resolve to the helper.
  assert.equal(registry.mruRecord(), undefined)
  assert.equal(registry.focusMru(), undefined)
  assert.equal(registry.focus(launchId), undefined)
  registry.markFocused(launchId)
  assert.equal(registry.mruRecord(), undefined)
  assert.equal(launch.calls.includes("show"), false)
  const local = fakeRecord(userId(0))
  registry.add(local)
  registry.markFocused(launchId)
  assert.equal(registry.mruRecord()?.id, userId(0))
})

test("a failed launch restores all sixteen saved windows beside the hidden one", async () => {
  const { registry, host, closed } = harness(MAX_LOCAL_WINDOWS)
  registry.queueConnection(launchId, { target: "down" })
  await acknowledgeLaunchConnection(host, launchId, "down", "unreachable", false)
  assert.equal(registry.all().filter((record) => !record.connectOnly).length, MAX_LOCAL_WINDOWS)
  assert.deepEqual(closed, [launchId])
  assert.equal(registry.nextConnection(userId(0))?.failure, "unreachable")
  assert.throws(() => registry.add(fakeRecord(userId(99))), /Too many local windows/)
})

test("when the normal start itself fails, the launch window becomes visible and reports there", async () => {
  const { registry, launch, host, closed } = harness(1, async () => { throw new Error("cannot restore") })
  registry.queueConnection(launchId, { target: "down" })
  await acknowledgeLaunchConnection(host, launchId, "down", "unreachable", false)
  assert.deepEqual(closed, [])
  assert.equal(launch.connectOnly, false)
  assert.equal(launch.calls.includes("show"), true)
  assert.deepEqual(registry.nextConnection(launchId), { target: "down", failure: "unreachable", hidden: false })
})

test("acknowledgements out of order are refused and the window stays open while connections remain", async () => {
  const { registry, host, closed } = harness()
  registry.queueConnection(launchId, { target: "one" })
  registry.queueConnection(launchId, { target: "two" })
  await assert.rejects(acknowledgeLaunchConnection(host, launchId, "two", null, false), /out of order/)
  await acknowledgeLaunchConnection(host, launchId, "one", null, false)
  assert.deepEqual(closed, [])
  await acknowledgeLaunchConnection(host, launchId, "two", null, false)
  assert.deepEqual(closed, [launchId])
})

test("a launch connection fails when the remote page does not load, instead of showing the loading screen", async () => {
  const calls: string[] = []
  const window = { isDestroyed: () => calls.includes("destroy"), destroy: () => { calls.push("destroy") } }
  const failing = async () => { throw new Error("ERR_EMPTY_RESPONSE") }
  const loading = async () => { calls.push("loading") }
  await assert.rejects(loadNewRemoteWindow(window, failing, loading, true), /ERR_EMPTY_RESPONSE/)
  assert.deepEqual(calls, ["destroy"])
  calls.length = 0
  await loadNewRemoteWindow(window, failing, loading, false)
  assert.deepEqual(calls, ["loading"], "the Connect button keeps its loading screen")
  calls.length = 0
  await loadNewRemoteWindow(window, async () => {}, loading, true)
  assert.deepEqual(calls, [])
})

test("queued connections wake the renderer", () => {
  const { registry, launch } = harness()
  registry.queueConnection(launchId, { target: "prod" })
  assert.deepEqual(launch.calls, ["window:connections-pending"])
})
