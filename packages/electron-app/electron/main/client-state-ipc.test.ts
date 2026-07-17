import assert from "node:assert/strict"
import test from "node:test"
import type { IpcMainInvokeEvent } from "electron"
import { setupClientStateIPC } from "./client-state-ipc"

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const frame = { url: "http://127.0.0.1:3000/app" }
  const webContents = {
    mainFrame: frame,
    getURL: () => "http://127.0.0.1:3000/app",
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
  }
  const window = { isDestroyed: () => false, webContents }
  let current: typeof window | null = window
  const calls: string[] = []
  const state = {
    claimClientStateAccess: (token: unknown) => { calls.push(`claim:${token}`); return true },
    assertRendererAccessToken: (token: unknown) => calls.push(`assert:${token}`),
    loadClientState: () => ({ isPrimary: true }),
    saveClientState: () => true,
    setRestoreEnabled: () => true,
    clearClientState: () => true,
    resetRendererAccessToken: () => calls.push("reset"),
  }
  const bind = setupClientStateIPC(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    state as never,
    () => current as never,
    () => ["http://127.0.0.1:3000"],
  )
  bind(window as never)
  return { calls, frame, handlers, listeners, setCurrent: (value: typeof window | null) => { current = value }, webContents, window }
}

test("IPC channels enforce the current main sender, frame, origin, and token", async () => {
  const h = harness()
  assert.deepEqual([...h.handlers.keys()], [
    "client-state:claimAccess", "client-state:load", "client-state:save",
    "client-state:setRestoreEnabled", "client-state:clear",
  ])
  const event = { sender: h.webContents, senderFrame: h.frame }
  await h.handlers.get("client-state:claimAccess")!(event as never, "token")
  await h.handlers.get("client-state:load")!(event as never, "token")
  assert.deepEqual(h.calls, ["claim:token", "assert:token"])

  for (const invalid of [
    { sender: {}, senderFrame: h.frame },
    { sender: h.webContents, senderFrame: { url: h.frame.url } },
    { sender: h.webContents, senderFrame: { ...h.frame, url: "https://example.com" } },
  ]) await assert.rejects(h.handlers.get("client-state:load")!(invalid as never, "token") as Promise<unknown>)
})

test("only the registered current window can reset renderer authority", () => {
  const h = harness()
  h.listeners.get("did-navigate")!({}, "http://127.0.0.1:3000/next")
  h.listeners.get("render-process-gone")!()
  assert.deepEqual(h.calls, ["reset", "reset"])
  h.setCurrent(null)
  h.listeners.get("did-navigate")!({}, "http://127.0.0.1:3000/late")
  h.listeners.get("destroyed")!()
  assert.deepEqual(h.calls, ["reset", "reset"])
})
