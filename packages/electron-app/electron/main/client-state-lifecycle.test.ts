import assert from "node:assert/strict"
import test from "node:test"
import type { App, BrowserWindow } from "electron"
import { ClientStateLifecycle } from "./client-state-lifecycle"
import type { ClientStateManager } from "./client-state"
import type { CliProcessManager } from "./process-manager"
import type { WindowStateTracker } from "./window-state"

const tick = () => new Promise((resolve) => setImmediate(resolve))
function harness(options: { flush?: () => Promise<unknown>; timeout?: number; otherWindow?: boolean } = {}) {
  const windows = new Map<string, (event?: { preventDefault(): void }) => void>()
  const appEvents = new Map<string, (event?: { preventDefault(): void }) => void>()
  const calls: string[] = []
  let exits = 0
  const window = {
    on: (name: string, handler: (event?: { preventDefault(): void }) => void) => windows.set(name, handler),
    isDestroyed: () => false,
    close: () => { calls.push("close"); windows.get("close")?.({ preventDefault: () => assert.fail("approved close prevented") }) },
    webContents: { isDestroyed: () => false, getURL: () => "http://127.0.0.1:43123/workspace", executeJavaScript: () => { calls.push("renderer"); return options.flush?.() ?? Promise.resolve() } },
  } as unknown as BrowserWindow
  const other = { isDestroyed: () => false } as BrowserWindow
  const app = { on: (name: string, handler: never) => appEvents.set(name, handler), quit: () => calls.push("quit"), exit: () => { exits++ } } as unknown as App
  const manager = { isPrimary: true, flush: async () => {}, drainAndReleasePrimary: async () => { calls.push("release") } } as ClientStateManager
  const cli = { stop: async () => { calls.push("stop") } } as unknown as CliProcessManager
  const lifecycle = new ClientStateLifecycle({ app, clientStateManager: manager, cliManager: cli, getMainWindow: () => window, getAllWindows: () => options.otherWindow ? [window, other] : [window], getAllowedRendererOrigins: () => ["http://127.0.0.1:43123"], isTrustedRendererOrigin: () => true, windowsSessionEndFlushTimeoutMs: options.timeout, rendererFlushTimeoutMs: options.timeout && options.timeout * 2, isWindows: true })
  lifecycle.attachMainWindow(window, { flush: async () => { calls.push("native") } } as unknown as WindowStateTracker)
  lifecycle.registerAppEvents()
  const close = () => { let prevented = false; windows.get("close")?.({ preventDefault: () => { prevented = true } }); return prevented }
  return { appEvents, calls, close, exits: () => exits, lifecycle, window, windows }
}

test("close flushes renderer/native once before approval, even when repeated or renderer fails", async (t) => {
  await t.test("ordinary", async () => {
    const h = harness({ otherWindow: true })
    assert.equal(h.close(), true)
    await tick()
    assert.deepEqual(h.calls, ["renderer", "native", "close"])
  })
  await t.test("coalesced", async () => {
    let release!: () => void
    const h = harness({ otherWindow: true, flush: () => new Promise<void>((resolve) => { release = resolve }) })
    assert.equal(h.close(), true); assert.equal(h.close(), true)
    assert.deepEqual(h.calls, ["renderer"])
    release(); await tick()
    assert.deepEqual(h.calls, ["renderer", "native", "close"])
  })
  await t.test("renderer failure", async () => {
    const h = harness({ otherWindow: true, flush: async () => { throw new Error("failed") } })
    assert.equal(h.close(), true); await tick()
    assert.deepEqual(h.calls, ["renderer", "native", "close"])
  })
})

test("late old-window detach preserves replacement tracker during shutdown", async () => {
  const h = harness()
  const replacement = { on: () => {} } as unknown as BrowserWindow
  h.lifecycle.attachMainWindow(replacement, { flush: async () => { h.calls.push("replacement-native") } } as unknown as WindowStateTracker)
  h.lifecycle.detachMainWindow(h.window)
  h.appEvents.get("before-quit")?.({ preventDefault: () => {} })
  await (h.lifecycle as any).shutdown
  assert.deepEqual(h.calls, ["renderer", "replacement-native", "release", "stop"])
})

test("Windows session end flushes once and exits", async () => {
  const h = harness()
  let prevented = false
  h.windows.get("query-session-end")?.({ preventDefault: () => { prevented = true } })
  h.windows.get("session-end")?.()
  await (h.lifecycle as any).sessionEnd; await tick()
  assert.equal(prevented, true)
  assert.deepEqual(h.calls, ["renderer", "native", "release", "stop"])
  assert.equal(h.exits(), 1)
})

test("session end promotes and bounds an already-hung ordinary shutdown", async () => {
  const h = harness({ flush: () => new Promise(() => {}), timeout: 20 })
  const started = Date.now()
  h.appEvents.get("before-quit")?.({ preventDefault: () => {} })
  h.windows.get("query-session-end")?.({ preventDefault: () => {} })
  await (h.lifecycle as any).sessionEnd; await tick()
  assert.ok(Date.now() - started < 500)
  assert.deepEqual(h.calls, ["renderer"])
  assert.equal(h.exits(), 1)
})
