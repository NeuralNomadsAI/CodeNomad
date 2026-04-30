import { Show, createEffect, createMemo, createSignal, type Accessor, type JSX, on } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"

const DEFAULT_SCROLL_SENTINEL_MARGIN_PX = 48
const DEFAULT_HOLD_TARGET_TOP_THRESHOLD_PX = 8
const DEFAULT_NEAR_BOTTOM_THRESHOLD_PX = 48
const SCROLL_DIRECTION_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])

export interface VirtualFollowListApi {
  scrollToTop: (opts?: { immediate?: boolean }) => void
  scrollToBottom: (opts?: { immediate?: boolean }) => void
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
   * When switching back to an inactive (cached) pane, the list historically
   * re-pinned to the bottom if autoScroll was enabled.
   *
   * Disable this to preserve the existing scroll position across pane switches.
   */
  scrollToBottomOnActivate?: Accessor<boolean>

  /**
   * Controls whether the list should scroll to bottom the first time items
   * appear (default behavior for chat streams).
   *
   * Set to false when an outer component restores scroll from a cache.
   */
  initialScrollToBottom?: Accessor<boolean>

  /**
   * Initial value for the internal autoScroll signal.
   * Useful when restoring scroll state (e.g. start in non-follow mode).
   */
  initialAutoScroll?: Accessor<boolean>

  /**
   * When this value changes, the list resets internal follow/anchor state.
   * Useful when reusing the same list instance across different datasets.
   */
  resetKey?: Accessor<string | number>

  /**
   * If this value changes and autoScroll is enabled, the list will
   * anchor-scroll to the bottom (unless suppressed).
   */
  followToken?: Accessor<string | number>

  /**
   * Optional item key whose geometry can temporarily hold auto-follow when the
   * rendered item grows taller than the viewport and reaches the top edge.
   */
  autoPinHoldTargetKey?: Accessor<string | null>

  /**
   * Optional resolver for the specific element inside an item wrapper that
   * should be measured for hold-target geometry.
   */
  resolveAutoPinHoldElement?: (itemWrapper: HTMLDivElement, key: string) => HTMLElement | null | undefined

  /**
   * Top-edge threshold for the hold target in pixels.
   */
  autoPinHoldTopThresholdPx?: number

  /**
   * Temporarily suppress automatic bottom pinning while keeping follow mode enabled.
   */
  suspendAutoPinToBottom?: Accessor<boolean>

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
  onClick?: (event: MouseEvent) => void
  onActiveKeyChange?: (key: string | null) => void
  registerApi?: (api: VirtualFollowListApi) => void
  registerState?: (state: VirtualFollowListState) => void
  renderControls?: (state: VirtualFollowListState, api: VirtualFollowListApi) => JSX.Element
}

