import { createEffect, createSignal, onCleanup, type Accessor, type JSXElement } from "solid-js"
import { BOTTOM_FOLLOW_EPSILON_PX, VirtualScrollController, isAutoFollowing, type ScrollControllerMetrics } from "../components/virtual-follow-behavior"

const DEFAULT_SCROLL_INTENT_WINDOW_MS = 600
const DEFAULT_SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])

interface FollowScrollOptions {
  getScrollTopSnapshot: Accessor<number>
  setScrollTopSnapshot: (next: number) => void
  sentinelClassName: string
  intentWindowMs?: number
  intentKeys?: ReadonlySet<string>
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
      scrollController.recordProgrammaticOffset(lastKnownScrollTop, true)
    } else {
      container.scrollTop = lastKnownScrollTop
      scrollController.recordProgrammaticOffset(lastKnownScrollTop, isAtBottom(container))
    }
  }

  function persistScrollSnapshot(element?: HTMLElement | null) {
    if (!element) return
    lastKnownScrollTop = element.scrollTop
    options.setScrollTopSnapshot(lastKnownScrollTop)
  }

  function markUserScrollIntent(direction: "up" | "down" | null) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    scrollController.setUserIntent(direction, now + (options.intentWindowMs ?? DEFAULT_SCROLL_INTENT_WINDOW_MS))
  }

  function attachScrollIntentListeners(element: HTMLDivElement) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    const intentKeys = options.intentKeys ?? DEFAULT_SCROLL_INTENT_KEYS
    const handlePointerIntent = (event: WheelEvent | PointerEvent | TouchEvent) => {
      markUserScrollIntent(event instanceof WheelEvent ? (event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : null) : null)
    }
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (intentKeys.has(event.key)) {
        const direction =
          event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.shiftKey && (event.key === " " || event.key === "Spacebar"))
            ? "up"
            : "down"
        markUserScrollIntent(direction)
      }
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
      const containerRect = container.getBoundingClientRect()
      const sentinelRect = sentinel.getBoundingClientRect()
      const delta = sentinelRect.bottom - containerRect.bottom
      if (delta > 1) {
        suppressNextScrollHandling = true
        container.scrollBy({ top: delta, behavior: immediate ? "auto" : "smooth" })
      }
      lastKnownScrollTop = container.scrollTop
      options.setScrollTopSnapshot(lastKnownScrollTop)
      scrollController.recordProgrammaticOffset(lastKnownScrollTop, isAtBottom(container))
    })
  }

  function getMetrics(container: HTMLDivElement): ScrollControllerMetrics {
    return {
      offset: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      sentinelMarginPx: BOTTOM_FOLLOW_EPSILON_PX,
    }
  }

  function isAtBottom(container: HTMLDivElement) {
    return container.scrollHeight - (container.scrollTop + container.clientHeight) <= BOTTOM_FOLLOW_EPSILON_PX
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
    const hasFreshUpwardEscape = now <= result.state.userIntentUntil && result.state.userIntentDirection === "up" && result.state.mode.type === "escaped"
    if (hasFreshUpwardEscape) {
      requestAnimationFrame(() => {
        restoreScrollPosition(false)
      })
      return
    }

    // Never let a render-time caller force follow mode back on after the user
    // has already escaped it. Staying pinned should depend on the current
    // follow state, not on a caller opting into forceBottom.
    const shouldFollow = autoScroll()
    requestAnimationFrame(() => {
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
