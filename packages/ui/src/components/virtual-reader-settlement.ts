/** `element` holds a descendant of the keyed row (an in-place reveal) instead of the row itself. */
interface VirtualItemAnchor { key: string; offset: number; element?: HTMLElement }

// A hold lasts the former element-alignment window, counted from its request:
// later layout never extends it.
const HOLD_FRAMES = 30

/** A held anchor (a jump's row, a revealed element, or the reader across a
 * rolling window) is measured and re-aligned on every frame of its fixed
 * window, like the former element alignment: layout lands after animation
 * frames, so waiting for a layout notification would paint the displaced frame
 * first. It is then released, so a later focus or reveal is never pulled back.
 * `align` returns false when an anchor can no longer be held.
 */
export function createVirtualReaderSettlement(options: {
  align: (anchor: VirtualItemAnchor) => boolean | void
  enabled: () => boolean
}) {
  let anchor: VirtualItemAnchor | undefined
  let frame: number | undefined
  let remaining = 0
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    anchor = undefined
  }
  const tick = () => {
    frame = undefined
    if (!anchor || !options.enabled() || options.align(anchor) === false) return cancel()
    if (--remaining > 0) frame = requestAnimationFrame(tick)
    else cancel()
  }
  return {
    cancel,
    /** The held anchor, if any. */
    held: () => anchor,
    /** Takes ownership of `next` at once: aligns it now, then on every frame of its window. */
    hold: (next: VirtualItemAnchor) => {
      cancel()
      anchor = next
      remaining = HOLD_FRAMES
      tick()
    },
  }
}
