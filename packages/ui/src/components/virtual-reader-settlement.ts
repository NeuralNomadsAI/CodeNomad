/**
 * `element` holds a descendant of the keyed row (an in-place reveal) instead of
 * the row itself. `select` finds a block standing for the row on every frame,
 * so it survives a remount of that row; until it finds one, the row is held.
 */
export interface VirtualItemAnchor {
  key: string
  offset: number
  element?: HTMLElement
  select?: () => HTMLElement | null
  /** The selected block is visible, but the scroll range cannot align it. */
  onClamped?: (target: HTMLElement) => void
}

// A block ending at or above this line already counts as read.
export const READING_LINE_OFFSET_PX = 4

export function settledReaderOffset(offset: number, height: number) {
  return offset < 0 && offset + height <= READING_LINE_OFFSET_PX ? 0 : offset
}

// A hold lasts the former element-alignment window, counted from its request:
// later layout never extends it.
const HOLD_FRAMES = 30

/** A held anchor (a jump, reveal or reflow target) is measured and
 * re-aligned on every frame of its fixed window, like the former element
 * alignment: layout lands after animation
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
    /** Aligns now, or after a pending render, then on each frame of the window. */
    hold: (next: VirtualItemAnchor, defer = false) => {
      cancel()
      anchor = next
      remaining = HOLD_FRAMES
      if (defer) frame = requestAnimationFrame(tick)
      else tick()
    },
  }
}
