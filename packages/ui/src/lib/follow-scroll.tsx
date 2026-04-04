import { createEffect, createSignal, onCleanup, type Accessor, type JSXElement } from "solid-js"

const DEFAULT_SCROLL_INTENT_WINDOW_MS = 600
const DEFAULT_SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])

interface FollowScrollOptions {
  getScrollTopSnapshot: Accessor<number>
  setScrollTopSnapshot: (next: number) => void
  sentinelMarginPx: number
  sentinelClassName: string
  intentWindowMs?: number
  intentKeys?: ReadonlySet<string>
}

export interface FollowScrollHelpers {
  registerContainer: (element: HTMLDivElement | null | undefined, options?: { disableTracking?: boolean }) => void
  handleScroll: (event: Event & { currentTarget: HTMLDivElement }) => void
  renderSentinel: (options?: { disableTracking?: boolean }) => JSXElement | null
  restoreAfterRender: (options?: { forceBottom?: boolean }) => void
  autoScroll: Accessor<boolean>
}

export function createFollowScroll(options: FollowScrollOptions): FollowScrollHelpers {
  const [scrollContainer, setScrollContainer] = createSignal<HTMLDivElement | undefined>()
  const [bottomSentinel, setBottomSentinel] = createSignal<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [bottomSentinelVisible, setBottomSentinelVisible] = createSignal(true)

  let scrollContainerRef: HTMLDivElement | undefined
  let detachScrollIntentListeners: (() => void) | undefined

  let pendingScrollFrame: number | null = null
  let pendingAnchorScroll: number | null = null
  let userScrollIntentUntil = 0
  let lastKnownScrollTop = options.getScrollTopSnapshot()
  let pointerInteractionActive = false
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
  }

  function persistScrollSnapshot(element?: HTMLElement | null) {
    if (!element) return
    lastKnownScrollTop = element.scrollTop
    options.setScrollTopSnapshot(lastKnownScrollTop)
  }

  function markUserScrollIntent() {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    userScrollIntentUntil = now + (options.intentWindowMs ?? DEFAULT_SCROLL_INTENT_WINDOW_MS)
  }

  function hasUserScrollIntent() {
    if (pointerInteractionActive) {
      return true
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    return now <= userScrollIntentUntil
  }

  function attachScrollIntentListeners(element: HTMLDivElement) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    const intentKeys = options.intentKeys ?? DEFAULT_SCROLL_INTENT_KEYS
    const handlePointerIntent = () => {
      pointerInteractionActive = true
      markUserScrollIntent()
    }
    const clearPointerIntent = () => {
      pointerInteractionActive = false
    }
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (intentKeys.has(event.key)) {
        markUserScrollIntent()
      }
    }
    element.addEventListener("wheel", handlePointerIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("touchstart", handlePointerIntent, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    if (typeof window !== "undefined") {
      window.addEventListener("pointerup", clearPointerIntent)
      window.addEventListener("pointercancel", clearPointerIntent)
      window.addEventListener("mouseup", clearPointerIntent)
      window.addEventListener("touchend", clearPointerIntent)
      window.addEventListener("touchcancel", clearPointerIntent)
    }
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handlePointerIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("touchstart", handlePointerIntent)
      element.removeEventListener("keydown", handleKeyIntent)
      if (typeof window !== "undefined") {
        window.removeEventListener("pointerup", clearPointerIntent)
        window.removeEventListener("pointercancel", clearPointerIntent)
        window.removeEventListener("mouseup", clearPointerIntent)
        window.removeEventListener("touchend", clearPointerIntent)
        window.removeEventListener("touchcancel", clearPointerIntent)
      }
      pointerInteractionActive = false
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
      const delta = sentinelRect.bottom - containerRect.bottom + options.sentinelMarginPx
      if (Math.abs(delta) > 1) {
        suppressNextScrollHandling = true
        container.scrollBy({ top: delta, behavior: immediate ? "auto" : "smooth" })
      }
      lastKnownScrollTop = container.scrollTop
      options.setScrollTopSnapshot(lastKnownScrollTop)
    })
  }

  function isAtBottom(container: HTMLDivElement) {
    return container.scrollHeight - (container.scrollTop + container.clientHeight) <= options.sentinelMarginPx
  }

  function updateFollowModeFromScroll(containerOverride?: HTMLDivElement) {
    const container = containerOverride ?? scrollContainer()
    if (!container) return
    if (suppressNextScrollHandling) {
      suppressNextScrollHandling = false
      return
    }
    const isUserScroll = hasUserScrollIntent()
    const atBottomFromScroll = isAtBottom(container)
    const atBottom = atBottomFromScroll || bottomSentinelVisible()

    if (isUserScroll || !atBottom) {
      if (atBottom) {
        if (!autoScroll()) setAutoScroll(true)
      } else if (autoScroll()) {
        setAutoScroll(false)
      }
    }
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    updateFollowModeFromScroll(event.currentTarget)
    persistScrollSnapshot(event.currentTarget)
  }

  const registerContainer = (element: HTMLDivElement | null | undefined, config?: { disableTracking?: boolean }) => {
    if (config?.disableTracking) return
    const next = element || undefined
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

  const restoreAfterRender = (config?: { forceBottom?: boolean }) => {
    const container = scrollContainerRef
    if (container && hasUserScrollIntent() && !isAtBottom(container)) {
      if (autoScroll()) {
        setAutoScroll(false)
      }
      requestAnimationFrame(() => {
        restoreScrollPosition(false)
      })
      return
    }

    const shouldFollow = config?.forceBottom ?? autoScroll()
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

  createEffect(() => {
    const container = scrollContainer()
    const sentinel = bottomSentinel()
    if (!container || !sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.target === sentinel) {
            setBottomSentinelVisible(entry.isIntersecting)
          }
        })
      },
      { root: container, threshold: 0, rootMargin: `0px 0px ${options.sentinelMarginPx}px 0px` },
    )
    observer.observe(sentinel)
    onCleanup(() => observer.disconnect())
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
