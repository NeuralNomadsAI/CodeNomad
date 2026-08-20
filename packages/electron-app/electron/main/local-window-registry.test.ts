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
