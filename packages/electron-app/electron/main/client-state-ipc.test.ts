import assert from "node:assert/strict"
import test from "node:test"
import type { IpcMainInvokeEvent } from "electron"
import { setupClientStateIPC } from "./client-state-ipc"

function harness(persisted = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const frame = { url: "http://127.0.0.1:3000/app" }
  const webContents = {
    mainFrame: frame,
    getURL: () => "http://127.0.0.1:3000/app",
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
  }
  let destroyed = false
  const window = { isDestroyed: () => destroyed, get webContents() {
    if (destroyed) throw new Error("Object has been destroyed")
    return webContents
  } }
  let current: typeof window | null = window
  const calls: string[] = []
  const windowId = "11111111-1111-4111-8111-111111111111"
  const state = {
    activeWindowId: windowId,
    claimClientStateAccess: (token: unknown, id: string) => { calls.push(`claim:${token}:${id}`); return true },
    assertRendererAccessToken: (token: unknown, id: string) => calls.push(`assert:${token}:${id}`),
    loadClientState: (id: string) => { calls.push(`load:${id}`); return { isPrimary: true } },
    saveClientState: () => true,
    commitClientStatePartitions: () => true,
    loadClientStatePartition: () => null,
    setRestoreEnabled: () => true,
    clearClientState: () => true,
    resetRendererAccessToken: (id: string) => calls.push(`reset:${id}`),
  }
  const bind = setupClientStateIPC(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    state as never,
    (sender) => current && sender === (webContents as never) ? { id: windowId, persisted, window: current as never } : undefined,
    () => ["http://127.0.0.1:3000"],
  )
  bind(window as never)
  return { calls, destroyWindow: () => { destroyed = true }, frame, handlers, listeners, setCurrent: (value: typeof window | null) => { current = value }, webContents, window, windowId }
}

test("ephemeral local renderers receive secondary state without claiming a missing V3 record", async () => {
  const h = harness(false)
  const event = { sender: h.webContents, senderFrame: h.frame }
  assert.equal(await h.handlers.get("client-state:claimAccess")!(event as never, "token"), false)
  assert.deepEqual(h.calls, [])
  await assert.rejects(h.handlers.get("client-state:load")!(event as never, "token") as Promise<unknown>, /unavailable/)
})

test("IPC channels enforce the current main sender, frame, origin, and token", async () => {
  const h = harness()
  assert.deepEqual([...h.handlers.keys()], [
    "client-state:claimAccess", "client-state:load", "client-state:save",
    "client-state:commitPartitions", "client-state:loadPartition",
    "client-state:setRestoreEnabled", "client-state:clear",
  ])
  const event = { sender: h.webContents, senderFrame: h.frame }
  await h.handlers.get("client-state:claimAccess")!(event as never, "token")
  await h.handlers.get("client-state:load")!(event as never, "token")
  assert.deepEqual(h.calls, [`claim:token:${h.windowId}`, `assert:token:${h.windowId}`, `load:${h.windowId}`])

  for (const invalid of [
    { sender: {}, senderFrame: h.frame },
    { sender: h.webContents, senderFrame: { url: h.frame.url } },
    { sender: h.webContents, senderFrame: { ...h.frame, url: "https://example.com" } },
  ]) await assert.rejects(h.handlers.get("client-state:load")!(invalid as never, "token") as Promise<unknown>)
})

test("two local renderers claim and use independent window tokens", async () => {
  const handlers = new Map<string, Function>()
  const calls: string[] = []
  const makeWindow = (id: string, contentsId: number) => {
    const frame = { url: "http://127.0.0.1:3000/app" }
    const webContents = { id: contentsId, mainFrame: frame, getURL: () => frame.url, on: () => {} }
    return { id, window: { isDestroyed: () => false, webContents }, frame, webContents }
  }
  const first = makeWindow("11111111-1111-4111-8111-111111111111", 1)
  const second = makeWindow("22222222-2222-4222-8222-222222222222", 2)
  const records = [first, second]
  setupClientStateIPC({ handle: (channel, handler) => {
    assert.equal(handlers.has(channel), false, `duplicate handler ${channel}`)
    handlers.set(channel, handler)
  } }, {
    claimClientStateAccess: (token: unknown, id: string) => { calls.push(`claim:${id}:${token}`); return true },
    assertRendererAccessToken: (token: unknown, id: string) => calls.push(`assert:${id}:${token}`),
    loadClientState: (id: string) => { calls.push(`load:${id}`); return {} },
  } as never, (sender) => records.find((record) => record.webContents === (sender as never)) as never, () => ["http://127.0.0.1:3000"])
  for (const [record, token] of [[first, "one"], [second, "two"]] as const) {
    const event = { sender: record.webContents, senderFrame: record.frame }
    await handlers.get("client-state:claimAccess")!(event, token)
    await handlers.get("client-state:load")!(event, token)
  }
  assert.deepEqual(calls, [
    `claim:${first.id}:one`, `assert:${first.id}:one`, `load:${first.id}`,
    `claim:${second.id}:two`, `assert:${second.id}:two`, `load:${second.id}`,
  ])
  assert.equal(handlers.size, 7)
})

test("only a registered local window can reset its renderer authority", () => {
  const h = harness()
  h.listeners.get("did-navigate")!({}, "http://127.0.0.1:3000/next")
  h.listeners.get("render-process-gone")!()
  assert.equal(h.calls.length, 2)
  assert.match(h.calls[0]!, /^reset:[0-9a-f-]{36}$/)
  assert.equal(h.calls[1], h.calls[0])
  h.setCurrent(null)
  h.listeners.get("did-navigate")!({}, "http://127.0.0.1:3000/late")
  h.destroyWindow()
  h.listeners.get("destroyed")!()
  assert.equal(h.calls.length, 2)
})
