import { JSX, Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

const sizeCache = new Map<string, number>()
const DEFAULT_MARGIN_PX = 600
const MIN_PLACEHOLDER_HEIGHT = 400
const VISIBILITY_BUFFER_PX = 0

type ObserverRoot = Element | Document | null

type IntersectionCallback = (entry: IntersectionObserverEntry) => void

interface SharedObserver {
  observer: IntersectionObserver
  listeners: Map<Element, Set<IntersectionCallback>>
}

const NULL_ROOT_KEY = "__null__"
const rootIds = new WeakMap<Element | Document, number>()
let sharedRootId = 0
const sharedObservers = new Map<string, SharedObserver>()

function getRootKey(root: ObserverRoot, margin: number): string {
  if (!root) {
    return `${NULL_ROOT_KEY}:${margin}`
  }
  let id = rootIds.get(root)
  if (id === undefined) {
    id = ++sharedRootId
    rootIds.set(root, id)
  }
  return `${id}:${margin}`
}

function createSharedObserver(root: ObserverRoot, margin: number): SharedObserver {
  const listeners = new Map<Element, Set<IntersectionCallback>>()
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const callbacks = listeners.get(entry.target as Element)
        if (!callbacks) return
        callbacks.forEach((fn) => fn(entry))
      })
    },
    {
      root: root ?? undefined,
      rootMargin: `${margin}px 0px ${margin}px 0px`,
    },
  )
  return { observer, listeners }
}

function shouldRenderEntry(entry: IntersectionObserverEntry) {
  const rootBounds = entry.rootBounds
  if (!rootBounds) {
    return entry.isIntersecting
  }

  // Above the root: compare bottom edge to root top.
  if (entry.boundingClientRect.bottom < rootBounds.top) {
    const distance = rootBounds.top - entry.boundingClientRect.bottom
    return distance <= VISIBILITY_BUFFER_PX
  }

  // Below the root: compare top edge to root bottom.
  if (entry.boundingClientRect.top > rootBounds.bottom) {
    const distance = entry.boundingClientRect.top - rootBounds.bottom
    return distance <= VISIBILITY_BUFFER_PX
  }

  // Overlapping the root bounds.
  return true
}

function getViewportRect(): { top: number; bottom: number } {
  if (typeof window === "undefined") {
    return { top: 0, bottom: 0 }
  }
  return { top: 0, bottom: window.innerHeight }
}

function isRenderableRoot(root: ObserverRoot): boolean {
  if (!root) return true
  if (root instanceof Document) return true
  if (typeof window === "undefined") return false

  const element = root as Element
  const style = window.getComputedStyle(element as Element)
  if (style.display === "none" || style.visibility === "hidden") {
    return false
  }
  const rect = (element as Element).getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function shouldRenderByRects(params: {
  wrapperRect: DOMRect
  rootRect: { top: number; bottom: number }
  margin: number
}): boolean {
  const { wrapperRect, rootRect, margin } = params
  const threshold = margin + VISIBILITY_BUFFER_PX

  // Above the root: compare bottom edge to root top.
  if (wrapperRect.bottom < rootRect.top) {
    const distance = rootRect.top - wrapperRect.bottom
    return distance <= threshold
  }

  // Below the root: compare top edge to root bottom.
  if (wrapperRect.top > rootRect.bottom) {
    const distance = wrapperRect.top - rootRect.bottom
    return distance <= threshold
  }

  return true
}

function subscribeToSharedObserver(
  target: Element,
  root: ObserverRoot,
  margin: number,
  callback: IntersectionCallback,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    callback({ isIntersecting: true } as IntersectionObserverEntry)
    return () => {}
  }
  const key = getRootKey(root, margin)
  let shared = sharedObservers.get(key)
  if (!shared) {
    shared = createSharedObserver(root, margin)
    sharedObservers.set(key, shared)
  }
  let targetCallbacks = shared.listeners.get(target)
  if (!targetCallbacks) {
    targetCallbacks = new Set()
    shared.listeners.set(target, targetCallbacks)
    shared.observer.observe(target)
  }
  targetCallbacks.add(callback)
  return () => {
    const current = shared?.listeners.get(target)
    if (current) {
      current.delete(callback)
      if (current.size === 0) {
        shared?.listeners.delete(target)
        shared?.observer.unobserve(target)
      }
    }
    if (shared && shared.listeners.size === 0) {
      shared.observer.disconnect()
      sharedObservers.delete(key)
    }
  }
}

interface VirtualItemProps {
  cacheKey: string
  children: JSX.Element | (() => JSX.Element)
  scrollContainer?: Accessor<HTMLElement | undefined | null>
  threshold?: number
  minPlaceholderHeight?: number
  class?: string
  contentClass?: string
  placeholderClass?: string
  virtualizationEnabled?: Accessor<boolean>
  forceVisible?: Accessor<boolean>
  suspendMeasurements?: Accessor<boolean>
  onMeasured?: () => void
  onHeightChange?: (nextHeight: number, previousHeight: number) => void
  id?: string
}

