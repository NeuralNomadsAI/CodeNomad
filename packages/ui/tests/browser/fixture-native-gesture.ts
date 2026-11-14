import assert from "node:assert/strict"
import type { Locator, Page } from "playwright"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"

/** Browser-native reveal, then a point inside every clipping ancestor and the viewport. */
export async function fixtureGesturePoint(target: Locator, offset = { x: 100, y: 100 }) {
  await target.scrollIntoViewIfNeeded()
  return target.evaluate((element, offset) => {
    const box = element.getBoundingClientRect()
    let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right)
    let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom)
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node), bounds = node.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right) }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom) }
    }
    if (right - left < 2 || bottom - top < 2) throw new Error("Native gesture target has no reachable viewport portion")
    return { x: Math.max(left + 1, Math.min(right - 1, box.x + offset.x)), y: Math.max(top + 1, Math.min(bottom - 1, box.y + offset.y)) }
  }, offset)
}

/** Own exactly one native MMB press and its original transcript capture. */
export async function withFixtureMiddleDrag(page: Page, target: Locator, point: { x: number; y: number }, run: () => Promise<void>) {
  const probe = await target.evaluateHandle(element => {
    const root = element.closest<HTMLElement>(".message-stream")
    if (!root) throw new Error("Native middle drag requires the real transcript root")
    const probe = { root, pointerId: -1, trusted: false, hit: false,
      listener(event: PointerEvent) { probe.pointerId = event.pointerId; probe.trusted = event.isTrusted; probe.hit = event.target instanceof Node && element.contains(event.target) } }
    root.addEventListener("pointerdown", probe.listener, { once: true })
    return probe
  })
  await runWithDiagnosticCleanup({ run: async () => {
    assert.equal(await target.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y)
      return point.x >= 0 && point.y >= 0 && point.x < innerWidth && point.y < innerHeight && Boolean(hit && element.contains(hit))
    }, point), true, "Native gesture point must hit its intended target in the viewport")
    await page.mouse.move(point.x, point.y)
    await page.mouse.down({ button: "middle" })
    assert.equal(await probe.evaluate(probe => probe.trusted && probe.hit && probe.root.hasPointerCapture(probe.pointerId)), true,
      "Native middle press must be captured by its original transcript root")
    await run()
  }, diagnose: async () => {}, cleanup: async () => {
    try {
      await page.mouse.up({ button: "middle" })
      assert.equal(await probe.evaluate(probe => probe.root.hasPointerCapture(probe.pointerId)), false, "Native release must clear transcript capture")
    } finally {
      try { await probe.evaluate(probe => probe.root.removeEventListener("pointerdown", probe.listener)) }
      finally { await probe.dispose() }
    }
  }, onObservationError: () => {}, onCleanupError: () => console.error("native-middle-drag-cleanup-failed") })
}