export default function VirtualFollowList<T>(props: VirtualFollowListProps<T>) {
  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [shellElement, setShellElement] = createSignal<HTMLDivElement | undefined>()
  const [virtuaHandle, setVirtuaHandle] = createSignal<VirtualizerHandle | undefined>()

  const isActive = () => (props.isActive ? props.isActive() : true)
  const scrollToBottomOnActivate = () => (props.scrollToBottomOnActivate ? props.scrollToBottomOnActivate() : true)
  const initialScrollToBottom = () => (props.initialScrollToBottom ? props.initialScrollToBottom() : true)
  const initialAutoScroll = () => (props.initialAutoScroll ? props.initialAutoScroll() : true)
  const externalSuspendAutoPinToBottom = () => (props.suspendAutoPinToBottom ? props.suspendAutoPinToBottom() : false)
  const holdTargetKey = () => (props.autoPinHoldTargetKey ? props.autoPinHoldTargetKey() : null)
  const holdTargetTopThresholdPx = () => props.autoPinHoldTopThresholdPx ?? DEFAULT_HOLD_TARGET_TOP_THRESHOLD_PX

  const initialFollowEnabled = Boolean(initialAutoScroll())

  const [autoScroll, setAutoScroll] = createSignal(initialFollowEnabled)
  const [escapedFromLock, setEscapedFromLock] = createSignal(!initialFollowEnabled)
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [activeKey, setActiveKey] = createSignal<string | null>(null)
  const [activeHoldTargetKey, setActiveHoldTargetKey] = createSignal<string | null>(null)
  const [didTriggerHoldForCurrentTarget, setDidTriggerHoldForCurrentTarget] = createSignal(false)
  const effectiveSuspendAutoPinToBottom = () => externalSuspendAutoPinToBottom() || activeHoldTargetKey() !== null

  const scrollButtonsCount = createMemo(() => (showScrollTopButton() ? 1 : 0) + (showScrollBottomButton() ? 1 : 0))
  const itemElements = new Map<string, HTMLDivElement>()

  let detachScrollIntentListeners: (() => void) | undefined
  let lastResetKey: string | number | undefined
  let pendingInitialScroll = true
  let lastObservedScrollOffset = 0
  let ignoreNextScrollEvent = false
  let pendingProgrammaticBottomScroll = false
  let pendingProgrammaticBottomScrollFrame: number | null = null
  let pendingContentGrowthCheckFrame: number | null = null
  let previousObservedScrollHeight: number | null = null

  const state: VirtualFollowListState = {
    autoScroll,
    showScrollTopButton,
    showScrollBottomButton,
    scrollButtonsCount,
    activeKey,
  }

  function syncFollowState(nextNearBottom: boolean, nextEscapedFromLock: boolean, options?: { forceAutoScroll?: boolean }) {
    setEscapedFromLock(nextEscapedFromLock)
    if (nextEscapedFromLock) {
      setAutoScroll(false)
      return
    }

    if (nextNearBottom || options?.forceAutoScroll) {
      setAutoScroll(true)
    }
  }

  function resetPendingFollowFrames() {
    if (pendingProgrammaticBottomScrollFrame !== null) {
      cancelAnimationFrame(pendingProgrammaticBottomScrollFrame)
      pendingProgrammaticBottomScrollFrame = null
    }
    pendingProgrammaticBottomScroll = false
  }

  function clearAutoPinHold(options?: { resumeBottom?: boolean }) {
    if (activeHoldTargetKey() === null) return
    setActiveHoldTargetKey(null)
    if (options?.resumeBottom && autoScroll()) {
      requestAnimationFrame(() => {
        if (!autoScroll() || escapedFromLock() || activeHoldTargetKey() !== null || externalSuspendAutoPinToBottom()) return
        scrollToBottom(false, { preserveFollowState: true })
      })
    }
  }

  function escapeFromFollow() {
    resetPendingFollowFrames()
    clearAutoPinHold()
    setEscapedFromLock(true)
    setAutoScroll(false)
  }

  function rejoinFollow() {
    setEscapedFromLock(false)
    setAutoScroll(true)
  }

  function getDistanceFromBottom() {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return Number.POSITIVE_INFINITY
    return handle.scrollSize - (element.scrollTop + element.clientHeight)
  }

  function getCurrentScrollOffset(element: HTMLDivElement, handle: VirtualizerHandle) {
    const domOffset = element.scrollTop
    const virtuaOffset = handle.scrollOffset
    return Math.abs(domOffset - virtuaOffset) > 1 ? domOffset : virtuaOffset
  }

  function scheduleProgrammaticBottomFollow() {
    if (pendingProgrammaticBottomScroll || effectiveSuspendAutoPinToBottom()) return
    pendingProgrammaticBottomScroll = true
    pendingProgrammaticBottomScrollFrame = requestAnimationFrame(() => {
      pendingProgrammaticBottomScrollFrame = null
      pendingProgrammaticBottomScroll = false
      if (!(autoScroll() && !escapedFromLock() && !effectiveSuspendAutoPinToBottom())) {
        return
      }
      scrollToBottom(true, { preserveFollowState: true })
    })
  }

  function resetContentGrowthTracking() {
    if (pendingContentGrowthCheckFrame !== null) {
      cancelAnimationFrame(pendingContentGrowthCheckFrame)
      pendingContentGrowthCheckFrame = null
    }
    previousObservedScrollHeight = null
  }

  function scheduleContentGrowthCheck() {
    if (pendingContentGrowthCheckFrame !== null) return
    // Render callbacks only tell us that content may have changed. Confirm the
    // outer scroll height actually grew before scheduling another follow step.
    pendingContentGrowthCheckFrame = requestAnimationFrame(() => {
      pendingContentGrowthCheckFrame = null
      const element = scrollElement()
      if (!element) return
      const nextScrollHeight = element.scrollHeight
      const previousScrollHeight = previousObservedScrollHeight
      previousObservedScrollHeight = nextScrollHeight
      if (previousScrollHeight === null || nextScrollHeight <= previousScrollHeight) {
        return
      }
      if (autoScroll() && !escapedFromLock() && !effectiveSuspendAutoPinToBottom()) {
        scheduleProgrammaticBottomFollow()
      }
    })
  }

  function attachScrollIntentListeners(element: HTMLDivElement | undefined) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    if (!element) return
    resetContentGrowthTracking()
    previousObservedScrollHeight = element.scrollHeight
    const handleWheelIntent = (event: WheelEvent) => {
      const dir: "up" | "down" | null = event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : null
      if (dir === "up" && autoScroll()) {
        escapeFromFollow()
      } else if (dir === "down" && escapedFromLock()) {
        if (getDistanceFromBottom() <= Math.max(props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX, DEFAULT_NEAR_BOTTOM_THRESHOLD_PX)) {
          event.preventDefault()
          event.stopPropagation()
          rejoinFollow()
          ignoreNextScrollEvent = true
          scrollToBottom(true, { preserveFollowState: true })
          return
        }
      }
    }
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (!SCROLL_DIRECTION_KEYS.has(event.key)) return
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
      if (dir === "up" && autoScroll()) {
        escapeFromFollow()
      }
    }
    element.addEventListener("wheel", handleWheelIntent, { passive: false, capture: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handleWheelIntent, true)
      element.removeEventListener("keydown", handleKeyIntent)
      resetContentGrowthTracking()
    }
  }

  function updateScrollButtons() {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return

    const offset = getCurrentScrollOffset(element, handle)
    const scrolledUp = offset < lastObservedScrollOffset - 1
    const scrolledDown = offset > lastObservedScrollOffset + 1
    const distanceFromBottom = handle.scrollSize - (offset + element.clientHeight)
    const atBottom = distanceFromBottom <= (props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX)
    const nearBottom = distanceFromBottom <= Math.max(props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX, DEFAULT_NEAR_BOTTOM_THRESHOLD_PX)
    const atTop = offset <= (props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX)

    const hasItems = props.items().length > 0
    setShowScrollBottomButton(hasItems && !atBottom)
    setShowScrollTopButton(hasItems && !atTop)

    let direction: "up" | "down" | null = null
    if (scrolledUp) {
      direction = "up"
    } else if (scrolledDown) {
      direction = "down"
    }

    const holdActive = activeHoldTargetKey() !== null
    let nextEscapedFromLock = escapedFromLock()
    if (holdActive && direction) {
      clearAutoPinHold()
      nextEscapedFromLock = direction === "down" && nearBottom ? false : true
    } else if (direction === "up") {
      clearAutoPinHold()
      nextEscapedFromLock = true
    } else if (direction === "down" && nearBottom) {
      nextEscapedFromLock = false
    } else if (!escapedFromLock() && nearBottom) {
      nextEscapedFromLock = false
    }

    syncFollowState(nearBottom, nextEscapedFromLock)
    lastObservedScrollOffset = offset
  }

  function scrollToBottom(immediate = true, options?: { preserveFollowState?: boolean }) {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return
    ignoreNextScrollEvent = true
    if (!options?.preserveFollowState) {
      clearAutoPinHold()
      rejoinFollow()
    }
    if (immediate) {
      element.scrollTop = element.scrollHeight
      lastObservedScrollOffset = element.scrollTop
      return
    }
    handle.scrollToIndex(props.items().length - 1, { align: "end", smooth: true })
  }

  function scrollToTop(immediate = true) {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return
    escapeFromFollow()
    if (immediate) {
      element.scrollTop = 0
      lastObservedScrollOffset = 0
    } else {
      handle.scrollToIndex(0, { align: "start", smooth: true })
    }
    ignoreNextScrollEvent = true
  }

  function handleScroll() {
    if (ignoreNextScrollEvent) {
      ignoreNextScrollEvent = false
      updateScrollButtons()
      return
    }

    updateScrollButtons()
    props.onScroll?.()

    // Find active key (roughly the first visible item)
    const handle = virtuaHandle()
    const element = scrollElement()
    if (handle && element) {
      const start = handle.findItemIndex(getCurrentScrollOffset(element, handle))
      const items = props.items()
      if (items[start]) {
        const key = props.getKey(items[start], start)
        if (key !== activeKey()) {
          setActiveKey(key)
          props.onActiveKeyChange?.(key)
        }
      }
    }
  }

  function registerItemElement(key: string, element: HTMLDivElement | null | undefined) {
    if (!element) {
      itemElements.delete(key)
      return
    }
    itemElements.set(key, element)
  }

  function getAnchorIdForKey(key: string) {
    return props.getAnchorId ? props.getAnchorId(key) : key
  }

  function updateAutoPinHold() {
    const element = scrollElement()
    if (!element) return

    const targetKey = holdTargetKey()
    const heldKey = activeHoldTargetKey()

    if (heldKey !== null) {
      if (targetKey !== heldKey) {
        clearAutoPinHold({ resumeBottom: true })
      }
      return
    }

    if (!autoScroll()) return
    if (externalSuspendAutoPinToBottom()) return
    if (!targetKey) return
    if (didTriggerHoldForCurrentTarget()) return

    const itemWrapper = itemElements.get(targetKey)
    if (!itemWrapper) return
    const target = props.resolveAutoPinHoldElement?.(itemWrapper, targetKey) ?? itemWrapper

    const containerRect = element.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const relativeTop = targetRect.top - containerRect.top
    const exceedsViewport = targetRect.height > element.clientHeight

    if (exceedsViewport && relativeTop < 0) {
      const alignDelta = relativeTop - holdTargetTopThresholdPx()
      if (Math.abs(alignDelta) > 1) {
        ignoreNextScrollEvent = true
        element.scrollTop = Math.max(0, element.scrollTop + alignDelta)
        lastObservedScrollOffset = element.scrollTop
      }
      setActiveHoldTargetKey(targetKey)
      setDidTriggerHoldForCurrentTarget(true)
    }
  }

  const api: VirtualFollowListApi = {
    scrollToTop: (opts) => scrollToTop(opts?.immediate ?? true),
    scrollToBottom: (opts) => scrollToBottom(opts?.immediate ?? true),
    scrollToKey: (key, opts) => {
      const index = props.items().findIndex((item, i) => props.getKey(item, i) === key)
      if (index === -1) return
      const nextAutoScroll = opts?.setAutoScroll ?? false
      if (nextAutoScroll) {
        rejoinFollow()
      } else {
        escapeFromFollow()
      }
      ignoreNextScrollEvent = true
      virtuaHandle()?.scrollToIndex(index, { align: opts?.block ?? "start", smooth: opts?.behavior === "smooth" })
    },
    notifyContentRendered: () => {
      updateAutoPinHold()
      if (activeHoldTargetKey() !== null) return
      scheduleContentGrowthCheck()
    },
    setAutoScroll: (enabled) => {
      if (enabled) {
        rejoinFollow()
        return
      }
      escapeFromFollow()
    },
    getAutoScroll: () => autoScroll(),
    getScrollElement: () => scrollElement(),
    getShellElement: () => shellElement(),
  }

  createEffect(() => props.registerApi?.(api))
  createEffect(() => props.registerState?.(state))

  createEffect(on(() => props.resetKey?.(), () => {
    itemElements.clear()
    setActiveHoldTargetKey(null)
    setDidTriggerHoldForCurrentTarget(false)
    lastObservedScrollOffset = 0
    ignoreNextScrollEvent = false
    resetPendingFollowFrames()
    resetContentGrowthTracking()
  }))

  createEffect(on(holdTargetKey, (nextTargetKey, prevTargetKey) => {
    if (nextTargetKey !== prevTargetKey && didTriggerHoldForCurrentTarget()) {
      setDidTriggerHoldForCurrentTarget(false)
    }
    if (activeHoldTargetKey() === null) return
    if (nextTargetKey === activeHoldTargetKey()) return
    clearAutoPinHold({ resumeBottom: true })
  }, { defer: true }))

  // Handle followToken change
  createEffect(on(() => props.followToken?.(), () => {
    if (autoScroll() && !effectiveSuspendAutoPinToBottom()) {
      scheduleProgrammaticBottomFollow()
    }
  }, { defer: true }))

  // Reset state on resetKey change
  createEffect(on(() => props.resetKey?.(), (nextKey) => {
    if (nextKey === lastResetKey) return
    lastResetKey = nextKey
    const followEnabled = Boolean(initialAutoScroll())
    syncFollowState(followEnabled, !followEnabled, { forceAutoScroll: followEnabled })
    pendingInitialScroll = true
  }))

  // Initial scroll and session activation
  createEffect(() => {
    const active = isActive()
    if (!active) return
    if (pendingInitialScroll && props.items().length > 0) {
      pendingInitialScroll = false
      if (initialScrollToBottom()) {
        scrollToBottom(true)
      }
    } else if (autoScroll() && scrollToBottomOnActivate()) {
      scrollToBottom(true, { preserveFollowState: true })
    }
  })

  return (
    <div class="virtual-follow-list-shell" ref={shellElement => {
      setShellElement(shellElement)
      props.onShellElementChange?.(shellElement)
    }}>
      <div
        class="message-stream"
        ref={el => {
          setScrollElement(el)
          props.onScrollElementChange?.(el)
          attachScrollIntentListeners(el)
        }}
        onMouseUp={props.onMouseUp}
        onClick={props.onClick}
      >
        <Show when={props.renderBeforeItems}>
          {props.renderBeforeItems!()}
        </Show>
        <Virtualizer
          ref={setVirtuaHandle}
          scrollRef={scrollElement()}
          data={props.items()}
          bufferSize={props.overscanPx ?? 400}
          onScroll={handleScroll}
        >
          {(item, index) => {
            const key = props.getKey(item, index())
            const anchorId = getAnchorIdForKey(key)
            return (
              <div id={anchorId} data-virtual-follow-key={key} ref={(element) => registerItemElement(key, element)}>
                {props.renderItem(item, index())}
              </div>
            )
          }}
        </Virtualizer>
      </div>

      <Show when={props.renderOverlay}>
        <div class="virtual-follow-list-overlay">{props.renderOverlay!()}</div>
      </Show>

      <Show when={props.renderControls}>
        <div class="virtual-follow-list-controls-container">{props.renderControls!(state, api)}</div>
      </Show>

      <Show
        when={
          !props.renderControls &&
          (showScrollTopButton() || showScrollBottomButton()) &&
          props.scrollToTopAriaLabel &&
          props.scrollToBottomAriaLabel
        }
      >
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button type="button" class="message-scroll-button" onClick={() => scrollToTop()} aria-label={props.scrollToTopAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">
                ↑
              </span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button type="button" class="message-scroll-button" onClick={() => scrollToBottom()} aria-label={props.scrollToBottomAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">
                ↓
              </span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
