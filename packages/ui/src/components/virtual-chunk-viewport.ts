// Mounting and anchoring for chunked lists rendered inside one virtualized
// transcript row. Virtua measures and compensates whole rows; a long message is
// one row, so this adapter compensates chunk resizes inside it. See
// `virtual-chunk-list.tsx` for the rendering side.

const ROW_SELECTOR = "[data-virtual-follow-key]"
// Render chunks within one viewport above and below the visible area.
const OVERSCAN_MARGIN = "100% 0px"
// Mirrors Virtua's idle detection: its resize compensation differs while scrolling down.
const SCROLL_IDLE_MS = 150

export interface VirtualChunkHandle {
  setNear: (near: boolean) => void
  isMounted: () => boolean
  /** Border-box height of a rendered chunk, reported after every resize. */
  measured: (height: number) => void
}

export interface VirtualChunkViewport {
  observe: (element: HTMLElement, handle: VirtualChunkHandle) => () => void
  dispose: () => void
}

interface VirtualChunkViewportOptions {
  root: HTMLElement
  /** Whether a layout shift above the viewport may be compensated now (not following, restoring or navigating). */
  canCompensate: () => boolean
  /** Scrolls by `delta` px without counting as a gesture or a navigation. */
  compensate: (delta: number) => void
}

export function createVirtualChunkViewport(options: VirtualChunkViewportOptions): VirtualChunkViewport {
  const { root } = options
  const chunks = new Map<Element, { handle: VirtualChunkHandle; height?: number }>()
  const pendingInitial = new Set<Element>()
  let resizeObserver: ResizeObserver | undefined
  let lastScrollTop = root.scrollTop
  let scrollDirection: "up" | "down" | undefined
  let scrollDirectionAt = 0

  const handleScroll = () => {
    const top = root.scrollTop
    if (top !== lastScrollTop) {
      scrollDirection = top > lastScrollTop ? "down" : "up"
      scrollDirectionAt = performance.now()
    }
    lastScrollTop = top
  }
  root.addEventListener("scroll", handleScroll, { passive: true })

  const intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) chunks.get(entry.target)?.handle.setNear(entry.isIntersecting)
  }, { root, rootMargin: OVERSCAN_MARGIN })

  // Decide the first state synchronously (one layout read for the batch) so a
  // visible chunk never paints as an empty placeholder before the observer runs.
  const flushInitial = () => {
    const rootRect = root.getBoundingClientRect()
    const margin = rootRect.height
    const near = Array.from(pendingInitial, (element) => {
      const rect = element.getBoundingClientRect()
      return [element, rect.bottom >= rootRect.top - margin && rect.top <= rootRect.bottom + margin] as const
    })
    pendingInitial.clear()
    for (const [element, value] of near) if (value) chunks.get(element)?.handle.setNear(true)
  }

  // Runs after Virtua's own row observer (created first, at Virtualizer mount), so
  // any row compensation Virtua applied in this frame is already in scrollTop.
  const handleResize = (entries: ResizeObserverEntry[]) => {
    const virtuaJumped = root.scrollTop !== lastScrollTop
    const scrollingDown = scrollDirection === "down" && performance.now() - scrollDirectionAt < SCROLL_IDLE_MS
    const rootRect = root.getBoundingClientRect()
    const shifted: Array<{ element: Element; delta: number }> = []
    for (const entry of entries) {
      const chunk = chunks.get(entry.target)
      if (!chunk) continue
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height
      const delta = chunk.height === undefined ? 0 : height - chunk.height
      chunk.height = height
      if (chunk.handle.isMounted()) chunk.handle.measured(height)
      // Only a chunk that lay entirely above the viewport moves visible content.
      if (delta !== 0 && entry.target.getBoundingClientRect().bottom - delta <= rootRect.top) {
        shifted.push({ element: entry.target, delta })
      }
    }
    let total = 0
    if (shifted.length > 0 && options.canCompensate()) {
      for (const { element, delta } of shifted) {
        // An enclosing chunk that shifted too already includes this delta.
        if (shifted.some((other) => other.element !== element && other.element.contains(element))) continue
        const row = element.closest(ROW_SELECTOR)?.getBoundingClientRect()
        // Virtua keeps the position for rows entirely above the viewport.
        if (!row || row.bottom <= rootRect.top) continue
        // A row ending inside the viewport is compensated by Virtua while scrolling down.
        if (row.bottom < rootRect.bottom && (virtuaJumped || scrollingDown)) continue
        total += delta
      }
    }
    if (total !== 0) options.compensate(total)
    lastScrollTop = root.scrollTop
  }

  return {
    observe(element, handle) {
      chunks.set(element, { handle })
      intersectionObserver.observe(element)
      // Created lazily from chunk effects, after Virtua's row observer.
      resizeObserver ??= new ResizeObserver(handleResize)
      resizeObserver.observe(element)
      if (pendingInitial.size === 0) queueMicrotask(flushInitial)
      pendingInitial.add(element)
      return () => {
        chunks.delete(element)
        pendingInitial.delete(element)
        intersectionObserver.unobserve(element)
        resizeObserver?.unobserve(element)
      }
    },
    dispose() {
      root.removeEventListener("scroll", handleScroll)
      intersectionObserver.disconnect()
      resizeObserver?.disconnect()
      chunks.clear()
      pendingInitial.clear()
    },
  }
}
