/**
 * `element` holds a descendant of the keyed row (an in-place reveal) instead of
 * the row itself. `select` finds a block standing for the row on every frame,
 * so it survives a remount of that row. Pending means the block can still mount;
 * null means it is gone. Reflows hold only a block, never its row.
 */
export type VirtualBlockTarget = HTMLElement | "pending" | null
export interface VirtualItemAnchor {
  key: string
  offset: number
  element?: HTMLElement
  select?: () => VirtualBlockTarget
  reflow?: true
}

// A block ending at or above this line already counts as read.
export const READING_LINE_OFFSET_PX = 4

export function settledReaderOffset(offset: number, height: number) {
  return offset < 0 && offset + height <= READING_LINE_OFFSET_PX ? 0 : offset
}

// Later layout never extends the alignment window.
const HOLD_FRAMES = 30

/** Re-aligns a jump, reveal or reflow target on each frame of a fixed window.
 * Gestures cancel the hold, and `align` returns false for a lost target.
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
