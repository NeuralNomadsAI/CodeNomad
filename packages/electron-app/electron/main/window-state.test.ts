import assert from "node:assert/strict"
import test from "node:test"
import { clampWindowBounds, normalizeNativeWindowState, normalizeZoomFactor } from "./window-state"

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
