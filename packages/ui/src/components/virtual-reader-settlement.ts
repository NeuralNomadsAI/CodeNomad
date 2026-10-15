/** `element` holds a descendant of the keyed row (an in-place reveal) instead of the row itself. */
interface VirtualItemAnchor { key: string; offset: number; element?: HTMLElement }

const SETTLE_FRAMES = 12

/** A retained reader owns its anchor until a gesture/navigation changes it.
 * Only layout notifications schedule work; an idle reader has no running RAF.
 * `align` returns false when its anchor can no longer be held.
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
  }
  const notify = () => {
    if (!anchor) return
    remaining = SETTLE_FRAMES
    if (frame === undefined) frame = requestAnimationFrame(tick)
  }
  return {
    cancel,
    /** Layout changed: re-arms the anchor. */
    notify,
    /**
     * A scroll was observed. It re-arms a retained reader. A held element follows
     * layout only: `movedHeld` reports a scroll nobody wrote that moved it (focus,
     * find-in-page, assistive technology, unlike Virtua's compensation, which keeps
     * it in place); while idle, that is the reader moving on and releases the hold.
     */
    scrolled: (movedHeld: (held: { element: HTMLElement; offset: number }) => boolean) => {
      if (!anchor?.element) return notify()
      if (frame === undefined && movedHeld({ element: anchor.element, offset: anchor.offset })) cancel()
    },
    /** The held element anchor, if any. */
    held: () => anchor?.element ? anchor : undefined,
    capture: () => ({ anchor: anchor ?? options.getAnchor(), generation }),
    settle: (next: { anchor: VirtualItemAnchor | undefined; generation: number } | undefined) => {
      if (!next?.anchor || next.generation !== generation) return
      anchor = next.anchor
      notify()
    },
    /** Takes ownership of `next` at once: aligns it now, then like a settled reader. */
    hold: (next: VirtualItemAnchor) => {
      cancel()
      anchor = next
      remaining = SETTLE_FRAMES
      tick()
    },
  }
}
