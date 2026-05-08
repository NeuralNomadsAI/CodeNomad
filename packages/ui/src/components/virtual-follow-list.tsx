import { Show, createEffect, createMemo, createSignal, type Accessor, type JSX, on, onCleanup } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { getHeldKey, isAutoFollowing, isAtBottom, VirtualScrollController, type FollowEffect, type FollowEvent, type FollowMode, type ScrollControllerMetrics, type ScrollControllerResult } from "./virtual-follow-behavior.ts"

const DEFAULT_SCROLL_SENTINEL_MARGIN_PX = 48
const DEFAULT_HOLD_TARGET_TOP_THRESHOLD_PX = 8
const DEFAULT_REJOIN_LAST_ITEM_COUNT = 2
const USER_SCROLL_INTENT_WINDOW_MS = 600
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])
const INTERACTIVE_KEY_TARGET_SELECTOR = "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='textbox']"

export interface VirtualFollowListApi {
  scrollToTop: (opts?: { immediate?: boolean }) => void
  scrollToBottom: (opts?: { immediate?: boolean; suppressAutoAnchor?: boolean; suppressHold?: boolean }) => void
  scrollToKey: (
    key: string,
    opts?: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition; setAutoScroll?: boolean },
  ) => void
  notifyContentRendered: () => void
  setAutoScroll: (enabled: boolean) => void
  getAutoScroll: () => boolean
  getScrollElement: () => HTMLDivElement | undefined
  getShellElement: () => HTMLDivElement | undefined
  captureScrollSnapshot: () => VirtualFollowScrollSnapshot | undefined
  restoreScrollSnapshot: (snapshot: VirtualFollowScrollSnapshot, opts?: RestoreScrollSnapshotOptions) => void
}

export interface VirtualFollowScrollSnapshot {
  scrollTop: number
  scrollRatio?: number
  maxScrollTop?: number
  anchorKey?: string
  anchorOffset?: number
  atBottom: boolean
}

interface RestoreScrollSnapshotOptions {
  behavior?: ScrollBehavior
  fallback?: () => void
  onApplied?: () => void
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

  overscanPx?: number
  scrollSentinelMarginPx?: number
  virtualizationEnabled?: Accessor<boolean>
  suspendMeasurements?: Accessor<boolean>
  streamingActive?: Accessor<boolean>
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
  autoPinHoldEnabled?: Accessor<boolean>

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
  const streamingActive = () => props.streamingActive?.() ?? false
  const autoPinHoldEnabled = () => props.autoPinHoldEnabled?.() ?? false
  const holdTargetKey = () => (props.autoPinHoldTargetKey ? props.autoPinHoldTargetKey() : null)
  const holdTargetTopThresholdPx = () => props.autoPinHoldTopThresholdPx ?? DEFAULT_HOLD_TARGET_TOP_THRESHOLD_PX

  const scrollController = new VirtualScrollController(initialAutoScroll())
  const [followMode, setFollowMode] = createSignal<FollowMode>(scrollController.snapshot().mode)
  const autoScroll = createMemo(() => isAutoFollowing(followMode()))
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [activeKey, setActiveKey] = createSignal<string | null>(null)
  const activeHoldTargetKey = createMemo(() => getHeldKey(followMode()))
  const [didTriggerHoldForCurrentTarget, setDidTriggerHoldForCurrentTarget] = createSignal(false)
  const effectiveSuspendAutoPinToBottom = () => externalSuspendAutoPinToBottom() || activeHoldTargetKey() !== null

  const scrollButtonsCount = createMemo(() => (showScrollTopButton() ? 1 : 0) + (showScrollBottomButton() ? 1 : 0))
  const itemElements = new Map<string, HTMLDivElement>()

  let detachScrollIntentListeners: (() => void) | undefined
  let lastResetKey: string | number | undefined
  let suppressAutoScrollOnce = false
  let suppressHoldUntilTargetChanges = false
  let pendingInitialScroll = true
  let programmaticScrollUntil = 0
  let pendingBottomRepinAfterHold = false

  const state: VirtualFollowListState = {
    autoScroll,
    showScrollTopButton,
    showScrollBottomButton,
    scrollButtonsCount,
    activeKey,
  }

  function markUserScrollIntent(direction?: "up" | "down" | null) {
    const now = performance.now()
    scrollController.setUserIntent(direction ?? null, now + USER_SCROLL_INTENT_WINDOW_MS)
  }

