import { Index, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import VirtualItem from "./virtual-item"

const DEFAULT_SCROLL_SENTINEL_MARGIN_PX = 48
const USER_SCROLL_INTENT_WINDOW_MS = 600
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])

export interface VirtualFollowListApi {
  scrollToTop: (opts?: { immediate?: boolean }) => void
  scrollToBottom: (opts?: { immediate?: boolean; suppressAutoAnchor?: boolean }) => void
  scrollToKey: (
    key: string,
    opts?: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition; setAutoScroll?: boolean },
  ) => void
  notifyContentRendered: () => void
  setAutoScroll: (enabled: boolean) => void
  getAutoScroll: () => boolean
  getScrollElement: () => HTMLDivElement | undefined
  getShellElement: () => HTMLDivElement | undefined
}

export interface VirtualFollowListState {
  autoScroll: Accessor<boolean>
  showScrollTopButton: Accessor<boolean>
  showScrollBottomButton: Accessor<boolean>
  scrollButtonsCount: Accessor<number>
  activeKey: Accessor<string | null>
}

export interface VirtualFollowListProps<T> {
  items: Accessor<T[]>
  getKey: (item: T, index: number) => string
  renderItem: (item: T, index: number) => JSX.Element

  /**
   * Optional stable DOM id for the item wrapper.
   * Defaults to the key itself.
   */
  getAnchorId?: (key: string) => string

  /**
   * Decode an item key from an observed wrapper element id.
   * Defaults to identity.
   */
  getKeyFromAnchorId?: (anchorId: string) => string

  overscanPx?: number
  scrollSentinelMarginPx?: number
  virtualizationEnabled?: Accessor<boolean>
  suspendMeasurements?: Accessor<boolean>
  loading?: Accessor<boolean>
  isActive?: Accessor<boolean>

  /**
   * If this value changes and autoScroll is enabled, the list will
   * anchor-scroll to the bottom (unless suppressed).
   */
  followToken?: Accessor<string | number>

  /**
   * Optional hooks to render content inside the scroll container.
   * Useful for empty/loading states that should scroll with the list.
   */
  renderBeforeItems?: Accessor<JSX.Element>

  /**
   * Render content inside the shell, above timeline/sidebar layers.
   * (Quote popovers, etc.)
   */
  renderOverlay?: Accessor<JSX.Element>

  /**
   * Provide localized labels for built-in controls.
   */
  scrollToTopAriaLabel?: Accessor<string>
  scrollToBottomAriaLabel?: Accessor<string>

  /**
   * Receive element refs for external logic (selection, geometry, etc.)
   */
  onScrollElementChange?: (element: HTMLDivElement | undefined) => void
  onShellElementChange?: (element: HTMLDivElement | undefined) => void

  /**
   * Callbacks for consumers.
   */
  onScroll?: () => void
  onMouseUp?: (event: MouseEvent) => void
  onActiveKeyChange?: (key: string | null) => void
  registerApi?: (api: VirtualFollowListApi) => void
  registerState?: (state: VirtualFollowListState) => void
  renderControls?: (state: VirtualFollowListState, api: VirtualFollowListApi) => JSX.Element
}

