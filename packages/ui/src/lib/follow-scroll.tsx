import { createEffect, createSignal, onCleanup, type Accessor, type JSXElement } from "solid-js"
import { SCROLL_INTENT_KEYS, USER_SCROLL_INTENT_WINDOW_MS, VirtualScrollController, describeKeyTarget, getKeyboardScrollIntent, isAutoFollowing, isMiddleButtonScrollIntent, type ScrollControllerMetrics } from "../components/virtual-follow-behavior"
import { getElementZoom, wheelDeltaUnit } from "./scroll-gesture-routing"

interface FollowScrollOptions {
  getScrollTopSnapshot: Accessor<number>
  setScrollTopSnapshot: (next: number) => void
  sentinelClassName: string
}

export interface FollowScrollHelpers {
  registerContainer: (element: HTMLDivElement | null | undefined, options?: { disableTracking?: boolean }) => void
  handleScroll: (event: Event & { currentTarget: HTMLDivElement }) => void
  renderSentinel: (options?: { disableTracking?: boolean }) => JSXElement | null
  restoreAfterRender: () => void
  autoScroll: Accessor<boolean>
}

export function createFollowScroll(options: FollowScrollOptions): FollowScrollHelpers {
  const [scrollContainer, setScrollContainer] = createSignal<HTMLDivElement | undefined>()
  const [bottomSentinel, setBottomSentinel] = createSignal<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const scrollController = new VirtualScrollController(true)

  let scrollContainerRef: HTMLDivElement | undefined
  let detachScrollIntentListeners: (() => void) | undefined

  let pendingScrollFrame: number | null = null
  let pendingAnchorScroll: number | null = null
  let lastKnownScrollTop = options.getScrollTopSnapshot()
  let suppressNextScrollHandling = false

  function restoreScrollPosition(forceBottom = false) {
    const container = scrollContainerRef
    if (!container) return
    suppressNextScrollHandling = true
    if (forceBottom) {
      container.scrollTop = container.scrollHeight
      lastKnownScrollTop = container.scrollTop
      options.setScrollTopSnapshot(lastKnownScrollTop)
    } else {
      container.scrollTop = lastKnownScrollTop
    }
    scrollController.recordProgrammaticOffset(lastKnownScrollTop)
  }

  function persistScrollSnapshot(element?: HTMLElement | null) {
    if (!element) return
    lastKnownScrollTop = element.scrollTop
    options.setScrollTopSnapshot(lastKnownScrollTop)
  }

  function markUserScrollIntent(direction: "up" | "down" | null, distance = 0) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    const container = scrollContainerRef
    // Upward intent takes ownership immediately, even if native middle-button
    // autoscroll waits longer than the intent deadline before its first scroll
    // event; a downward gesture reaching the bottom resumes follow (shared rule).
    const result = scrollController.userGesture(direction, now + USER_SCROLL_INTENT_WINDOW_MS, container ? getMetrics(container) : null, distance)
    setAutoScroll(isAutoFollowing(result.state.mode))
    if (direction === "up") {
      suppressNextScrollHandling = false
      if (pendingScrollFrame !== null) cancelAnimationFrame(pendingScrollFrame)
      if (pendingAnchorScroll !== null) cancelAnimationFrame(pendingAnchorScroll)
      pendingScrollFrame = pendingAnchorScroll = null
    }
  }

  function attachScrollIntentListeners(element: HTMLDivElement) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    const handlePointerIntent = (event: WheelEvent | PointerEvent | TouchEvent) => {
      if (event instanceof WheelEvent) {
        markUserScrollIntent(event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : null, event.deltaY * wheelDeltaUnit(event, element))
        return
      }
      markUserScrollIntent(event instanceof PointerEvent && isMiddleButtonScrollIntent(event.button) ? "up" : null)
    }
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !SCROLL_INTENT_KEYS.has(event.key)) return
      const intent = getKeyboardScrollIntent({
        key: event.key,
        shiftKey: event.shiftKey,
        ...describeKeyTarget(event.target),
        viewportHeight: element.clientHeight,
        zoom: getElementZoom(element),
        devicePixelRatio: window.devicePixelRatio,
      })
      if (!intent) return
      // Home/End scroll natively here; End reaches the bottom whatever its distance.
      if (intent.type === "direction") markUserScrollIntent(intent.direction, intent.distance)
      else markUserScrollIntent(intent.type === "top" ? "up" : "down", intent.type === "top" ? 0 : Number.POSITIVE_INFINITY)
    }
    element.addEventListener("wheel", handlePointerIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("touchstart", handlePointerIntent, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handlePointerIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("touchstart", handlePointerIntent)
      element.removeEventListener("keydown", handleKeyIntent)
    }
  }

  function scheduleAnchorScroll(immediate = false) {
    if (!autoScroll()) return
    const sentinel = bottomSentinel()
    const container = scrollContainerRef
    if (!sentinel || !container) return
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
      pendingAnchorScroll = null
    }
    pendingAnchorScroll = requestAnimationFrame(() => {
      pendingAnchorScroll = null
      if (!autoScroll() || scrollContainerRef !== container) return
      const containerRect = container.getBoundingClientRect()
      const sentinelRect = sentinel.getBoundingClientRect()
      const delta = sentinelRect.bottom - containerRect.bottom
      if (delta > 1) {
        suppressNextScrollHandling = true
        container.scrollBy({ top: delta, behavior: immediate ? "auto" : "smooth" })
      }
      lastKnownScrollTop = container.scrollTop
      options.setScrollTopSnapshot(lastKnownScrollTop)
      scrollController.recordProgrammaticOffset(lastKnownScrollTop)
    })
  }

  function getMetrics(container: HTMLDivElement): ScrollControllerMetrics {
    return {
      offset: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    }
  }

  function updateFollowModeFromScroll(containerOverride?: HTMLDivElement) {
    const container = containerOverride ?? scrollContainer()
    if (!container) return
    if (suppressNextScrollHandling) {
      suppressNextScrollHandling = false
      return
    }
    const result = scrollController.observeViewport(getMetrics(container), typeof performance !== "undefined" ? performance.now() : Date.now(), false)
    setAutoScroll(isAutoFollowing(result.state.mode))
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    updateFollowModeFromScroll(event.currentTarget)
    persistScrollSnapshot(event.currentTarget)
  }

  const registerContainer = (element: HTMLDivElement | null | undefined, config?: { disableTracking?: boolean }) => {
    const next = config?.disableTracking ? undefined : element || undefined
    if (next === scrollContainerRef) {
      return
    }
    scrollContainerRef = next
    setScrollContainer(scrollContainerRef)
    if (scrollContainerRef) {
      lastKnownScrollTop = options.getScrollTopSnapshot()
      restoreScrollPosition(autoScroll())
    }
  }

  const renderSentinel = (config?: { disableTracking?: boolean }) => {
    if (config?.disableTracking) return null
    return <div ref={setBottomSentinel} aria-hidden="true" class={options.sentinelClassName} style={{ height: "1px" }} />
  }

  const restoreAfterRender = () => {
    const container = scrollContainerRef
    if (!container) return

    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    const result = scrollController.observeViewport(getMetrics(container), now, false)
    setAutoScroll(isAutoFollowing(result.state.mode))
    // Never let a render-time caller force follow mode back on after the user
    // has already escaped it. Staying pinned should depend on the current
    // follow state at execution, not a value captured before pointer input.
    if (pendingScrollFrame !== null) cancelAnimationFrame(pendingScrollFrame)
    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = null
      if (scrollContainerRef !== container) return
      const shouldFollow = autoScroll()
      restoreScrollPosition(shouldFollow)
      if (shouldFollow) {
        scheduleAnchorScroll(true)
      }
    })
  }

  createEffect(() => {
    const container = scrollContainer()
    if (!container) return
    attachScrollIntentListeners(container)
    onCleanup(() => {
      if (detachScrollIntentListeners) {
        detachScrollIntentListeners()
        detachScrollIntentListeners = undefined
      }
    })
  })

  onCleanup(() => {
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
      pendingScrollFrame = null
    }
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
      pendingAnchorScroll = null
    }
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
  })

  return {
    registerContainer,
    handleScroll,
    renderSentinel,
    restoreAfterRender,
    autoScroll,
  }
}