  function markProgrammaticScroll() {
    programmaticScrollUntil = performance.now() + 120
  }

  function hasProgrammaticScrollIntent() {
    return performance.now() <= programmaticScrollUntil
  }

  function syncControllerResult(result: ScrollControllerResult) {
    setFollowMode(result.state.mode)
    applyFollowEffect(result.effect)
  }

  function escapeFollowIfDomMovedUp(element = scrollElement()) {
    if (!element) return false
    const result = scrollController.beforeBottomPin(getDomMetrics(element))
    syncControllerResult(result)
    return result.effect.type !== "none" || result.state.mode.type === "escaped"
  }

  function shouldHonorPrePinEscape() {
    const snapshot = scrollController.snapshot()
    return performance.now() <= snapshot.userIntentUntil && snapshot.userIntentDirection === "up"
  }

  function dispatchFollowEvent(event: FollowEvent) {
    let result: ScrollControllerResult
    switch (event.type) {
      case "user-scroll": {
        const metrics = getManualMetrics(event.atBottom)
        result = scrollController.observeViewport(
          metrics,
          performance.now(),
          hasProgrammaticScrollIntent(),
          canRejoinFollowFromDownScroll(metrics),
        )
        break
      }
      case "jump-top":
        result = scrollController.jumpTop(event.immediate)
        break
      case "jump-bottom":
        result = scrollController.jumpBottom(event.immediate, event.explicit)
        break
      case "jump-key":
        result = scrollController.jumpKey(event.key, event.block, event.smooth, event.followAfter)
        break
      case "content-grew": {
        const element = scrollElement()
        result = element
          ? scrollController.contentRendered(getDomMetrics(element), event.canPinToBottom)
          : scrollController.contentRendered(getManualMetrics(false), event.canPinToBottom)
        break
      }
      case "hold-candidate":
        result = scrollController.holdCandidate(event.key, event.shouldHold)
        break
      case "hold-target-changed":
        result = scrollController.holdTargetChanged(event.key, event.canPinToBottom)
        break
      case "set-follow":
        result = scrollController.setFollow(event.enabled)
        break
      case "reset":
        result = scrollController.reset(event.follow)
        break
    }
    syncControllerResult(result)
  }

