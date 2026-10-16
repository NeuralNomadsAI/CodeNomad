/**
 * Coalesces an element's client-height changes into one `previous - next` delta
 * per frame (positive when it shrinks), to keep its bottom anchored on resize.
 * Changes from or to a zero height (hidden, mounting) only rebase.
 */
export function trackHeightDelta(element: HTMLElement, onDelta: (delta: number) => void) {
  let previous = element.clientHeight
  let pending = 0
  let frame: number | null = null
  let disposed = false
  return {
    /**
     * Call from the owner's ResizeObserver. A change while `anchored` is false
     * only rebases and drops the pending delta.
     */
    update(anchored = true) {
      const next = element.clientHeight
      if (disposed || next === previous) return
      if (!anchored) pending = 0
      else if (previous > 0 && next > 0) {
        pending += previous - next
        frame ??= requestAnimationFrame(() => {
          frame = null
          const delta = pending
          pending = 0
          onDelta(delta)
        })
      }
      previous = next
    },
    dispose() {
      disposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    },
  }
}
