import assert from "node:assert/strict"
import test from "node:test"
import { clampWindowBounds, installWindowZoomInput, normalizeNativeWindowState, normalizeZoomFactor, restoreWindowState, WindowStateTracker } from "./window-state"
import type { BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"

const primaryDisplay = { x: 0, y: 0, width: 1920, height: 1080 }

test("normalizes persisted window state", () => {
  assert.equal(normalizeNativeWindowState({ bounds: { x: 0, y: 0, width: Number.NaN, height: 900 }, maximized: false, fullscreen: false, zoomFactor: 1 }), undefined)
  assert.deepEqual(clampWindowBounds({ x: 4000, y: 2000, width: 1400, height: 900 }, [primaryDisplay]), { x: 520, y: 180, width: 1400, height: 900 })
  assert.deepEqual(
    clampWindowBounds({ x: -2000, y: 100, width: 3000, height: 300 }, [{ x: -1280, y: 0, width: 1280, height: 1024 }, primaryDisplay]),
    { x: -1280, y: 100, width: 1280, height: 600 },
  )
})

test("normalizes unsafe zoom factors", () => {
  assert.equal(normalizeZoomFactor(Number.POSITIVE_INFINITY), 1)
  assert.equal(normalizeZoomFactor(0.01), 0.25)
  assert.equal(normalizeZoomFactor(9), 5)
})

test("restores shared outer position and content size", () => {
  const calls: unknown[] = []
  const window = {
    setPosition: (x: number, y: number) => calls.push(["position", x, y]),
    setContentSize: (width: number, height: number) => calls.push(["content", width, height]),
    unmaximize: () => calls.push(["unmaximize"]),
    maximize: () => undefined,
    setFullScreen: (enabled: boolean) => calls.push(["fullscreen", enabled]),
    webContents: { setZoomFactor: () => undefined },
  } as unknown as BrowserWindow
  const bounds = { x: 10, y: 20, width: 1200, height: 800 }
  restoreWindowState(window, { bounds, maximized: false, fullscreen: false, zoomFactor: 1 }, bounds)
  assert.deepEqual(calls, [["fullscreen", false], ["unmaximize"], ["position", 10, 20], ["content", 1200, 800]])
})

test("late promotion applies authoritative window state and tracker baseline", async () => {
  const calls: unknown[] = []
  let maximized = false
  const window = {
    isDestroyed: () => false,
    on: () => undefined,
    getPosition: () => [1, 2],
    getContentSize: () => [900, 700],
    isMaximized: () => maximized,
    isFullScreen: () => false,
    setPosition: (x: number, y: number) => calls.push(["position", x, y]),
    setContentSize: (width: number, height: number) => calls.push(["content", width, height]),
    unmaximize: () => calls.push(["unmaximize"]),
    maximize: () => { maximized = true; calls.push(["maximize"]) },
    setFullScreen: (enabled: boolean) => calls.push(["fullscreen", enabled]),
    webContents: {
      isDestroyed: () => false,
      on: () => undefined,
      setZoomFactor: (factor: number) => calls.push(["zoom", factor]),
      getZoomFactor: () => 1.5,
    },
  } as unknown as BrowserWindow
  const saved: any[] = []
  const manager = {
    saveWindowState: async (state: unknown) => { saved.push(state); return true },
    flush: async () => undefined,
  } as unknown as ClientStateManager
  const tracker = new WindowStateTracker(window, manager)
  const bounds = { x: 10, y: 20, width: 1200, height: 800 }
  tracker.applyAuthoritativeState({ bounds, maximized: true, fullscreen: false, zoomFactor: 1.5 }, bounds)
  await tracker.flush()

  assert.deepEqual(calls.slice(0, 5), [["fullscreen", false], ["position", 10, 20], ["content", 1200, 800], ["zoom", 1.5], ["maximize"]])
  assert.deepEqual(saved[0].bounds, bounds)
  assert.equal(saved[0].zoomFactor, 1.5)
})

test("flush captures the current native zoom", async () => {
  let zoomLevel = -0.5
  const window = {
    isDestroyed: () => false,
    on: () => undefined,
    getPosition: () => [0, 0],
    getContentSize: () => [1200, 800],
    isMaximized: () => false,
    isFullScreen: () => false,
    webContents: {
      isDestroyed: () => false,
      on: () => undefined,
      setZoomLevel: (level: number) => { zoomLevel = level },
      getZoomLevel: () => zoomLevel,
      setZoomFactor: (factor: number) => { zoomLevel = Math.log(factor) / Math.log(1.2) },
      getZoomFactor: () => 1.2 ** zoomLevel,
    },
  } as unknown as BrowserWindow
  const savedZoomFactors: number[] = []
  const manager = {
    saveWindowState: async (state: { zoomFactor: number }) => { savedZoomFactors.push(state.zoomFactor); return true },
    flush: async () => undefined,
  } as unknown as ClientStateManager
  const tracker = new WindowStateTracker(window, manager, { bounds: { x: 0, y: 0, width: 1200, height: 800 }, maximized: false, fullscreen: false, zoomFactor: 1 })

  await tracker.flush()
  assert.ok(Math.abs(savedZoomFactors.at(-1)! - (1.2 ** -0.5)) < 0.000001)
})

test("Electron keyboard and wheel zoom input is applied explicitly", () => {
  const events = new Map<string, (...args: any[]) => void>()
  let zoomLevel = 0
  const prevented: string[] = []
  const window = {
    webContents: {
      on: (name: string, handler: (...args: any[]) => void) => events.set(name, handler),
      getZoomLevel: () => zoomLevel,
    },
  } as unknown as BrowserWindow
  installWindowZoomInput(window, (level) => { zoomLevel = level })

  events.get("before-input-event")?.({ preventDefault: () => prevented.push("keyboard") }, {
    type: "keyDown", control: true, meta: false, alt: false, key: "=",
  })
  assert.equal(zoomLevel, 0.5)
  events.get("zoom-changed")?.({ preventDefault: () => prevented.push("wheel") }, "out")
  assert.equal(zoomLevel, 0)
  assert.deepEqual(prevented, ["keyboard", "wheel"])
})

test("native menu zoom survives cross-origin navigation", () => {
  const events = new Map<string, (...args: any[]) => void>()
  let zoomLevel = -0.5
  const window = {
    isDestroyed: () => false,
    on: () => undefined,
    webContents: {
      isDestroyed: () => false,
      on: (name: string, handler: (...args: any[]) => void) => events.set(name, handler),
      getZoomFactor: () => 1.2 ** zoomLevel,
      setZoomFactor: (factor: number) => { zoomLevel = Math.log(factor) / Math.log(1.2) },
    },
  } as unknown as BrowserWindow
  const manager = { flush: async () => undefined } as unknown as ClientStateManager
  new WindowStateTracker(window, manager, {
    bounds: { x: 0, y: 0, width: 1200, height: 800 }, maximized: false, fullscreen: false, zoomFactor: 1,
  })

  events.get("did-start-navigation")?.({}, "http://next.test", false, true)
  zoomLevel = 0
  events.get("did-finish-load")?.()
  assert.ok(Math.abs(zoomLevel - (-0.5)) < 0.000001)
})