  function applyFollowEffect(effect: FollowEffect) {
    switch (effect.type) {
      case "none":
        return
      case "scroll-top":
        performScrollToTop(effect.immediate)
        return
      case "scroll-bottom":
        if (effect.suppressHold) {
          suppressHoldUntilTargetChanges = true
        }
        performScrollToBottom(effect.immediate)
        return
      case "scroll-key":
        performScrollToKey(effect.key, { block: effect.block, smooth: effect.smooth })
        return
      case "align-hold":
        alignHoldTarget(effect.key)
        return
    }
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
    const handlePointerIntent = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(INTERACTIVE_KEY_TARGET_SELECTOR)) return
      markUserScrollIntent(null)
    }
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (!SCROLL_INTENT_KEYS.has(event.key)) return
      if ((event.target as HTMLElement | null)?.closest(INTERACTIVE_KEY_TARGET_SELECTOR)) return
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
      if (key === "End") {
        event.preventDefault()
        scrollToBottom(true)
        return
      }
      markUserScrollIntent(dir)
    }
    element.addEventListener("wheel", handleWheelIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handleWheelIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("keydown", handleKeyIntent)
    }
  }

  function getCurrentScrollOffset(_element: HTMLDivElement, handle: VirtualizerHandle) {
    return handle.scrollOffset
  }

  function getCurrentScrollSize(_element: HTMLDivElement, handle: VirtualizerHandle) {
    return handle.scrollSize
  }

  function getDomMetrics(element: HTMLDivElement, handle = virtuaHandle(), offset = handle?.scrollOffset ?? element.scrollTop): ScrollControllerMetrics {
    const scrollHeight = handle ? getCurrentScrollSize(element, handle) : element.scrollHeight
    return {
      offset,
      scrollHeight,
      clientHeight: handle?.viewportSize ?? element.clientHeight,
      sentinelMarginPx: props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX,
    }
  }

  function scrollToOffset(offset: number, atBottom: boolean) {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!element) return
    const maxOffset = Math.max((handle?.scrollSize ?? element.scrollHeight) - (handle?.viewportSize ?? element.clientHeight), 0)
    const nextOffset = Math.min(Math.max(offset, 0), maxOffset)
    markProgrammaticScroll()
    if (handle) {
      handle.scrollTo(nextOffset)
    } else {
      element.scrollTop = nextOffset
    }
    scrollController.recordProgrammaticOffset(nextOffset, atBottom)
  }

  function getManualMetrics(atBottom: boolean): ScrollControllerMetrics {
    const clientHeight = 1000
    const sentinelMarginPx = props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX
    const distance = atBottom ? 0 : clientHeight
    return {
      offset: 0,
      scrollHeight: clientHeight + distance,
      clientHeight,
      sentinelMarginPx,
    }
  }

  function canRejoinFollowFromDownScroll(metrics: ScrollControllerMetrics) {
    if (!streamingActive()) return false
    if (autoPinHoldEnabled()) return false
    if (effectiveSuspendAutoPinToBottom()) return false
    if (activeHoldTargetKey() !== null) return false
    const items = props.items()
    if (items.length === 0) return false
    if (isAtBottom(metrics)) return true

    const handle = virtuaHandle()
    if (!handle) return false
    const viewportEndIndex = handle.findItemIndex(metrics.offset + metrics.clientHeight - 1)
    return viewportEndIndex >= Math.max(items.length - DEFAULT_REJOIN_LAST_ITEM_COUNT, 0)
  }

  function getSnapshotMetrics(element: HTMLDivElement, handle?: VirtualizerHandle) {
    const scrollTop = handle?.scrollOffset ?? element.scrollTop
    const scrollHeight = handle ? getCurrentScrollSize(element, handle) : element.scrollHeight
    const clientHeight = handle?.viewportSize ?? element.clientHeight
    const maxScrollTop = Math.max(scrollHeight - clientHeight, 0)
    const atBottom = scrollHeight - (scrollTop + clientHeight) <= (props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX)
    return {
      scrollTop,
      scrollRatio: maxScrollTop > 0 ? scrollTop / maxScrollTop : 0,
      maxScrollTop,
      atBottom,
    }
  }

  function findTopVisibleAnchor(element: HTMLDivElement) {
    const containerRect = element.getBoundingClientRect()
    let closestAbove: { key: string; offset: number } | null = null
    let closestBelow: { key: string; offset: number } | null = null

    for (const [key, itemElement] of itemElements) {
      const rect = itemElement.getBoundingClientRect()
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue

      const offset = rect.top - containerRect.top
      if (offset <= 0) {
        if (!closestAbove || offset > closestAbove.offset) closestAbove = { key, offset }
      } else if (!closestBelow || offset < closestBelow.offset) {
        closestBelow = { key, offset }
      }
    }

    return closestAbove ?? closestBelow
  }

  function captureScrollSnapshot(): VirtualFollowScrollSnapshot | undefined {
    const element = scrollElement()
    if (!element) return undefined

    const snapshot: VirtualFollowScrollSnapshot = getSnapshotMetrics(element, virtuaHandle())
    if (!snapshot.atBottom) {
      const anchor = findTopVisibleAnchor(element)
      if (anchor) {
        snapshot.anchorKey = anchor.key
        snapshot.anchorOffset = anchor.offset
      }
    }
    return snapshot
  }

  function applyPixelSnapshot(snapshot: VirtualFollowScrollSnapshot, behavior: ScrollBehavior) {
    const element = scrollElement()
    if (!element) return

    const handle = virtuaHandle()
    const maxScrollTop = Math.max((handle?.scrollSize ?? element.scrollHeight) - (handle?.viewportSize ?? element.clientHeight), 0)
    const scrollRatio = snapshot.scrollRatio
    const canUseRatio =
      !snapshot.atBottom &&
      typeof scrollRatio === "number" &&
      Number.isFinite(scrollRatio) &&
      snapshot.maxScrollTop !== maxScrollTop
    const nextTop = snapshot.atBottom
      ? maxScrollTop
      : canUseRatio
        ? Math.min(Math.max(scrollRatio, 0), 1) * maxScrollTop
        : Math.min(snapshot.scrollTop, maxScrollTop)

    if (behavior === "smooth" && !virtuaHandle()) {
      markProgrammaticScroll()
      element.scrollTo({ top: nextTop, behavior })
      scrollController.recordProgrammaticOffset(nextTop, snapshot.atBottom)
      return
    }
    scrollToOffset(nextTop, snapshot.atBottom)
  }

  function applyAnchorSnapshot(snapshot: VirtualFollowScrollSnapshot) {
    const element = scrollElement()
    if (!element || !snapshot.anchorKey || typeof snapshot.anchorOffset !== "number") return false

    const itemWrapper = itemElements.get(snapshot.anchorKey)
    if (!itemWrapper) return false

    const containerRect = element.getBoundingClientRect()
    const itemRect = itemWrapper.getBoundingClientRect()
    const currentOffset = itemRect.top - containerRect.top
    const delta = currentOffset - snapshot.anchorOffset
    if (Math.abs(delta) > 1) {
      scrollToOffset((virtuaHandle()?.scrollOffset ?? element.scrollTop) + delta, false)
    }
    return true
  }

  function applyBottomSnapshot() {
    const element = scrollElement()
    if (!element) return
    const handle = virtuaHandle()
    const maxOffset = Math.max((handle?.scrollSize ?? element.scrollHeight) - (handle?.viewportSize ?? element.clientHeight), 0)
    scrollToOffset(maxOffset, true)
  }

  function restoreScrollSnapshot(snapshot: VirtualFollowScrollSnapshot, opts?: RestoreScrollSnapshotOptions) {
    const element = scrollElement()
    if (!element) {
      opts?.fallback?.()
      opts?.onApplied?.()
      return
    }

    const behavior = opts?.behavior ?? "auto"
    scrollController.setRestoring(true)
    const finishRestore = () => {
      scrollController.setRestoring(false)
      opts?.onApplied?.()
    }
    if (snapshot.atBottom) {
      applyBottomSnapshot()
      requestAnimationFrame(() => {
        applyBottomSnapshot()
        finishRestore()
      })
      return
    }

    if (snapshot.anchorKey) {
      const index = props.items().findIndex((item, i) => props.getKey(item, i) === snapshot.anchorKey)
      if (index !== -1) {
        markProgrammaticScroll()
        virtuaHandle()?.scrollToIndex(index, { align: "start", smooth: behavior === "smooth" })
        retryAnchorRestore(snapshot, behavior, 6, finishRestore)
        return
      }
    }

    applyPixelSnapshot(snapshot, behavior)
    requestAnimationFrame(finishRestore)
  }

  function retryAnchorRestore(snapshot: VirtualFollowScrollSnapshot, behavior: ScrollBehavior, remainingFrames: number, onApplied?: () => void) {
    requestAnimationFrame(() => {
      const applied = applyAnchorSnapshot(snapshot)
      if (applied) {
        requestAnimationFrame(() => {
          applyAnchorSnapshot(snapshot)
          onApplied?.()
        })
        return
      }

      if (remainingFrames > 0) {
        retryAnchorRestore(snapshot, behavior, remainingFrames - 1, onApplied)
        return
      }

      applyPixelSnapshot(snapshot, behavior)
      requestAnimationFrame(() => onApplied?.())
    })
  }

  function updateScrollButtons() {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return

    const offset = getCurrentScrollOffset(element, handle)
    const now = performance.now()
    const programmatic = hasProgrammaticScrollIntent()
    const metrics = getDomMetrics(element, handle, offset)
    const atBottom = isAtBottom(metrics)
    const atTop = offset <= (props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX)

    const hasItems = props.items().length > 0
    setShowScrollBottomButton(hasItems && !atBottom)
    setShowScrollTopButton(hasItems && !atTop)

    const result = scrollController.observeViewport(metrics, now, programmatic, canRejoinFollowFromDownScroll(metrics))
    if (result.state.mode.type !== followMode().type || result.effect.type !== "none") {
      suppressHoldUntilTargetChanges = false
    }
    syncControllerResult(result)
  }

  function performScrollToBottom(immediate = true) {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || props.items().length === 0) return
    if (immediate && element) {
      markProgrammaticScroll()
      handle.scrollToIndex(props.items().length - 1, { align: "end", smooth: false })
      pinDomBottomAfterLayout()
      return
    }
    markProgrammaticScroll()
    handle.scrollToIndex(props.items().length - 1, { align: "end", smooth: !immediate })
  }

  function pinDomBottomAfterLayout(remainingFrames = 2) {
    const element = scrollElement()
    if (!element) return
    if (!autoScroll() || effectiveSuspendAutoPinToBottom() || scrollController.snapshot().restoring) return
    if (shouldHonorPrePinEscape() && escapeFollowIfDomMovedUp(element)) return

    const handle = virtuaHandle()
    const maxOffset = Math.max((handle?.scrollSize ?? element.scrollHeight) - (handle?.viewportSize ?? element.clientHeight), 0)
    scrollToOffset(maxOffset, true)
    if (remainingFrames <= 0) return

    requestAnimationFrame(() => {
      if (!autoScroll() || effectiveSuspendAutoPinToBottom() || scrollController.snapshot().restoring) return
      pinDomBottomAfterLayout(remainingFrames - 1)
    })
  }

  function performScrollToTop(immediate = true) {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle) return
    if (immediate && element) {
      scrollToOffset(0, false)
      return
    }
    markProgrammaticScroll()
    handle.scrollToIndex(0, { align: "start", smooth: !immediate })
  }

  function performScrollToKey(key: string, opts: { block: ScrollLogicalPosition; smooth: boolean }) {
    const index = props.items().findIndex((item, i) => props.getKey(item, i) === key)
    if (index === -1) return
    markProgrammaticScroll()
    virtuaHandle()?.scrollToIndex(index, { align: opts.block, smooth: opts.smooth })
  }

  function scrollToBottom(immediate = true, options?: { suppressAutoAnchor?: boolean; suppressHold?: boolean }) {
    if (options?.suppressAutoAnchor ?? !immediate) {
      suppressAutoScrollOnce = true
    }
    dispatchFollowEvent({ type: "jump-bottom", immediate, explicit: options?.suppressHold ?? false })
  }

  function scrollToTop(immediate = true) {
    dispatchFollowEvent({ type: "jump-top", immediate })
  }

  function handleScroll() {
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

  function alignHoldTarget(key: string) {
    const element = scrollElement()
    if (!element) return
    const itemWrapper = itemElements.get(key)
    if (!itemWrapper) return
    const target = props.resolveAutoPinHoldElement?.(itemWrapper, key) ?? itemWrapper
    const containerRect = element.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const relativeTop = targetRect.top - containerRect.top
    const alignDelta = relativeTop - holdTargetTopThresholdPx()
    if (Math.abs(alignDelta) > 1) {
      scrollToOffset((virtuaHandle()?.scrollOffset ?? element.scrollTop) + alignDelta, false)
    }
  }

  function updateAutoPinHold() {
    const element = scrollElement()
    if (!element) return

    const targetKey = holdTargetKey()
    const heldKey = activeHoldTargetKey()

    if (heldKey !== null) {
      if (targetKey !== heldKey) {
        dispatchFollowEvent({ type: "hold-target-changed", key: targetKey, canPinToBottom: !externalSuspendAutoPinToBottom() })
      }

      return
    }

    if (!streamingActive()) return
    if (!autoScroll()) return
    if (externalSuspendAutoPinToBottom()) return
    if (!targetKey) return
    if (didTriggerHoldForCurrentTarget()) return
    if (suppressHoldUntilTargetChanges) return

    const itemWrapper = itemElements.get(targetKey)
    if (!itemWrapper) return
    const target = props.resolveAutoPinHoldElement?.(itemWrapper, targetKey) ?? itemWrapper

    const containerRect = element.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const relativeTop = targetRect.top - containerRect.top
    const exceedsViewport = targetRect.height > element.clientHeight

    if (exceedsViewport && relativeTop < 0) {
      dispatchFollowEvent({ type: "hold-candidate", key: targetKey, shouldHold: true })
      setDidTriggerHoldForCurrentTarget(true)
    }
  }

  const api: VirtualFollowListApi = {
    scrollToTop: (opts) => scrollToTop(opts?.immediate ?? true),
    scrollToBottom: (opts) => scrollToBottom(opts?.immediate ?? true, { suppressAutoAnchor: opts?.suppressAutoAnchor, suppressHold: opts?.suppressHold }),
    scrollToKey: (key, opts) => {
      const index = props.items().findIndex((item, i) => props.getKey(item, i) === key)
      if (index === -1) return
      const nextAutoScroll = opts?.setAutoScroll ?? false
      dispatchFollowEvent({
        type: "jump-key",
        key,
        block: opts?.block ?? "start",
        smooth: opts?.behavior === "smooth",
        followAfter: nextAutoScroll,
      })
    },
    notifyContentRendered: () => {
      if (shouldHonorPrePinEscape() && escapeFollowIfDomMovedUp()) {
        updateScrollButtons()
        return
      }
      updateAutoPinHold()
      if (activeHoldTargetKey() !== null) {
        if (autoScroll() && streamingActive()) pendingBottomRepinAfterHold = true
        updateScrollButtons()
        return
      }
      const canPinToBottom = autoScroll() && !effectiveSuspendAutoPinToBottom()
      dispatchFollowEvent({ type: "content-grew", canPinToBottom })
      updateScrollButtons()
    },
    setAutoScroll: (enabled) => dispatchFollowEvent({ type: "set-follow", enabled: Boolean(enabled) }),
    getAutoScroll: () => autoScroll(),
    getScrollElement: () => scrollElement(),
    getShellElement: () => shellElement(),
    captureScrollSnapshot,
    restoreScrollSnapshot,
  }

  createEffect(() => props.registerApi?.(api))
  createEffect(() => props.registerState?.(state))

  createEffect(on(() => props.resetKey?.(), () => {
    itemElements.clear()
    setDidTriggerHoldForCurrentTarget(false)
    suppressHoldUntilTargetChanges = false
    pendingBottomRepinAfterHold = false
  }))

  createEffect(on(holdTargetKey, (nextTargetKey, prevTargetKey) => {
    if (nextTargetKey !== prevTargetKey && didTriggerHoldForCurrentTarget()) {
      setDidTriggerHoldForCurrentTarget(false)
    }
    if (nextTargetKey !== prevTargetKey) {
      suppressHoldUntilTargetChanges = false
    }
    if (activeHoldTargetKey() === null) return
    if (nextTargetKey === activeHoldTargetKey()) return
    dispatchFollowEvent({ type: "hold-target-changed", key: nextTargetKey, canPinToBottom: !externalSuspendAutoPinToBottom() })
    if (pendingBottomRepinAfterHold) {
      pendingBottomRepinAfterHold = false
      requestAnimationFrame(() => pinDomBottomAfterLayout())
    }
  }, { defer: true }))

  // Handle autoScroll (Follow) on items change
  createEffect(on(() => props.items().length, (len, prevLen) => {
    if (pendingInitialScroll && isActive() && len > 0) {
      pendingInitialScroll = false
      if (initialScrollToBottom()) {
        dispatchFollowEvent({ type: "jump-bottom", immediate: true, explicit: false })
      }
      suppressAutoScrollOnce = false
      return
    }
    if (len > (prevLen ?? 0) && autoScroll() && !effectiveSuspendAutoPinToBottom() && !suppressAutoScrollOnce) {
      requestAnimationFrame(() => {
        dispatchFollowEvent({ type: "content-grew", canPinToBottom: autoScroll() && !effectiveSuspendAutoPinToBottom() })
      })
    }
    suppressAutoScrollOnce = false
  }, { defer: true }))

  // Handle followToken change
  createEffect(on(() => props.followToken?.(), () => {
    const canPinToBottom = autoScroll() && !effectiveSuspendAutoPinToBottom()
    if (canPinToBottom) {
      dispatchFollowEvent({ type: "content-grew", canPinToBottom })
    }
  }, { defer: true }))

  // Reset state on resetKey change
  createEffect(on(() => props.resetKey?.(), (nextKey) => {
    if (nextKey === lastResetKey) return
    lastResetKey = nextKey
    dispatchFollowEvent({ type: "reset", follow: Boolean(initialAutoScroll()) })
    pendingInitialScroll = true
  }))

  // Initial scroll and session activation
  createEffect(on(isActive, (active) => {
    if (!active) return
    if (pendingInitialScroll && props.items().length > 0) {
      pendingInitialScroll = false
      if (initialScrollToBottom()) {
        dispatchFollowEvent({ type: "jump-bottom", immediate: true, explicit: false })
      }
    } else if (autoScroll() && scrollToBottomOnActivate()) {
      dispatchFollowEvent({ type: "jump-bottom", immediate: true, explicit: false })
    }
  }))

  onCleanup(() => {
    detachScrollIntentListeners?.()
    detachScrollIntentListeners = undefined
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
            <button type="button" class="message-scroll-button" onClick={() => scrollToBottom(true, { suppressHold: true })} aria-label={props.scrollToBottomAriaLabel!()}>
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
