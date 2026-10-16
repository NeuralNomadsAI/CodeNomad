/** `element` holds a descendant of the keyed row (an in-place reveal) instead of the row itself. */
interface VirtualItemAnchor { key: string; offset: number; element?: HTMLElement }

const SETTLE_FRAMES = 12
// An in-place reveal is held for the former element-alignment window, counted
// from the alignment request: later layout never extends it.
const HOLD_FRAMES = 30

/** A retained reader owns its anchor until a gesture/navigation changes it.
 * Only layout notifications schedule its work; an idle reader has no running RAF.
 * A held element (`hold`) is measured and re-aligned on every frame of its fixed
 * window, like the former element alignment: layout lands after animation frames,
 * so waiting for its notification would paint the displaced frame first. `align`
 * returns false when an anchor can no longer be held.
 */
export function createVirtualReaderSettlement(options: {
  getAnchor: () => VirtualItemAnchor | undefined
  align: (anchor: VirtualItemAnchor) => boolean | void
  enabled: () => boolean
}) {
  let anchor: VirtualItemAnchor | undefined
  let frame: number | undefined
  let remaining = 0
  let generation = 0
  const cancel = () => {
    generation += 1
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    anchor = undefined
  }
  const tick = () => {
    frame = undefined
    if (!anchor || !options.enabled() || options.align(anchor) === false) return cancel()
    if (--remaining > 0) frame = requestAnimationFrame(tick)
    else if (anchor.element) cancel()
  }
  /** Layout changed or a scroll was observed: re-arms a retained reader. A held element's window is fixed. */
  const notify = () => {
    if (!anchor || anchor.element) return
    remaining = SETTLE_FRAMES
    if (frame === undefined) frame = requestAnimationFrame(tick)
  }
  return {
    cancel,
    notify,
    /** The held element anchor, if any. */
    held: () => anchor?.element ? anchor : undefined,
    capture: () => ({ anchor: anchor ?? options.getAnchor(), generation }),
    settle: (next: { anchor: VirtualItemAnchor | undefined; generation: number } | undefined) => {
      if (!next?.anchor || next.generation !== generation) return
      anchor = next.anchor
      notify()
    },
    /** Takes ownership of `next` at once: aligns it now, then on every frame of its window. */
    hold: (next: VirtualItemAnchor) => {
      cancel()
      anchor = next
      remaining = HOLD_FRAMES
      tick()
    },
  }
}