export default function VirtualFollowList<T>(props: VirtualFollowListProps<T>) {
  const getAnchorId = (key: string) => (props.getAnchorId ? props.getAnchorId(key) : key)
  const getKeyFromAnchorId = (anchorId: string) => (props.getKeyFromAnchorId ? props.getKeyFromAnchorId(anchorId) : anchorId)

  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [shellElement, setShellElement] = createSignal<HTMLDivElement | undefined>()
  const [topSentinel, setTopSentinel] = createSignal<HTMLDivElement | null>(null)
  const [bottomSentinelSignal, setBottomSentinelSignal] = createSignal<HTMLDivElement | null>(null)
  const bottomSentinel = () => bottomSentinelSignal()

  const isActive = () => (props.isActive ? props.isActive() : true)
  const isLoading = () => Boolean(props.loading?.())
  const virtualizationEnabled = () => (props.virtualizationEnabled ? props.virtualizationEnabled() : true)
  const measurementsSuspended = () => Boolean(props.suspendMeasurements?.())

  const [autoScroll, setAutoScroll] = createSignal(true)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [topSentinelVisible, setTopSentinelVisible] = createSignal(true)
  const [bottomSentinelVisible, setBottomSentinelVisible] = createSignal(true)
  const [activeKey, setActiveKey] = createSignal<string | null>(null)

  const [anchorLock, setAnchorLock] = createSignal<{ key: string; block: ScrollLogicalPosition } | null>(null)

  const scrollButtonsCount = createMemo(() => (showScrollTopButton() ? 1 : 0) + (showScrollBottomButton() ? 1 : 0))

  let containerRef: HTMLDivElement | undefined
  let shellRef: HTMLDivElement | undefined
  let pendingScrollFrame: number | null = null
  let pendingAnchorScroll: number | null = null
  let pendingAnchorCorrectionFrame: number | null = null
  let pendingScrollCompensationScheduled = false
  let pendingScrollCompensations = new Map<string, number>()
  let scrollCompensationGen = 0
  let pendingActiveScroll = false
  let suppressAutoScrollOnce = false
  let pendingInitialScroll = true
  let scrollToBottomFrame: number | null = null
  let scrollToBottomDelayedFrame: number | null = null

  let lastKnownScrollTop = 0
  let lastUserScrollIntentDirection: "up" | "down" | null = null

  let userScrollIntentUntil = 0
  let detachScrollIntentListeners: (() => void) | undefined

  const state: VirtualFollowListState = {
    autoScroll,
    showScrollTopButton,
    showScrollBottomButton,
    scrollButtonsCount,
    activeKey,
  }

  function markUserScrollIntent(direction?: "up" | "down" | null) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    userScrollIntentUntil = now + USER_SCROLL_INTENT_WINDOW_MS
    if (direction) {
      lastUserScrollIntentDirection = direction
    }
  }

  function hasUserScrollIntent() {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    return now <= userScrollIntentUntil
  }

  function attachScrollIntentListeners(element: HTMLDivElement | undefined) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    if (!element) return
    const handleWheelIntent = (event: WheelEvent) => {
      const dir: "up" | "down" | null = event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : null
      markUserScrollIntent(dir)
    }
    const handlePointerIntent = () => markUserScrollIntent(null)
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (!SCROLL_INTENT_KEYS.has(event.key)) return
      const key = event.key
      const dir: "up" | "down" | null =
        key === "ArrowUp" || key === "PageUp" || key === "Home"
          ? "up"
          : key === "ArrowDown" || key === "PageDown" || key === "End"
            ? "down"
            : key === " " || key === "Spacebar"
              ? event.shiftKey
                ? "up"
                : "down"
              : null
      markUserScrollIntent(dir)
    }
    element.addEventListener("wheel", handleWheelIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("touchstart", handlePointerIntent, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handleWheelIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("touchstart", handlePointerIntent)
      element.removeEventListener("keydown", handleKeyIntent)
    }
  }

  function updateScrollIndicatorsFromVisibility() {
    const hasItems = props.items().length > 0
    const bottomVisible = bottomSentinelVisible()
    const topVisible = topSentinelVisible()
    setShowScrollBottomButton(hasItems && !bottomVisible)
    setShowScrollTopButton(hasItems && !topVisible)
  }

  function clearScrollToBottomFrames() {
    if (scrollToBottomFrame !== null) {
      cancelAnimationFrame(scrollToBottomFrame)
      scrollToBottomFrame = null
    }
    if (scrollToBottomDelayedFrame !== null) {
      cancelAnimationFrame(scrollToBottomDelayedFrame)
      scrollToBottomDelayedFrame = null
    }
  }

  function scrollToBottom(immediate = false, options?: { suppressAutoAnchor?: boolean }) {
    if (!containerRef) return
    if (anchorLock()) {
      clearAnchorLock()
    }
    const sentinel = bottomSentinel()
    const behavior: ScrollBehavior = immediate ? "auto" : "smooth"
    const suppressAutoAnchor = options?.suppressAutoAnchor ?? !immediate
    if (suppressAutoAnchor) {
      suppressAutoScrollOnce = true
    }
    sentinel?.scrollIntoView({ block: "end", inline: "nearest", behavior })
    setAutoScroll(true)
  }

  function requestScrollToBottom(immediate = true) {
    if (!isActive()) {
      pendingActiveScroll = true
      return
    }
    if (!containerRef || !bottomSentinel()) {
      pendingActiveScroll = true
      return
    }
    pendingActiveScroll = false
    clearScrollToBottomFrames()
    scrollToBottomFrame = requestAnimationFrame(() => {
      scrollToBottomFrame = null
      scrollToBottomDelayedFrame = requestAnimationFrame(() => {
        scrollToBottomDelayedFrame = null
        scrollToBottom(immediate)
      })
    })
  }

  function resolvePendingActiveScroll() {
    if (!pendingActiveScroll) return
    if (!isActive()) return
    requestScrollToBottom(true)
  }

  function scrollToTop(immediate = false) {
    if (!containerRef) return
    const behavior: ScrollBehavior = immediate ? "auto" : "smooth"
    if (anchorLock()) {
      clearAnchorLock()
    }
    setAutoScroll(false)
    topSentinel()?.scrollIntoView({ block: "start", inline: "nearest", behavior })
  }

  function scheduleAnchorScroll(immediate = false) {
    if (!autoScroll()) return
    if (!isActive()) {
      pendingActiveScroll = true
      return
    }
    const sentinel = bottomSentinel()
    if (!sentinel) {
      pendingActiveScroll = true
      return
    }
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
      pendingAnchorScroll = null
    }
    pendingAnchorScroll = requestAnimationFrame(() => {
      pendingAnchorScroll = null
      sentinel.scrollIntoView({ block: "end", inline: "nearest", behavior: immediate ? "auto" : "smooth" })
    })
  }

  function clearAnchorLock() {
    setAnchorLock(null)
    if (pendingAnchorCorrectionFrame !== null) {
      cancelAnimationFrame(pendingAnchorCorrectionFrame)
      pendingAnchorCorrectionFrame = null
    }
  }

  function computeDesiredOffset(block: ScrollLogicalPosition, container: HTMLElement, anchorRect: DOMRect) {
    if (block === "end") {
      return Math.max(0, container.clientHeight - anchorRect.height)
    }
    if (block === "center") {
      return Math.max(0, container.clientHeight / 2 - anchorRect.height / 2)
    }
    // Default to start.
    return 0
  }

  function applyAnchorCorrection() {
    const lock = anchorLock()
    if (!lock) return
    if (autoScroll()) return
    if (!containerRef) return
    if (typeof document === "undefined") return

    const anchorId = getAnchorId(lock.key)
    const anchor = document.getElementById(anchorId)
    if (!anchor) return

    const containerRect = containerRef.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const currentOffset = anchorRect.top - containerRect.top
    const desiredOffset = computeDesiredOffset(lock.block, containerRef, anchorRect)
    const delta = currentOffset - desiredOffset
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) {
      return
    }
    const nextTop = containerRef.scrollTop + delta
    const maxScrollTop = Math.max(containerRef.scrollHeight - containerRef.clientHeight, 0)
    containerRef.scrollTop = Math.min(maxScrollTop, Math.max(0, nextTop))
  }

  function scheduleAnchorCorrection() {
    if (pendingAnchorCorrectionFrame !== null) return
    pendingAnchorCorrectionFrame = requestAnimationFrame(() => {
      pendingAnchorCorrectionFrame = null
      applyAnchorCorrection()
    })
  }

  function handleContentRendered() {
    if (isLoading()) return
    scheduleAnchorScroll()
  }

  function handleScroll() {
    if (!containerRef) return
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
    }
    const isUserScroll = hasUserScrollIntent()
    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = null
      if (!containerRef) return
      const currentScrollTop = containerRef.scrollTop
      if (currentScrollTop !== lastKnownScrollTop) {
        lastKnownScrollTop = currentScrollTop
      }
      const atBottom = bottomSentinelVisible()

      // If the user scrolls manually, exit key-anchored mode.
      if (isUserScroll && anchorLock()) {
        clearAnchorLock()
      }

      if (isUserScroll) {
        if (atBottom) {
          if (!autoScroll()) setAutoScroll(true)
        } else if (autoScroll()) {
          setAutoScroll(false)
        }
      }

      props.onScroll?.()
    })
  }

  function setContainerRef(element: HTMLDivElement | null) {
    containerRef = element || undefined
    setScrollElement(containerRef)
    props.onScrollElementChange?.(containerRef)
    attachScrollIntentListeners(containerRef)
    lastKnownScrollTop = containerRef?.scrollTop ?? 0
    lastUserScrollIntentDirection = null
    if (!containerRef) {
      return
    }
    resolvePendingActiveScroll()
  }

  function scheduleScrollCompensation(key: string, delta: number) {
    if (!containerRef) return
    if (!delta || !Number.isFinite(delta)) return
    if (typeof document === "undefined") return

    // Only compensate while the user scrolls upward (testing default).
    if (!hasUserScrollIntent() || lastUserScrollIntentDirection !== "up") return
    if (autoScroll() || anchorLock()) return

    const anchorId = getAnchorId(key)
    const anchor = document.getElementById(anchorId)
    if (!anchor) return
    const containerRect = containerRef.getBoundingClientRect()
    const rect = anchor.getBoundingClientRect()
    const isAboveViewport = rect.bottom < containerRect.top
    if (!isAboveViewport) {
      return
    }

    const next = (pendingScrollCompensations.get(key) ?? 0) + delta
    pendingScrollCompensations.set(key, next)

    if (pendingScrollCompensationScheduled) return
    pendingScrollCompensationScheduled = true
    const gen = scrollCompensationGen

    // Flush in a microtask so compensation lands before the next paint.
    queueMicrotask(() => {
      if (gen !== scrollCompensationGen) return
      pendingScrollCompensationScheduled = false
      if (!containerRef) return
      if (!hasUserScrollIntent() || lastUserScrollIntentDirection !== "up") {
        pendingScrollCompensations = new Map()
        return
      }
      if (autoScroll() || anchorLock()) {
        pendingScrollCompensations = new Map()
        return
      }

      let applied = 0
      let count = 0
      for (const pendingDelta of pendingScrollCompensations.values()) {
        if (!pendingDelta) continue
        applied += pendingDelta
        count += 1
      }
      pendingScrollCompensations = new Map()
      if (!applied) return

      const before = containerRef.scrollTop
      const maxScrollTop = Math.max(containerRef.scrollHeight - containerRef.clientHeight, 0)
      const nextTop = Math.min(maxScrollTop, Math.max(0, before + applied))
      if (nextTop !== before) {
        containerRef.scrollTop = nextTop
        lastKnownScrollTop = nextTop
      }

    })
  }

  function setShellRef(element: HTMLDivElement | null) {
    shellRef = element || undefined
    setShellElement(shellRef)
    props.onShellElementChange?.(shellRef)
  }

  function setBottomSentinel(element: HTMLDivElement | null) {
    setBottomSentinelSignal(element)
    resolvePendingActiveScroll()
  }

  const api: VirtualFollowListApi = {
    scrollToTop: (opts) => scrollToTop(Boolean(opts?.immediate)),
    scrollToBottom: (opts) => scrollToBottom(Boolean(opts?.immediate), { suppressAutoAnchor: opts?.suppressAutoAnchor }),
    scrollToKey: (key, opts) => {
      if (typeof document === "undefined") return
      const anchorId = getAnchorId(key)
      const behavior = opts?.behavior ?? "smooth"
      const block = opts?.block ?? "start"
      const nextAutoScroll = opts?.setAutoScroll ?? false
      setAutoScroll(nextAutoScroll)
      if (!nextAutoScroll) {
        if (anchorLock()) {
          clearAnchorLock()
        }
        setAnchorLock({ key, block })
      } else {
        if (anchorLock()) {
          clearAnchorLock()
        }
      }
      const first = document.getElementById(anchorId)
      first?.scrollIntoView({ block, behavior })
      // When using virtualization, the placeholder height can be stale until the
      // item mounts/measures. Re-run scrollIntoView() on the next frame to
      // stabilize the final position.
      requestAnimationFrame(() => {
        const second = document.getElementById(anchorId)
        second?.scrollIntoView({ block, behavior })
      })
    },
    notifyContentRendered: () => handleContentRendered(),
    setAutoScroll: (enabled) => setAutoScroll(Boolean(enabled)),
    getAutoScroll: () => autoScroll(),
    getScrollElement: () => scrollElement(),
    getShellElement: () => shellElement(),
  }

  createEffect(() => {
    props.registerApi?.(api)
  })

  createEffect(() => {
    props.registerState?.(state)
  })

  let lastActiveState = false
  createEffect(() => {
    const active = isActive()
    if (active) {
      resolvePendingActiveScroll()
      if (!lastActiveState && autoScroll()) {
        requestScrollToBottom(true)
      }
    } else if (autoScroll()) {
      pendingActiveScroll = true
    }
    lastActiveState = active
  })

  createEffect(() => {
    const loading = isLoading()
    if (loading) {
      pendingInitialScroll = true
      return
    }
    if (!pendingInitialScroll) {
      return
    }
    const container = scrollElement()
    const sentinel = bottomSentinel()
    if (!container || !sentinel || props.items().length === 0) {
      return
    }
    pendingInitialScroll = false
    requestScrollToBottom(true)
  })

  let previousFollowToken: string | number | undefined
  createEffect(() => {
    const token = props.followToken?.()
    if (isLoading() || token === undefined) {
      previousFollowToken = token
      return
    }
    if (previousFollowToken === undefined) {
      previousFollowToken = token
      return
    }
    if (token === previousFollowToken) {
      return
    }
    previousFollowToken = token
    if (suppressAutoScrollOnce) {
      suppressAutoScrollOnce = false
      return
    }
    if (autoScroll()) {
      scheduleAnchorScroll(true)
    }
  })

  // Drop anchor lock if the anchored key is removed.
  createEffect(() => {
    const lock = anchorLock()
    if (!lock) return
    const keys = props.items().map((item, idx) => props.getKey(item, idx))
    if (!keys.includes(lock.key)) {
      clearAnchorLock()
    }
  })

  createEffect(() => {
    if (props.items().length === 0) {
      setShowScrollTopButton(false)
      setShowScrollBottomButton(false)
      setAutoScroll(true)
      return
    }
    updateScrollIndicatorsFromVisibility()
  })

  createEffect(() => {
    const container = scrollElement()
    const topTarget = topSentinel()
    const bottomTarget = bottomSentinel()
    if (!container || !topTarget || !bottomTarget) return
    if (typeof IntersectionObserver === "undefined") return

    const margin = props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX

    const observer = new IntersectionObserver(
      (entries) => {
        let visibilityChanged = false
        for (const entry of entries) {
          if (entry.target === topTarget) {
            setTopSentinelVisible(entry.isIntersecting)
            visibilityChanged = true
          } else if (entry.target === bottomTarget) {
            setBottomSentinelVisible(entry.isIntersecting)
            visibilityChanged = true
          }
        }
        if (visibilityChanged) {
          updateScrollIndicatorsFromVisibility()
        }
      },
      { root: container, threshold: 0, rootMargin: `${margin}px 0px ${margin}px 0px` },
    )
    observer.observe(topTarget)
    observer.observe(bottomTarget)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const container = scrollElement()
    const items = props.items()
    if (!container || items.length === 0) return
    if (typeof document === "undefined") return
    if (typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver(
      (entries) => {
        let best: IntersectionObserverEntry | null = null
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          if (!best || entry.boundingClientRect.top < best.boundingClientRect.top) {
            best = entry
          }
        }
        if (best) {
          const anchorId = (best.target as HTMLElement).id
          const key = getKeyFromAnchorId(anchorId)
          setActiveKey((current) => (current === key ? current : key))
        }
      },
      { root: container, rootMargin: "-10% 0px -80% 0px", threshold: 0 },
    )

    const anchorIds = items.map((item, idx) => getAnchorId(props.getKey(item, idx)))
    anchorIds.forEach((anchorId) => {
      const anchor = document.getElementById(anchorId)
      if (anchor) observer.observe(anchor)
    })

    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const key = activeKey()
    props.onActiveKeyChange?.(key)
  })

  onCleanup(() => {
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame)
    }
    if (pendingAnchorScroll !== null) {
      cancelAnimationFrame(pendingAnchorScroll)
    }
    if (pendingAnchorCorrectionFrame !== null) {
      cancelAnimationFrame(pendingAnchorCorrectionFrame)
    }
    scrollCompensationGen += 1
    pendingScrollCompensationScheduled = false
    pendingScrollCompensations = new Map()
    clearScrollToBottomFrames()
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
    }
  })

  const controls = () => {
    if (props.renderControls) {
      return props.renderControls(state, api)
    }

    // Avoid hardcoded user-visible strings; require consumers to supply
    // localized aria labels when using the default controls.
    if (!props.scrollToTopAriaLabel || !props.scrollToBottomAriaLabel) {
      return null
    }

    const labelTop = props.scrollToTopAriaLabel()
    const labelBottom = props.scrollToBottomAriaLabel()
    return (
      <Show when={showScrollTopButton() || showScrollBottomButton()}>
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button type="button" class="message-scroll-button" onClick={() => scrollToTop()} aria-label={labelTop}>
              <span class="message-scroll-icon" aria-hidden="true">
                ↑
              </span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button
              type="button"
              class="message-scroll-button"
              onClick={() => scrollToBottom(false, { suppressAutoAnchor: false })}
              aria-label={labelBottom}
            >
              <span class="message-scroll-icon" aria-hidden="true">
                ↓
              </span>
            </button>
          </Show>
        </div>
      </Show>
    )
  }

  return (
    <div class="message-stream-shell" ref={setShellRef}>
      <div
        class="message-stream"
        ref={setContainerRef}
        onScroll={handleScroll}
        onMouseUp={(event) => props.onMouseUp?.(event)}
      >
        <div ref={setTopSentinel} aria-hidden="true" style={{ height: "1px" }} />
        {props.renderBeforeItems?.()}
        <Index each={props.items()}>
          {(item, index) => {
            const key = () => props.getKey(item(), index)
            const anchorId = () => getAnchorId(key())
            const overscanPx = props.overscanPx ?? 800
            const suspendMeasurements = () => measurementsSuspended() || !isActive()
            return (
              <VirtualItem
                id={anchorId()}
                cacheKey={key()}
                scrollContainer={scrollElement}
                threshold={overscanPx}
                placeholderClass="message-stream-placeholder"
                virtualizationEnabled={() => virtualizationEnabled() && !isLoading()}
                suspendMeasurements={suspendMeasurements}
                onHeightChange={(nextHeight, previousHeight) => {
                  const delta = nextHeight - previousHeight

                  // Key-anchored mode: keep the target key in view when
                  // items above it mount/measure and shift layout.
                  if (anchorLock() && !autoScroll()) {
                    scheduleAnchorCorrection()
                    return
                  }

                  // Free-scroll mode: if items above the viewport change height
                  // while scrolling upward, compensate scrollTop so visible
                  // content stays stable.
                  if (delta) {
                    scheduleScrollCompensation(key(), delta)
                  }
                }}
              >
                {props.renderItem(item(), index)}
              </VirtualItem>
            )
          }}
        </Index>
        <div ref={setBottomSentinel} aria-hidden="true" style={{ height: "1px" }} />
      </div>

      {controls()}

      {props.renderOverlay?.()}
    </div>
  )
}
