/**
 * `element` holds a descendant of the keyed row (an in-place reveal) instead of
 * the row itself. `select` finds a block standing for the row on every frame,
 * so it survives a remount of that row; until it finds one, the row is held.
 */
export interface VirtualItemAnchor { key: string; offset: number; element?: HTMLElement; select?: () => HTMLElement | null }

// A block ending at or above this line already counts as read.
export const READING_LINE_OFFSET_PX = 4

export function settledReaderOffset(offset: number, height: number) {
  return offset < 0 && offset + height <= READING_LINE_OFFSET_PX ? 0 : offset
}

// A measurable target gets the ordinary alignment window. The absolute deadline
// also covers a virtual row, lazy renderer, or replacement that never arrives.
const HOLD_FRAMES = 30
const HOLD_BUDGET_MS = 5000

/** Re-aligns a jump, reveal or reflow target on each frame while it settles.
 * `pending` means only an estimate or fallback is available; `false` releases
 * a lost target. Gestures cancel either state, and the deadline bounds both.
 */
export function createVirtualReaderSettlement(options: {
  align: (anchor: VirtualItemAnchor) => "pending" | false | void
  enabled: () => boolean
}) {
  let anchor: VirtualItemAnchor | undefined
  let frame: number | undefined
  let remaining = 0
  let deadline = 0
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    anchor = undefined
  }
  const tick = (now = performance.now()) => {
    frame = undefined
    if (!anchor || !options.enabled() || now >= deadline) return cancel()
    const result = options.align(anchor)
    if (result === false) return cancel()
    if (result === "pending") remaining = HOLD_FRAMES
    else if (--remaining === 0) return cancel()
    frame = requestAnimationFrame(tick)
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
      deadline = performance.now() + HOLD_BUDGET_MS
      if (defer) frame = requestAnimationFrame(tick)
      else tick()
    },
  }
}
