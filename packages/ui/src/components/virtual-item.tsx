import { JSX, Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

const sizeCache = new Map<string, number>()
const DEFAULT_MARGIN_PX = 600
const MIN_PLACEHOLDER_HEIGHT = 400
const VISIBILITY_BUFFER_PX = 0

// ── Batched ResizeObserver measurement coordinator ──
// When multiple items resize simultaneously (session switch, streaming),
// each would independently call getBoundingClientRect() forcing separate
// layouts. Instead, we collect pending measurements and process them in
// one RAF: all reads first, then all writes.
type MeasurementCallback = (height: number) => void
const pendingMeasurements = new Map<HTMLElement, MeasurementCallback>()
let measureRAF: number | null = null

function requestBatchedMeasurement(element: HTMLElement, callback: MeasurementCallback) {
  pendingMeasurements.set(element, callback)
  if (measureRAF !== null) return
  measureRAF = requestAnimationFrame(flushBatchedMeasurements)
}

function flushBatchedMeasurements() {
  measureRAF = null
  if (pendingMeasurements.size === 0) return

  // Phase 1: batch all layout reads
  const readings = new Map<HTMLElement, number>()
  for (const [element] of pendingMeasurements) {
    const rect = element.getBoundingClientRect()
    readings.set(element, Math.max(0, Math.round(rect.height * 2) / 2))
  }

  // Phase 2: batch all callbacks (state writes)
  // Copy entries first since callbacks may re-register
  const entries = Array.from(pendingMeasurements.entries())
  pendingMeasurements.clear()
  for (const [element, callback] of entries) {
    const height = readings.get(element)
    if (height !== undefined) {
      callback(height)
    }
  }
}

// ── Deferred ResizeObserver.observe() coordinator ──
// When N VirtualItems mount simultaneously (session switch), each calls
// resizeObserver.observe(element) which forces the browser to compute the
// element's initial size — triggering a synchronous layout per item.
// By deferring all observe() calls to a single RAF, the browser can batch
// the initial size computation into one layout pass.
type DeferredObserve = { observer: ResizeObserver; element: HTMLElement; cancelled: boolean }
const pendingObserves: DeferredObserve[] = []
let observeRAF: number | null = null

function requestDeferredObserve(observer: ResizeObserver, element: HTMLElement): DeferredObserve {
  const entry: DeferredObserve = { observer, element, cancelled: false }
  pendingObserves.push(entry)
  if (observeRAF === null) {
    observeRAF = requestAnimationFrame(flushDeferredObserves)
  }
  return entry
}

function flushDeferredObserves() {
  observeRAF = null
  const batch = pendingObserves.splice(0)
  for (const entry of batch) {
    if (!entry.cancelled) {
      entry.observer.observe(entry.element)
    }
  }
}

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

// Cache isRenderableRoot results per-frame so that N VirtualItems mounting
// in the same frame don't each force getComputedStyle + getBoundingClientRect
// on the same root element.
let renderableRootCache = new WeakMap<Element, boolean>()
let renderableRootCacheFrame: number | null = null

function isRenderableRoot(root: ObserverRoot): boolean {
  if (!root) return true
  if (root instanceof Document) return true
  if (typeof window === "undefined") return false

  const element = root as Element

  // Invalidate cache each frame
  const now = typeof performance !== "undefined" ? performance.now() : 0
  if (renderableRootCacheFrame === null || now - renderableRootCacheFrame > 16) {
    renderableRootCache = new WeakMap<Element, boolean>()
    renderableRootCacheFrame = now
  }

  const cached = renderableRootCache.get(element)
  if (cached !== undefined) return cached

  const style = window.getComputedStyle(element)
  if (style.display === "none" || style.visibility === "hidden") {
    renderableRootCache.set(element, false)
    return false
  }
  const rect = element.getBoundingClientRect()
  const result = rect.width > 0 && rect.height > 0
  renderableRootCache.set(element, result)
  return result
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
  onHeightChange?: (nextHeight: number, previousHeight: number, meta: VirtualItemHeightChangeMeta) => void
  id?: string
}

export interface VirtualItemHeightChangeMeta {
  source: "initial-visible-measure" | "resize"
  previousCachedHeight: number | null
  isStaleCacheCorrection: boolean
  wasHidden: boolean
}

export default function VirtualItem(props: VirtualItemProps) {
  const resolveContent = () => (typeof props.children === "function" ? (props.children as () => JSX.Element)() : props.children)
  const cachedHeight = sizeCache.get(props.cacheKey)
  const fallbackPlaceholderHeight = () => props.minPlaceholderHeight ?? MIN_PLACEHOLDER_HEIGHT
  // Default to hidden until we can determine visibility.
  // This avoids keeping heavy DOM alive when IntersectionObserver
  // doesn't fire (common for hidden/zero-sized scroll roots).
  const [isIntersecting, setIsIntersecting] = createSignal(false)
  // Keep measuredHeight aligned with the *effective layout height* while hidden.
  // When content first mounts, onHeightChange deltas should reflect the DOM's
  // placeholder height (not 0), otherwise scroll compensation can overshoot.
  const [measuredHeight, setMeasuredHeight] = createSignal(cachedHeight ?? fallbackPlaceholderHeight())
  let hasReportedMeasurement = Boolean(cachedHeight && cachedHeight > 0)
  let pendingVisibility: boolean | null = null
  let visibilityFrame: number | null = null
  let awaitingVisibleMeasurement = true
  let lastMeasurementWhileHidden = true
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
  const forceVisible = () => Boolean(props.forceVisible?.())
  const shouldHideContent = createMemo(() => {
    if (forceVisible()) return false
    if (!virtualizationEnabled()) return false
    return !isIntersecting()
  })

  let wrapperRef: HTMLDivElement | undefined
  let contentRef: HTMLDivElement | undefined

  let resizeObserver: ResizeObserver | undefined
  let pendingDeferredObserve: DeferredObserve | undefined
  let intersectionCleanup: (() => void) | undefined

  function cleanupResizeObserver() {
    if (pendingDeferredObserve) {
      pendingDeferredObserve.cancelled = true
      pendingDeferredObserve = undefined
    }
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = undefined
    }
  }

  function scheduleVisibleMeasurements() {
    if (shouldHideContent() || measurementsSuspended()) return
    if (!contentRef) return
    requestAnimationFrame(() => {
      if (shouldHideContent() || measurementsSuspended()) return
      if (!contentRef) return
      updateMeasuredHeight()
      setupResizeObserver()
    })
  }

  function cleanupIntersectionObserver() {
    if (intersectionCleanup) {
      intersectionCleanup()
      intersectionCleanup = undefined
    }
  }

  function persistMeasurement(nextHeight: number, meta?: { source: "initial-visible-measure" | "resize"; wasHidden: boolean }) {
    if (!Number.isFinite(nextHeight) || nextHeight < 0) {
      return
    }
    const before = measuredHeight()
    const normalized = nextHeight
    const previousCachedHeight = sizeCache.get(props.cacheKey) ?? null
    const previous = previousCachedHeight ?? measuredHeight()
    const measurementMeta: VirtualItemHeightChangeMeta = {
      source: meta?.source ?? "resize",
      previousCachedHeight,
      isStaleCacheCorrection:
        (meta?.source ?? "resize") === "initial-visible-measure" &&
        previousCachedHeight !== null &&
        normalized > 0 &&
        Math.abs(normalized - previousCachedHeight) > 1,
      wasHidden: meta?.wasHidden ?? shouldHideContent(),
    }
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
      sizeCache.set(props.cacheKey, previous)
      setMeasuredHeight(previous)
      if (previous !== before) props.onHeightChange?.(previous, before, measurementMeta)
      return
    }
    if (normalized > 0) {
      sizeCache.set(props.cacheKey, normalized)
      if (!hasReportedMeasurement) {
        hasReportedMeasurement = true
        props.onMeasured?.()
      }
    }
    setMeasuredHeight(normalized)
    if (normalized !== before) props.onHeightChange?.(normalized, before, measurementMeta)
  }

  function updateMeasuredHeight(preReadHeight?: number) {
    if (!contentRef) return
    if (measurementsSuspended()) return
    // Prefer subpixel-accurate height for scroll compensation.
    // offsetHeight rounds to integers which can accumulate error.
    const next = preReadHeight ?? Math.max(0, Math.round(contentRef.getBoundingClientRect().height * 2) / 2)
    const currentMeasured = measuredHeight()
    const measurementSource: "initial-visible-measure" | "resize" = awaitingVisibleMeasurement ? "initial-visible-measure" : "resize"
    const wasHidden = lastMeasurementWhileHidden
    if (measurementSource === "initial-visible-measure") {
      awaitingVisibleMeasurement = false
      lastMeasurementWhileHidden = false
    }
    if (next === currentMeasured) return
    persistMeasurement(next, { source: measurementSource, wasHidden })
  }

  function setupResizeObserver() {
    if (!contentRef || measurementsSuspended()) return
    cleanupResizeObserver()
    if (typeof ResizeObserver === "undefined") {
      updateMeasuredHeight()
      return
    }
    const ref = contentRef
    resizeObserver = new ResizeObserver(() => {
      if (measurementsSuspended()) return
      // Batch layout reads across all VirtualItems to avoid per-item
      // forced layout. The coordinator reads all rects in one pass,
      // then delivers heights via callback.
      requestBatchedMeasurement(ref, (height) => {
        updateMeasuredHeight(height)
      })
    })
    pendingDeferredObserve = requestDeferredObserve(resizeObserver, contentRef)
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
      // When rootBounds is null (e.g. hidden/0x0 root during pane transitions)
      // we cannot trust the entry; treat as hidden.
      if (targetRoot && !(targetRoot instanceof Document) && entry.rootBounds === null) {
        queueVisibility(false)
        return
      }

      // Use the rects already provided by the IntersectionObserver entry
      // instead of forcing synchronous layout via getBoundingClientRect().
      // shouldRenderEntry applies the same distance-based visibility check
      // using entry.boundingClientRect and entry.rootBounds.
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
      // Defer initial measurement + observer setup to RAF so that when
      // N items mount simultaneously (session switch), we avoid N
      // individual forced layouts from queueMicrotask (which runs
      // synchronously within the same task).
      requestAnimationFrame(() => {
        if (shouldHideContent() || measurementsSuspended()) return
        if (!contentRef) return
        updateMeasuredHeight()
        setupResizeObserver()
      })
    } else {
      cleanupResizeObserver()
    }
  }
  createEffect(() => {
    const hidden = shouldHideContent()
    if (hidden) {
      awaitingVisibleMeasurement = true
      lastMeasurementWhileHidden = true
    }
    if (hidden || measurementsSuspended()) {
      cleanupResizeObserver()
    }
    if (!hidden && !measurementsSuspended() && contentRef) {
      scheduleVisibleMeasurements()
    }
  })

  
  createEffect(() => {
    const key = props.cacheKey

    const cached = sizeCache.get(key)
    if (cached !== undefined) {
      setMeasuredHeight(cached)
    } else {
      setMeasuredHeight(fallbackPlaceholderHeight())
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
