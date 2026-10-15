import { canScrollInDirection } from "../components/virtual-follow-behavior"

/** Controls that consume a pointer press: neither middle-button autoscroll nor a selection drag starts on them. */
export const POINTER_CONTROL_SELECTOR = "a[href],button,input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='button'],[role='textbox']"

const WHEEL_GESTURE_IDLE_MS = 180
const MIDDLE_DEAD_ZONE_PX = 8

function scrollAxes(node: HTMLElement) {
  const style = getComputedStyle(node)
  const scrolls = (overflow: string) => /^(auto|scroll|overlay)$/.test(overflow)
  return {
    x: scrolls(style.overflowX) && node.scrollWidth > node.clientWidth + 1,
    y: scrolls(style.overflowY) && node.scrollHeight > node.clientHeight + 1,
  }
}

/** Nested-scroller test for gesture routing: the innermost scroller from `target`
 * up to, excluding, `root` that can still scroll vertically in `direction` consumes
 * the gesture. The transcript's own intent check still walks ancestors separately. */
export function findNestedScroller(root: HTMLElement, target: EventTarget | null, direction: "up" | "down"): HTMLElement | null {
  for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement) {
    // The edge test first skips style resolution for most ancestors.
    if (node instanceof HTMLElement && canScrollInDirection(node, direction) && scrollAxes(node).y) return node
  }
  return null
}

/** Effective CSS zoom of `element`. The app zooms natively (1 here); CSS zoom still scales input. */
export function getElementZoom(element: Element) {
  return element.currentCSSZoom || 1
}

/** Scroller pixels per wheel delta unit: pixel deltas are page pixels, so 1/zoom under CSS zoom (measured). */
export function wheelDeltaUnit(event: WheelEvent, element: HTMLElement) {
  return event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight
    : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? parseFloat(getComputedStyle(element).lineHeight) || 16 : 1 / getElementZoom(element)
}

function middleTargets(root: HTMLElement, target: EventTarget | null) {
  const owners: { x?: HTMLElement; y?: HTMLElement } = {}
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node instanceof HTMLElement) {
      const axes = scrollAxes(node)
      if (axes.x) owners.x ??= node
      if (axes.y) owners.y ??= node
    }
    if (node === root) break
  }
  return owners
}

/** Keep an in-progress gesture on its starting scroller, not whatever row
 * virtualization or pointer movement happens to place under the cursor next. */
export function attachScrollGestureRouting(root: HTMLElement): () => void {
  let wheelOwner: HTMLElement | undefined
  let wheelAt = -Infinity
  let middle: { owners: ReturnType<typeof middleTargets>; pointerId: number; x: number; y: number; dx: number; dy: number; time: number } | undefined
  let frame: number | undefined

  const wheel = (event: WheelEvent) => {
    // Redispatched intent below is only for the existing follow controllers.
    if (!event.isTrusted) return
    // Leave zoom, native horizontal/Shift-wheel and uncancellable input alone.
    if (event.ctrlKey || event.shiftKey || event.deltaX !== 0 || !event.deltaY || !event.cancelable || event.defaultPrevented) {
      wheelOwner = undefined
      return
    }
    const now = performance.now()
    const direction = event.deltaY < 0 ? "up" : "down"
    const target = findNestedScroller(root, event.target, direction) ?? root
    // At an edge, chain only to an ancestor of the owner, never a new shell
    // passing under the cursor during the same gesture.
    wheelOwner = !wheelOwner?.isConnected || !root.contains(wheelOwner) || now - wheelAt > WHEEL_GESTURE_IDLE_MS
      ? target
      : findNestedScroller(root, wheelOwner, direction) ?? root
    wheelAt = now
    const owner = wheelOwner
    if (owner === target) return
    event.preventDefault()
    event.stopPropagation()
    owner.dispatchEvent(new WheelEvent("wheel", { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, bubbles: true }))
    const unit = wheelDeltaUnit(event, owner)
    owner.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit, behavior: "instant" })
  }

  const stopMiddle = () => {
    const active = middle
    middle = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    if (active && root.hasPointerCapture(active.pointerId)) root.releasePointerCapture(active.pointerId)
    if (active) root.style.cursor = previousCursor
  }
  let previousCursor = ""
  const tick = (time: number) => {
    frame = undefined
    const active = middle
    if (!active) return
    if (Object.values(active.owners).some(owner => !root.contains(owner) || !owner.getClientRects().length)) return stopMiddle()
    const elapsed = Math.min(time - active.time, 32) / 16.67
    active.time = time
    const speed = (distance: number) => Math.sign(distance) * Math.max(0, Math.abs(distance) - MIDDLE_DEAD_ZONE_PX) / 6
    active.owners.x?.scrollBy({ left: speed(active.dx) * elapsed, behavior: "instant" })
    active.owners.y?.scrollBy({ top: speed(active.dy) * elapsed, behavior: "instant" })
    frame = requestAnimationFrame(tick)
  }
  const down = (event: PointerEvent) => {
    if (!event.isTrusted || event.button !== 1 || event.defaultPrevented) return
    // Preserve middle-click link opening and editable/control behavior.
    if (event.target instanceof Element && event.target.closest(POINTER_CONTROL_SELECTOR)) return
    stopMiddle()
    wheelOwner = undefined
    const owners = middleTargets(root, event.target)
    if (!owners.x && !owners.y) return
    event.preventDefault()
    middle = { owners, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, time: performance.now() }
    previousCursor = root.style.cursor
    root.style.cursor = "all-scroll"
    root.setPointerCapture(event.pointerId)
    frame = requestAnimationFrame(tick)
    // Do not stop propagation: both nested and transcript follow controllers
    // must relinquish automatic writes before the first drag frame.
  }
  const move = (event: PointerEvent) => {
    if (!middle || event.pointerId !== middle.pointerId) return
    if ((event.buttons & 4) === 0) return stopMiddle()
    middle.dx = event.clientX - middle.x
    middle.dy = event.clientY - middle.y
  }
  const end = (event: PointerEvent) => {
    if (middle && event.pointerId === middle.pointerId) stopMiddle()
  }
  const visibility = () => { if (document.hidden) stopMiddle() }
  root.addEventListener("wheel", wheel, { capture: true, passive: false })
  root.addEventListener("pointerdown", down, true)
  root.addEventListener("pointermove", move)
  root.addEventListener("pointerup", end)
  root.addEventListener("pointercancel", end)
  root.addEventListener("lostpointercapture", end)
  window.addEventListener("blur", stopMiddle)
  document.addEventListener("visibilitychange", visibility)
  return () => {
    stopMiddle()
    root.removeEventListener("wheel", wheel, true)
    root.removeEventListener("pointerdown", down, true)
    root.removeEventListener("pointermove", move)
    root.removeEventListener("pointerup", end)
    root.removeEventListener("pointercancel", end)
    root.removeEventListener("lostpointercapture", end)
    window.removeEventListener("blur", stopMiddle)
    document.removeEventListener("visibilitychange", visibility)
  }
}