export default function VirtualItem(props: VirtualItemProps) {
  const resolveContent = () => (typeof props.children === "function" ? (props.children as () => JSX.Element)() : props.children)
  const cachedHeight = sizeCache.get(props.cacheKey)
  // Default to hidden until we can determine visibility.
  // This avoids keeping heavy DOM alive when IntersectionObserver
  // doesn't fire (common for hidden/zero-sized scroll roots).
  const [isIntersecting, setIsIntersecting] = createSignal(false)
  const [measuredHeight, setMeasuredHeight] = createSignal(cachedHeight ?? 0)
  const [hasMeasured, setHasMeasured] = createSignal(cachedHeight !== undefined)
  let hasReportedMeasurement = Boolean(cachedHeight && cachedHeight > 0)
  let pendingVisibility: boolean | null = null
  let visibilityFrame: number | null = null
  const flushVisibility = () => {
    if (visibilityFrame !== null) {
      cancelAnimationFrame(visibilityFrame)
      visibilityFrame = null
    }
    if (pendingVisibility !== null) {
      setIsIntersecting(pendingVisibility)
      pendingVisibility = null
    }
  }
  const queueVisibility = (nextValue: boolean) => {
    pendingVisibility = nextValue
    if (visibilityFrame !== null) return
    visibilityFrame = requestAnimationFrame(() => {
      visibilityFrame = null
      if (pendingVisibility !== null) {
        setIsIntersecting(pendingVisibility)
        pendingVisibility = null
      }
    })
  }
  const virtualizationEnabled = () => (props.virtualizationEnabled ? props.virtualizationEnabled() : true)
  const measurementsSuspended = () => Boolean(props.suspendMeasurements?.())
  const shouldHideContent = createMemo(() => {
    if (props.forceVisible?.()) return false
    if (!virtualizationEnabled()) return false
    return !isIntersecting()
  })
 
   let wrapperRef: HTMLDivElement | undefined
 
  let contentRef: HTMLDivElement | undefined

  let resizeObserver: ResizeObserver | undefined
  let intersectionCleanup: (() => void) | undefined

  function cleanupResizeObserver() {
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = undefined
    }
  }

  function cleanupIntersectionObserver() {
    if (intersectionCleanup) {
      intersectionCleanup()
      intersectionCleanup = undefined
    }
  }

  function persistMeasurement(nextHeight: number) {
    if (!Number.isFinite(nextHeight) || nextHeight < 0) {
      return
    }
    const before = measuredHeight()
    const normalized = nextHeight
    const previous = sizeCache.get(props.cacheKey) ?? measuredHeight()
    // Only keep the previous measurement when the element reports 0 height.
    // Allow shrinkage so placeholder height matches real content height;
    // keeping the max height can cause mount/unmount jitter near the
    // virtualization boundary.
    const shouldKeepPrevious = previous > 0 && normalized === 0
    if (shouldKeepPrevious) {
      if (!hasReportedMeasurement) {
        hasReportedMeasurement = true
        props.onMeasured?.()
      }
      setHasMeasured(true)
      sizeCache.set(props.cacheKey, previous)
      setMeasuredHeight(previous)
      if (previous !== before) props.onHeightChange?.(previous, before)
      return
    }
    if (normalized > 0) {
      sizeCache.set(props.cacheKey, normalized)
      setHasMeasured(true)
      if (!hasReportedMeasurement) {
        hasReportedMeasurement = true
        props.onMeasured?.()
      }
    }
    setMeasuredHeight(normalized)
    if (normalized !== before) props.onHeightChange?.(normalized, before)
  }

  function updateMeasuredHeight() {
    if (!contentRef || measurementsSuspended()) return
    // Prefer subpixel-accurate height for scroll compensation.
    // offsetHeight rounds to integers which can accumulate error.
    const rect = contentRef.getBoundingClientRect()
    const next = Math.max(0, Math.round(rect.height * 2) / 2)
    if (next === measuredHeight()) return
    persistMeasurement(next)
  }
 
  function setupResizeObserver() {
    if (!contentRef || measurementsSuspended()) return
    cleanupResizeObserver()
    if (typeof ResizeObserver === "undefined") {
      updateMeasuredHeight()
      return
    }
    resizeObserver = new ResizeObserver(() => {
      if (measurementsSuspended()) return
      updateMeasuredHeight()
    })
    resizeObserver.observe(contentRef)
  }


  function refreshIntersectionObserver(targetRoot: Element | Document | null) {
    cleanupIntersectionObserver()
    if (!wrapperRef) {
      setIsIntersecting(false)
      return
    }
    if (typeof IntersectionObserver === "undefined") {
      setIsIntersecting(true)
      return
    }

    const margin = props.threshold ?? DEFAULT_MARGIN_PX

    // If the scroll root is hidden / 0x0, IntersectionObserver can report
    // `isIntersecting` in unexpected ways (often "true" with null rootBounds),
    // which keeps heavy DOM alive in background tabs.
    //
    // In that state, force-hide and skip attaching the observer. When the
    // pane becomes visible again, VirtualItem will re-run this setup and
    // re-attach the observer.
    const renderable = isRenderableRoot(targetRoot)
    if (!renderable) {
      setIsIntersecting(false)
      return
    }

    // Avoid doing an eager geometry read here.
    // During large list hydration / initial layout, wrapper rects can be
    // transiently 0/incorrect and cause many offscreen items to mount.
    // Rely on the observer callback (which we harden below) to determine
    // visibility.

    const wrapperEl = wrapperRef
    intersectionCleanup = subscribeToSharedObserver(wrapperEl, targetRoot, margin, (entry) => {
      // IntersectionObserver can produce transient false-positives during pane
      // activation/layout transitions (e.g. `isIntersecting: true` for items far
      // outside the scroll root). For element roots, prefer explicit rect math.
      if (targetRoot && !(targetRoot instanceof Document)) {
        // When rootBounds is null we cannot trust the entry; treat as hidden.
        if (entry.rootBounds === null) {
          queueVisibility(false)
          return
        }
        try {
          const rootRect = (targetRoot as Element).getBoundingClientRect()
          const visible = shouldRenderByRects({
            wrapperRect: wrapperEl.getBoundingClientRect(),
            rootRect: { top: rootRect.top, bottom: rootRect.bottom },
            margin,
          })
          queueVisibility(visible)
          return
        } catch {
          // Fall through to the entry-based heuristic.
        }
      }

      const nextVisible = shouldRenderEntry(entry)
      queueVisibility(nextVisible)
    })
  }

  function setWrapperRef(element: HTMLDivElement | null) {
    wrapperRef = element ?? undefined
    const root = props.scrollContainer ? props.scrollContainer() : null
    refreshIntersectionObserver(root ?? null)
  }

  function setContentRef(element: HTMLDivElement | null) {
    contentRef = element ?? undefined
    if (contentRef) {
      queueMicrotask(() => {
        if (shouldHideContent() || measurementsSuspended()) return
        updateMeasuredHeight()
        setupResizeObserver()
      })
    } else {
      cleanupResizeObserver()
    }
  }
 
  
  createEffect(() => {
    if (shouldHideContent() || measurementsSuspended()) {
      cleanupResizeObserver()
    } else if (contentRef) {
      queueMicrotask(() => {
        updateMeasuredHeight()
        setupResizeObserver()
      })
    }
  })

 
  createEffect(() => {
    const key = props.cacheKey

    const cached = sizeCache.get(key)
    if (cached !== undefined) {
      setMeasuredHeight(cached)
      setHasMeasured(true)
    } else {
      setMeasuredHeight(0)
      setHasMeasured(false)
    }
  })

  createEffect(() => {
    measurementsSuspended()
    const root = props.scrollContainer ? props.scrollContainer() : null
    refreshIntersectionObserver(root ?? null)
  })

  const placeholderHeight = createMemo(() => {

    const seenHeight = measuredHeight()
    if (seenHeight > 0) {
      return seenHeight
    }
    return props.minPlaceholderHeight ?? MIN_PLACEHOLDER_HEIGHT
  })
 
  onCleanup(() => {
    cleanupResizeObserver()
    cleanupIntersectionObserver()
    flushVisibility()
  })
 
  const wrapperClass = () => ["virtual-item-wrapper", props.class].filter(Boolean).join(" ")
  const contentClass = () => {
    const classes = ["virtual-item-content", props.contentClass]
    if (shouldHideContent()) {
      classes.push("virtual-item-content-hidden")
    }
    return classes.filter(Boolean).join(" ")
  }
  const placeholderClass = () => ["virtual-item-placeholder", props.placeholderClass].filter(Boolean).join(" ")
  const lazyContent = createMemo<JSX.Element | null>(() => {
    if (shouldHideContent()) return null
    return resolveContent()
  })

  return (
    <div ref={setWrapperRef} id={props.id} class={wrapperClass()} style={{ width: "100%" }}>
      <div
        class={placeholderClass()}
        style={{
          width: "100%",
          height: shouldHideContent() ? `${placeholderHeight()}px` : undefined,
        }}
      >
        <div ref={setContentRef} class={contentClass()}>
          {lazyContent()}
        </div>
      </div>
    </div>
  )
}
