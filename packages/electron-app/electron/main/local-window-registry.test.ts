import assert from "node:assert/strict"
import test from "node:test"
import { LocalWindowRegistry } from "./local-window-registry"

const id1 = "11111111-1111-4111-8111-111111111111"
const id2 = "22222222-2222-4222-8222-222222222222"

function fakeWindow(contentsId: number) {
  const calls: string[] = []
  const webContents = { id: contentsId, isDestroyed: () => false, send: (channel: string) => calls.push(channel) }
  return { calls, webContents, isDestroyed: () => false, isMinimized: () => false, show: () => calls.push("show"), focus: () => calls.push("focus"), restore: () => calls.push("restore") }
}

test("registry resolves independent webContents, tracks MRU, queues folders, and fans out backend events", () => {
  const active: string[] = []
  const registry = new LocalWindowRegistry((id) => { active.push(id) })
  const first = fakeWindow(1)
  const second = fakeWindow(2)
  registry.add({ id: id1.toUpperCase(), persisted: true, window: first as never, navigation: {} as never, tracker: null, loading: true, backendUrl: null, pendingFolders: [] })
  registry.add({ id: id2, persisted: true, window: second as never, navigation: {} as never, tracker: null, loading: true, backendUrl: null, pendingFolders: [] })
  assert.equal(registry.resolve(first.webContents as never)?.id, id1)
  assert.equal(registry.focusMru()?.id, id2)
  registry.focus(id1)
  assert.equal(registry.focusMru()?.id, id1)
  assert.deepEqual(active, [id2, id1, id1])
  registry.queueFolder(id2, "/two")
  registry.queueFolder(id2, "/three")
  assert.equal(registry.nextFolder(id2), "/two")
  registry.acknowledgeFolder(id2, "/two", false)
  assert.equal(registry.nextFolder(id2), "/three")
  assert.throws(() => registry.acknowledgeFolder(id2, "/wrong", true), /out of order/)
  registry.acknowledgeFolder(id2, "/three", true)
  assert.equal(registry.nextFolder(id2), "/two")
  registry.acknowledgeFolder(id2, "/two", false)
  registry.acknowledgeFolder(id2, "/two", false)
  assert.equal(registry.nextFolder(id2), null)
  registry.fanout("cli:ready", {})
  assert.equal(first.calls.includes("cli:ready"), true)
  assert.equal(second.calls.includes("cli:ready"), true)
  registry.remove(id1)
  assert.equal(registry.resolve(first.webContents as never), undefined)
})

test("registry removes a closed window without reading its destroyed WebContents", () => {
  const registry = new LocalWindowRegistry(() => {})
  const window = fakeWindow(1)
  const webContents = window.webContents
  let destroyed = false
  Object.defineProperty(window, "webContents", { get: () => {
    if (destroyed) throw new Error("Object has been destroyed")
    return webContents
  } })
  registry.add({ id: id1, persisted: true, window: window as never, navigation: {} as never, tracker: null, loading: true, backendUrl: null, pendingFolders: [] })

  destroyed = true
  assert.equal(registry.remove(id1)?.id, id1)
  assert.equal(registry.resolve(webContents as never), undefined)
})

test("reopening a saved window id creates a different automation target", () => {
  const registry = new LocalWindowRegistry(() => {})
  const add = (id: number) => registry.add({ id: id1, persisted: true, window: fakeWindow(id) as never,
    navigation: {} as never, tracker: null, loading: false, backendUrl: "https://127.0.0.1", pendingFolders: [] })
  add(1)
  const first = registry.automationWindows(null)[0]
  registry.remove(id1)
  assert.deepEqual(registry.automationWindows(null), [])
  add(2)
  const reopened = registry.automationWindows(null)[0]
  assert.equal(reopened.windowId, first.windowId)
  assert.notEqual(reopened.windowInstance, first.windowInstance)
})

test("browser candidate order prefers focus then MRU without activating a window", () => {
  const registry = new LocalWindowRegistry(() => assert.fail("selection cannot change MRU"))
  const first = fakeWindow(1), second = fakeWindow(2), loading = fakeWindow(3), hiddenLaunch = fakeWindow(4)
  const add = (id: string, window: ReturnType<typeof fakeWindow>, loading: boolean, connectOnly = false) =>
    registry.add({ id, persisted: false, window: window as never, navigation: {} as never, tracker: null, loading, backendUrl: "http://127.0.0.1:1234", pendingFolders: [], connectOnly })
  add(id1, first, false)
  add(id2, second, false)
  add("loading", loading, true)
  add("connect", hiddenLaunch, false, true)
  assert.deepEqual(registry.browserOpenCandidates(first as never), [first.webContents, second.webContents])
  assert.deepEqual(registry.browserOpenCandidates(hiddenLaunch as never), [second.webContents, first.webContents])
  assert.deepEqual([...first.calls, ...second.calls], [])
})
