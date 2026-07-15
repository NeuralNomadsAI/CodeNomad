import assert from "node:assert/strict"
import test from "node:test"
import type { App, BrowserWindow } from "electron"
import { ClientStateLifecycle } from "./client-state-lifecycle"
import type { ClientStateManager } from "./client-state"
import type { CliProcessManager } from "./process-manager"
import type { WindowStateTracker } from "./window-state"

function createHarness(options: { rendererFlush?: () => Promise<unknown>; timeoutMs?: number } = {}) {
  const handlers = new Map<string, (event?: { preventDefault(): void }) => void>()
  let nativeFlushes = 0
  let rendererFlushes = 0
  let primaryReleases = 0
  let cliStops = 0
  let exits = 0
  const window = {
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler)
    },
    isDestroyed: () => false,
    close: () => {},
    webContents: {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:43123/workspace",
      executeJavaScript: () => {
        rendererFlushes += 1
        return options.rendererFlush?.() ?? Promise.resolve()
      },
    },
  } as unknown as BrowserWindow
  const app = { on: () => {}, quit: () => {}, exit: () => { exits += 1 } } as unknown as App
  const clientStateManager = {
    isPrimary: true,
    drainAndReleasePrimary: async () => { primaryReleases += 1 },
  } as ClientStateManager
  const cliManager = { stop: async () => { cliStops += 1 } } as unknown as CliProcessManager
  const lifecycle = new ClientStateLifecycle({
    app,
    clientStateManager,
    cliManager,
    getMainWindow: () => window,
    getAllWindows: () => [window],
    getAllowedRendererOrigins: () => ["http://127.0.0.1:43123"],
    isTrustedRendererOrigin: () => true,
    windowsSessionEndFlushTimeoutMs: options.timeoutMs,
    rendererFlushTimeoutMs: options.timeoutMs === undefined ? undefined : options.timeoutMs * 2,
    isWindows: true,
  })
  const tracker = { flush: async () => { nativeFlushes += 1 } } as unknown as WindowStateTracker
  lifecycle.attachMainWindow(window, tracker)
  return {
    handlers,
    lifecycle,
    getNativeFlushes: () => nativeFlushes,
    getRendererFlushes: () => rendererFlushes,
    getPrimaryReleases: () => primaryReleases,
    getCliStops: () => cliStops,
    getExits: () => exits,
  }
}

test("Windows session termination flushes renderer and native client state once", async () => {
  const harness = createHarness()

  let prevented = false
  harness.handlers.get("query-session-end")?.({ preventDefault: () => { prevented = true } })
  harness.handlers.get("session-end")?.()
  await (harness.lifecycle as any).windowsSessionEndFlush
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(prevented, true)
  assert.equal(harness.getRendererFlushes(), 1)
  assert.equal(harness.getNativeFlushes(), 1)
  assert.equal(harness.getPrimaryReleases(), 1)
  assert.equal(harness.getCliStops(), 1)
  assert.equal(harness.getExits(), 1)
})

test("Windows session termination flush is globally bounded", async () => {
  const harness = createHarness({ rendererFlush: () => new Promise(() => {}), timeoutMs: 20 })
  const startedAt = Date.now()

  harness.handlers.get("query-session-end")?.({ preventDefault: () => {} })
  await (harness.lifecycle as any).windowsSessionEndFlush
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(Date.now() - startedAt < 500)
  assert.equal(harness.getRendererFlushes(), 1)
  assert.equal(harness.getNativeFlushes(), 0)
  assert.equal(harness.getPrimaryReleases(), 0)
  assert.equal(harness.getCliStops(), 0)
  assert.equal(harness.getExits(), 1)
})
