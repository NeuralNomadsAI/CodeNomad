/**
 * Coalesces an element's client-height changes into one `previous - next` delta
 * per frame (positive when it shrinks), to keep its bottom anchored on resize.
 * Changes from or to a zero height (hidden, mounting) only rebase.
 */
export function trackHeightDelta(element: HTMLElement, onDelta: (delta: number) => void) {
  let previous = element.clientHeight
  let pending = 0
  let frame: number | null = null
  return {
    /** Call from the owner's ResizeObserver; `anchor: false` rebases without a
     * delta. Returns whether the height changed. */
    update(anchor = true) {
      const next = element.clientHeight
      if (next === previous) return false
      if (anchor && previous > 0 && next > 0) {
        pending += previous - next
        frame ??= requestAnimationFrame(() => {
          frame = null
          const delta = pending
          pending = 0
          onDelta(delta)
        })
      }
      previous = next
      return true
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      pending = 0
    },
  }
}
