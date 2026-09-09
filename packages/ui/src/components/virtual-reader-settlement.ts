interface VirtualItemAnchor { key: string; offset: number }

/** A retained reader owns its anchor until a gesture/navigation changes it.
 * Only layout notifications schedule work; an idle reader has no running RAF.
 */
export function createVirtualReaderSettlement(options: {
  getAnchor: () => VirtualItemAnchor | undefined
  align: (anchor: VirtualItemAnchor) => void
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
    if (!anchor || !options.enabled()) return cancel()
    options.align(anchor)
    if (--remaining > 0) frame = requestAnimationFrame(tick)
  }
  const notify = () => {
    if (!anchor) return
    remaining = 12
    if (frame === undefined) frame = requestAnimationFrame(tick)
  }
  return {
    cancel,
    notify,
    capture: () => ({ anchor: anchor ?? options.getAnchor(), generation }),
    settle: (next: { anchor: VirtualItemAnchor | undefined; generation: number } | undefined) => {
      if (!next?.anchor || next.generation !== generation) return
      anchor = next.anchor
      notify()
    },
  }
}
