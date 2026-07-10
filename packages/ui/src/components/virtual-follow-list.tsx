import { Show, createEffect, createMemo, createSignal, type Accessor, type JSX, on, onCleanup } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { AnchorRestoreStabilizer, BOTTOM_FOLLOW_EPSILON_PX, getFollowSnapshotState, isAtBottom, isAutoFollowing, resolveAutoPinHoldElement, restoreFollowModeFromSnapshot, ScrollRestoreTokenGuard, selectTopViewportAnchor, VirtualScrollController, type FollowEffect, type FollowEvent, type FollowMode, type HoldTargetElementResolver, type ScrollControllerMetrics, type ScrollControllerResult } from "./virtual-follow-behavior.ts"

const DEFAULT_HOLD_TARGET_TOP_THRESHOLD_PX = 8
const EXPLICIT_BOTTOM_PIN_SETTLE_FRAMES = 2
const TOP_SCROLL_EPSILON_PX = 0
const EXPLICIT_BOTTOM_PIN_MAX_FRAMES = 90
const USER_SCROLL_INTENT_WINDOW_MS = 600
const PROGRAMMATIC_SCROLL_WINDOW_MS = 120
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])
const INTERACTIVE_KEY_TARGET_SELECTOR = "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='textbox']"

export interface VirtualExplicitBottomPinIntent {
  token: string | number
  minItemCount?: number
}

export interface VirtualFollowListApi {
  scrollToTop: (opts?: { immediate?: boolean }) => void
  scrollToBottom: (opts?: { immediate?: boolean }) => void
  scrollToKey: (
    key: string,
    opts?: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition },
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
  followModeType?: FollowMode["type"]
}

interface RestoreScrollSnapshotOptions {
  behavior?: ScrollBehavior
  fallback?: () => void
  onApplied?: () => void
  onCancelled?: () => void
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
  getAnchorId?: (key: string) => string
  overscanPx?: number
  streamingActive?: Accessor<boolean>
  isActive?: Accessor<boolean>
  autoPinHoldEnabled?: Accessor<boolean>
  scrollToBottomOnActivate?: Accessor<boolean>
  initialScrollToBottom?: Accessor<boolean>
  initialAutoScroll?: Accessor<boolean>
  resetKey?: Accessor<string | number>
  followToken?: Accessor<string | number>
  explicitBottomPinIntent?: Accessor<VirtualExplicitBottomPinIntent | null>
  autoPinHoldTargetKey?: Accessor<string | null>
  resolveAutoPinHoldElement?: HoldTargetElementResolver
  autoPinHoldTopThresholdPx?: number
  suspendAutoPinToBottom?: Accessor<boolean>
  renderBeforeItems?: Accessor<JSX.Element>
  renderOverlay?: Accessor<JSX.Element>
  scrollToTopAriaLabel?: Accessor<string>
  scrollToBottomAriaLabel?: Accessor<string>
  onScrollElementChange?: (element: HTMLDivElement | undefined) => void
  onShellElementChange?: (element: HTMLDivElement | undefined) => void
  onScroll?: () => void
  onExplicitBottomPinCancelled?: () => void
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
  const [followMode, setFollowMode] = createSignal<FollowMode>({ type: props.initialAutoScroll?.() ?? true ? "following" : "escaped" })
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [activeKey, setActiveKey] = createSignal<string | null>(null)

  const isActive = () => props.isActive?.() ?? true
  const initialScrollToBottom = () => props.initialScrollToBottom?.() ?? true
  const initialAutoScroll = () => props.initialAutoScroll?.() ?? true
  const scrollToBottomOnActivate = () => props.scrollToBottomOnActivate?.() ?? true
  const streamingActive = () => props.streamingActive?.() ?? false
  const autoPinHoldEnabled = () => props.autoPinHoldEnabled?.() ?? true
  const holdTargetKey = () => props.autoPinHoldTargetKey?.() ?? null
  const externalSuspendAutoPinToBottom = () => props.suspendAutoPinToBottom?.() ?? false
  const explicitBottomPinIntent = () => props.explicitBottomPinIntent?.() ?? null
  const holdTargetTopThresholdPx = () => props.autoPinHoldTopThresholdPx ?? DEFAULT_HOLD_TARGET_TOP_THRESHOLD_PX
  const autoScroll = createMemo(() => isAutoFollowing(followMode()))
  const scrollButtonsCount = createMemo(() => (showScrollTopButton() ? 1 : 0) + (showScrollBottomButton() ? 1 : 0))

  const scrollController = new VirtualScrollController(initialAutoScroll())
  const itemElements = new Map<string, HTMLDivElement>()
  const state: VirtualFollowListState = { autoScroll, showScrollTopButton, showScrollBottomButton, scrollButtonsCount, activeKey }

  let detachScrollIntentListeners: (() => void) | undefined
  const restoreToken = new ScrollRestoreTokenGuard()
  let restartAnchorRestore: (() => void) | undefined
  let cancelRestore: (() => void) | undefined
  let lastResetKey: string | number | undefined = props.resetKey?.()
  let pendingInitialScroll = true
  let pendingContentRenderedFrame: number | null = null
  let pendingExplicitBottomPinFrame: number | null = null
  let explicitBottomPinToken: string | number | null = null
  let userCancelledExplicitBottomPinToken: string | number | null = null
  let explicitBottomPinMinItemCount = 0
  let explicitBottomPinSettleFrames = 0
  let explicitBottomPinFramesRemaining = 0
  let programmaticScrollUntil = 0

  function invalidateScrollRestore() {
    restoreToken.invalidate()
    restartAnchorRestore = undefined
    cancelRestore = undefined
    scrollController.setRestoring(false)
  }

  function cancelActiveScrollRestore() {
    const onCancelled = cancelRestore
    if (!onCancelled) return
    invalidateScrollRestore()
    onCancelled()
  }

  function syncControllerResult(result: ScrollControllerResult) {
    setFollowMode(result.state.mode)
    applyFollowEffect(result.effect)
  }

  function dispatchFollowEvent(event: FollowEvent) {
    switch (event.type) {
      case "user-scroll": return syncControllerResult(scrollController.observeViewport(getManualMetrics(event.atBottom), performance.now(), hasProgrammaticScrollIntent()))
      case "jump-top": return syncControllerResult(scrollController.jumpTop(event.immediate))
      case "jump-bottom": return syncControllerResult(scrollController.jumpBottom(event.immediate, event.explicit))
      case "jump-key": return syncControllerResult(scrollController.jumpKey(event.key, event.block, event.smooth))
      case "content-grew": return syncControllerResult(scrollController.contentRendered(getCurrentMetrics(), event.canPinToBottom))
      case "set-follow": return syncControllerResult(scrollController.setFollow(event.enabled))
      case "reset": return syncControllerResult(scrollController.reset(event.follow))
    }
  }

  function applyFollowEffect(effect: FollowEffect) {
    switch (effect.type) {
      case "none":
        return
      case "scroll-top": return performScrollToTop(effect.immediate)
      case "scroll-bottom": return performScrollToBottom(effect.immediate)
      case "scroll-key": return performScrollToKey(effect.key, { block: effect.block, smooth: effect.smooth })
    }
  }

  function markUserScrollIntent(direction: "up" | "down" | null) {
    cancelActiveScrollRestore()
    scrollController.setUserIntent(direction, performance.now() + USER_SCROLL_INTENT_WINDOW_MS)
    if (direction === "up") {
      if (hasActiveExplicitBottomPin() || explicitBottomPinIntent()) cancelExplicitBottomPinFromUser()
      dispatchFollowEvent({ type: "user-scroll", direction: "up", atBottom: isActuallyAtBottom() })
    } else if (direction === "down" && isActuallyAtBottom()) {
      dispatchFollowEvent({ type: "user-scroll", direction: "down", atBottom: true })
    }
  }

  function markProgrammaticScroll() {
    programmaticScrollUntil = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS
  }

  function hasProgrammaticScrollIntent() {
    return performance.now() <= programmaticScrollUntil
  }

  function getCurrentMetrics(): ScrollControllerMetrics {
    const element = scrollElement()
    if (!element) return getManualMetrics(false)
    return getDomMetrics(element)
  }

  function getDomMetrics(element: HTMLDivElement, handle = virtuaHandle(), offset = handle?.scrollOffset ?? element.scrollTop): ScrollControllerMetrics {
    return {
      offset,
      scrollHeight: handle?.scrollSize ?? element.scrollHeight,
      clientHeight: handle?.viewportSize ?? element.clientHeight,
      sentinelMarginPx: BOTTOM_FOLLOW_EPSILON_PX,
    }
  }

  function getManualMetrics(atBottom: boolean): ScrollControllerMetrics {
    const clientHeight = 1000
    return {
      offset: 0,
      scrollHeight: atBottom ? clientHeight : clientHeight * 2,
      clientHeight,
      sentinelMarginPx: BOTTOM_FOLLOW_EPSILON_PX,
    }
  }

  function isActuallyAtBottom() {
    const element = scrollElement()
    if (!element) return false
    return isAtBottom(getDomMetrics(element))
  }

  function scrollToOffset(offset: number, atBottom: boolean) {
    const element = scrollElement()
    if (!element) return
    const handle = virtuaHandle()
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

  function performScrollToBottom(immediate = true) {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (props.items().length === 0) return
    markProgrammaticScroll()
    if (handle) {
      handle.scrollToIndex(props.items().length - 1, { align: "end", smooth: !immediate })
    } else if (element) {
      scrollToOffset(element.scrollHeight - element.clientHeight, true)
    }
    pinDomBottomAfterLayout()
  }

  function pinDomBottomAfterLayout(remainingFrames = 2) {
    const element = scrollElement()
    if (!element || !autoScroll() || externalSuspendAutoPinToBottom() || scrollController.snapshot().restoring) return
    const handle = virtuaHandle()
    const maxOffset = Math.max((handle?.scrollSize ?? element.scrollHeight) - (handle?.viewportSize ?? element.clientHeight), 0)
    scrollToOffset(maxOffset, true)
    if (remainingFrames <= 0) return
    requestAnimationFrame(() => pinDomBottomAfterLayout(remainingFrames - 1))
  }

  function performScrollToTop(immediate = true) {
    const handle = virtuaHandle()
    if (immediate) {
      scrollToOffset(0, false)
      return
    }
    if (!handle) return
    markProgrammaticScroll()
    handle.scrollToIndex(0, { align: "start", smooth: true })
  }

  function performScrollToKey(key: string, opts: { block: ScrollLogicalPosition; smooth: boolean }) {
    const index = props.items().findIndex((item, i) => props.getKey(item, i) === key)
    if (index === -1) return
    markProgrammaticScroll()
    virtuaHandle()?.scrollToIndex(index, { align: opts.block, smooth: opts.smooth })
  }

  function updateScrollStateFromDom() {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return

    const offset = handle.scrollOffset
    const metrics = getDomMetrics(element, handle, offset)
    const atBottom = isAtBottom(metrics)
    const atTop = offset <= TOP_SCROLL_EPSILON_PX
    const hasItems = props.items().length > 0
    setShowScrollBottomButton(hasItems && !atBottom)
    setShowScrollTopButton(hasItems && !atTop)

    const now = performance.now()
    const programmatic = hasProgrammaticScrollIntent()
    const result = scrollController.observeViewport(metrics, now, programmatic)
    if (result.state.mode.type === "escaped" && explicitBottomPinIntent()) {
      cancelExplicitBottomPinFromUser()
    }
    syncControllerResult(result)
  }

  function handleScroll() {
    updateScrollStateFromDom()
    props.onScroll?.()

    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return
    const start = handle.findItemIndex(handle.scrollOffset)
    const item = props.items()[start]
    if (!item) return
    const key = props.getKey(item, start)
    if (key !== activeKey()) {
      setActiveKey(key)
      props.onActiveKeyChange?.(key)
    }
  }

  function getAnchorIdForKey(key: string) {
    return props.getAnchorId ? props.getAnchorId(key) : key
  }

  function registerItemElement(key: string, element: HTMLDivElement | null | undefined) {
    if (!element) {
      itemElements.delete(key)
      return
    }
    itemElements.set(key, element)
  }

  function maybeEscapeForHoldTrigger() {
    if (!streamingActive() || !autoPinHoldEnabled() || !autoScroll() || externalSuspendAutoPinToBottom()) return false
    const element = scrollElement()
    const key = holdTargetKey()
    if (!element || !key) return false
    const target = resolveAutoPinHoldElement(itemElements.get(key), key, props.resolveAutoPinHoldElement)
    if (!target) return false

    const containerRect = element.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    if (targetRect.height <= element.clientHeight) return false
    if (targetRect.top - containerRect.top - holdTargetTopThresholdPx() > 1) return false

    dispatchFollowEvent({ type: "set-follow", enabled: false })
    scrollController.recordProgrammaticOffset(virtuaHandle()?.scrollOffset ?? element.scrollTop, isActuallyAtBottom())
    return true
  }

  function flushContentRendered() {
    pendingContentRenderedFrame = null
    if (restartAnchorRestore) {
      restartAnchorRestore()
      updateScrollStateFromDom()
      return
    }
    if (hasActiveExplicitBottomPin()) {
      scheduleExplicitBottomPinFrame()
      updateScrollStateFromDom()
      return
    }

    if (maybeEscapeForHoldTrigger()) {
      updateScrollStateFromDom()
      return
    }

    dispatchFollowEvent({ type: "content-grew", canPinToBottom: autoScroll() && !externalSuspendAutoPinToBottom() })
    updateScrollStateFromDom()
  }

  function hasActiveExplicitBottomPin() {
    return explicitBottomPinToken !== null
  }

  function clearExplicitBottomPin() {
    explicitBottomPinToken = null
    explicitBottomPinMinItemCount = 0
    explicitBottomPinSettleFrames = 0
    explicitBottomPinFramesRemaining = 0
  }

  function cancelExplicitBottomPinFromUser() {
    userCancelledExplicitBottomPinToken = explicitBottomPinToken ?? explicitBottomPinIntent()?.token ?? null
    clearExplicitBottomPin()
    props.onExplicitBottomPinCancelled?.()
  }

  function startExplicitBottomPin(intent: VirtualExplicitBottomPinIntent) {
    cancelActiveScrollRestore()
    userCancelledExplicitBottomPinToken = null
    explicitBottomPinToken = intent.token
    explicitBottomPinMinItemCount = Math.max(0, Math.floor(intent.minItemCount ?? 0))
    explicitBottomPinSettleFrames = EXPLICIT_BOTTOM_PIN_SETTLE_FRAMES
    explicitBottomPinFramesRemaining = EXPLICIT_BOTTOM_PIN_MAX_FRAMES
    runExplicitBottomPinFrame()
  }

  function scheduleExplicitBottomPinFrame() {
    if (!hasActiveExplicitBottomPin() || pendingExplicitBottomPinFrame !== null) return
    pendingExplicitBottomPinFrame = requestAnimationFrame(() => runExplicitBottomPinFrame())
  }

  function runExplicitBottomPinFrame() {
    pendingExplicitBottomPinFrame = null
    if (!hasActiveExplicitBottomPin()) return
    dispatchFollowEvent({ type: "jump-bottom", immediate: true, explicit: true })

    const ready = props.items().length >= explicitBottomPinMinItemCount && isActuallyAtBottom()
    if (ready) explicitBottomPinSettleFrames -= 1
    else explicitBottomPinSettleFrames = EXPLICIT_BOTTOM_PIN_SETTLE_FRAMES
    explicitBottomPinFramesRemaining -= 1

    if ((ready && explicitBottomPinSettleFrames <= 0) || explicitBottomPinFramesRemaining <= 0) {
      clearExplicitBottomPin()
      return
    }
    scheduleExplicitBottomPinFrame()
  }

  function captureScrollSnapshot(): VirtualFollowScrollSnapshot | undefined {
    const element = scrollElement()
    if (!element) return undefined
    const handle = virtuaHandle()
    const scrollTop = handle?.scrollOffset ?? element.scrollTop
    const scrollHeight = handle?.scrollSize ?? element.scrollHeight
    const clientHeight = handle?.viewportSize ?? element.clientHeight
    const maxScrollTop = Math.max(scrollHeight - clientHeight, 0)
    const atBottom = isAtBottom(getDomMetrics(element, handle, scrollTop))
    const snapshot: VirtualFollowScrollSnapshot = {
      scrollTop,
      scrollRatio: maxScrollTop > 0 ? scrollTop / maxScrollTop : 0,
      maxScrollTop,
      atBottom,
      ...getFollowSnapshotState(followMode()),
    }
    if (!atBottom) {
      const anchor = findTopVisibleAnchor(element)
      if (anchor) {
        snapshot.anchorKey = anchor.key
        snapshot.anchorOffset = anchor.offset
      }
    }
    return snapshot
  }

  function findTopVisibleAnchor(element: HTMLDivElement) {
    const containerRect = element.getBoundingClientRect()
    const candidates = []
    for (const [key, itemElement] of itemElements) {
      if (!itemElement.isConnected) continue
      const rect = itemElement.getBoundingClientRect()
      candidates.push({ key, top: rect.top, bottom: rect.bottom })
    }
    const handle = virtuaHandle()
    const index = handle?.findItemIndex(handle.scrollOffset)
    const item = typeof index === "number" ? props.items()[index] : undefined
    const preferredKey = item === undefined || index === undefined ? undefined : props.getKey(item, index)
    const anchor = selectTopViewportAnchor(candidates, containerRect.top, containerRect.bottom, preferredKey)
    return anchor ? { key: anchor.key, offset: anchor.top - containerRect.top } : null
  }

  function restoreScrollSnapshot(snapshot: VirtualFollowScrollSnapshot, opts?: RestoreScrollSnapshotOptions) {
    const element = scrollElement()
    if (!element) {
      opts?.fallback?.()
      return
    }
    if (hasActiveExplicitBottomPin()) {
      scheduleExplicitBottomPinFrame()
      opts?.onApplied?.()
      return
    }

    const token = restoreToken.begin()
    const isCurrent = () => restoreToken.isCurrent(token) && Boolean(scrollElement())
    restartAnchorRestore = undefined
    scrollController.setRestoring(true)
    cancelRestore = () => opts?.onCancelled?.()

    const finish = () => {
      if (!isCurrent()) return
      restartAnchorRestore = undefined
      cancelRestore = undefined
      const mode = restoreFollowModeFromSnapshot(snapshot)
      setFollowMode(mode)
      scrollController.restoreMode(mode)
      scrollController.setRestoring(false)
      opts?.onApplied?.()
    }

    if (snapshot.atBottom) {
      performScrollToBottom(true)
      requestAnimationFrame(finish)
      return
    }

    if (snapshot.anchorKey) {
      const index = props.items().findIndex((item, i) => props.getKey(item, i) === snapshot.anchorKey)
      if (index !== -1) {
        markProgrammaticScroll()
        virtuaHandle()?.scrollToIndex(index, { align: "start", smooth: opts?.behavior === "smooth" })
        const stabilizer = new AnchorRestoreStabilizer()
        restartAnchorRestore = () => {
          if (!isCurrent()) return
          stabilizer.restartStability()
          scrollToAnchorIndex(snapshot.anchorKey!)
        }
        retryAnchorRestore(snapshot, stabilizer, isCurrent, finish)
        return
      }
    }

    applyPixelSnapshot(snapshot, opts?.behavior ?? "auto")
    requestAnimationFrame(finish)
  }

  function scrollToAnchorIndex(key: string) {
    const index = props.items().findIndex((item, i) => props.getKey(item, i) === key)
    if (index === -1) return false
    markProgrammaticScroll()
    virtuaHandle()?.scrollToIndex(index, { align: "start", smooth: false })
    return true
  }

  function retryAnchorRestore(snapshot: VirtualFollowScrollSnapshot, stabilizer: AnchorRestoreStabilizer, isCurrent: () => boolean, onApplied: () => void) {
    requestAnimationFrame(() => {
      if (!isCurrent()) return
      const element = scrollElement()
      const key = snapshot.anchorKey!
      const targetExists = props.items().some((item, index) => props.getKey(item, index) === key)
      const itemWrapper = itemElements.get(key)
      const anchorOffset = snapshot.anchorOffset
      const mounted = Boolean(element && itemWrapper?.isConnected)
      const delta = mounted && element && itemWrapper && typeof anchorOffset === "number"
        ? itemWrapper.getBoundingClientRect().top - element.getBoundingClientRect().top - anchorOffset
        : undefined
      const result = stabilizer.nextFrame({ targetExists, mounted, delta })

      if (result.type === "finish") {
        onApplied()
        return
      }
      if (result.type === "correct" && element) {
        scrollToOffset((virtuaHandle()?.scrollOffset ?? element.scrollTop) + result.delta, false)
        if (result.finishAfterCorrection) {
          restartAnchorRestore = () => {}
          requestAnimationFrame(onApplied)
          return
        }
      }
      if (result.type === "retry" && result.reissueIndex) scrollToAnchorIndex(key)
      if (result.type !== "fallback") {
        retryAnchorRestore(snapshot, stabilizer, isCurrent, onApplied)
        return
      }
      applyPixelSnapshot(snapshot, "auto")
      onApplied()
    })
  }

  function applyPixelSnapshot(snapshot: VirtualFollowScrollSnapshot, behavior: ScrollBehavior) {
    const element = scrollElement()
    if (!element) return
    const handle = virtuaHandle()
    const maxScrollTop = Math.max((handle?.scrollSize ?? element.scrollHeight) - (handle?.viewportSize ?? element.clientHeight), 0)
    const nextTop = snapshot.atBottom
      ? maxScrollTop
      : typeof snapshot.scrollRatio === "number" && snapshot.maxScrollTop !== maxScrollTop
        ? Math.min(Math.max(snapshot.scrollRatio, 0), 1) * maxScrollTop
        : Math.min(snapshot.scrollTop, maxScrollTop)
    if (behavior === "smooth" && !handle) {
      markProgrammaticScroll()
      element.scrollTo({ top: nextTop, behavior })
      scrollController.recordProgrammaticOffset(nextTop, snapshot.atBottom)
      return
    }
    scrollToOffset(nextTop, snapshot.atBottom)
  }

  function attachScrollIntentListeners(element: HTMLDivElement | undefined) {
    detachScrollIntentListeners?.()
    detachScrollIntentListeners = undefined
    if (!element) return
    const handleWheelIntent = (event: WheelEvent) => markUserScrollIntent(event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : null)
    const handlePointerIntent = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(INTERACTIVE_KEY_TARGET_SELECTOR)) return
      markUserScrollIntent(null)
    }
    let lastTouchY: number | null = null
    const handleTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null
      markUserScrollIntent(null)
    }
    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null
      const previousY = lastTouchY
      lastTouchY = nextY
      if (nextY === null || previousY === null) {
        markUserScrollIntent(null)
        return
      }
      markUserScrollIntent(nextY > previousY ? "up" : nextY < previousY ? "down" : null)
    }
    const handleTouchEnd = () => {
      lastTouchY = null
    }
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (!isActive()) return
      if (!SCROLL_INTENT_KEYS.has(event.key)) return
      if ((event.target as HTMLElement | null)?.closest(INTERACTIVE_KEY_TARGET_SELECTOR)) return
      if (event.key === "End") {
        event.preventDefault()
        scrollToBottom(true)
        return
      }
      if (event.key === "Home") {
        event.preventDefault()
        scrollToTop(true)
        return
      }
      const direction = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.shiftKey && (event.key === " " || event.key === "Spacebar"))
        ? "up"
        : "down"
      markUserScrollIntent(direction)
    }
    element.addEventListener("wheel", handleWheelIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("touchstart", handleTouchStart, { passive: true })
    element.addEventListener("touchmove", handleTouchMove, { passive: true })
    element.addEventListener("touchend", handleTouchEnd, { passive: true })
    element.addEventListener("touchcancel", handleTouchEnd, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handleWheelIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("touchstart", handleTouchStart)
      element.removeEventListener("touchmove", handleTouchMove)
      element.removeEventListener("touchend", handleTouchEnd)
      element.removeEventListener("touchcancel", handleTouchEnd)
      element.removeEventListener("keydown", handleKeyIntent)
    }
  }

  function scrollToBottom(immediate = true) {
    cancelActiveScrollRestore()
    dispatchFollowEvent({ type: "jump-bottom", immediate, explicit: true })
  }

  function scrollToTop(immediate = true) {
    cancelActiveScrollRestore()
    dispatchFollowEvent({ type: "jump-top", immediate })
  }

  function scrollToKey(key: string, opts?: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition }) {
    cancelActiveScrollRestore()
    dispatchFollowEvent({ type: "jump-key", key, block: opts?.block ?? "start", smooth: opts?.behavior === "smooth" })
  }

  const api: VirtualFollowListApi = {
    scrollToTop: (opts) => scrollToTop(opts?.immediate ?? true),
    scrollToBottom: (opts) => scrollToBottom(opts?.immediate ?? true),
    scrollToKey,
    notifyContentRendered: () => {
      if (restartAnchorRestore) {
        restartAnchorRestore()
        return
      }
      if (pendingContentRenderedFrame !== null) return
      pendingContentRenderedFrame = requestAnimationFrame(() => flushContentRendered())
    },
    setAutoScroll: (enabled) => dispatchFollowEvent({ type: "set-follow", enabled }),
    getAutoScroll: () => autoScroll(),
    getScrollElement: () => scrollElement(),
    getShellElement: () => shellElement(),
    captureScrollSnapshot,
    restoreScrollSnapshot,
  }

  createEffect(() => props.registerApi?.(api))
  createEffect(() => props.registerState?.(state))

  createEffect(on(explicitBottomPinIntent, (intent) => {
    if (!intent) {
      userCancelledExplicitBottomPinToken = null
      clearExplicitBottomPin()
      return
    }
    if (intent.token === userCancelledExplicitBottomPinToken) return
    if (intent.token === explicitBottomPinToken) return
    startExplicitBottomPin(intent)
  }))

  createEffect(on(() => props.items().length, (len, prevLen) => {
    if (pendingInitialScroll && isActive() && len > 0) {
      pendingInitialScroll = false
      if (initialScrollToBottom()) scrollToBottom(true)
      return
    }
    if (len > (prevLen ?? 0) && autoScroll()) api.notifyContentRendered()
  }, { defer: true }))

  createEffect(on(() => props.followToken?.(), () => {
    if (autoScroll()) api.notifyContentRendered()
  }, { defer: true }))

  createEffect(on(() => props.resetKey?.(), (nextKey) => {
    if (nextKey === lastResetKey) return
    lastResetKey = nextKey
    invalidateScrollRestore()
    clearExplicitBottomPin()
    dispatchFollowEvent({ type: "reset", follow: initialAutoScroll() })
    pendingInitialScroll = true
    itemElements.clear()
  }))

  createEffect(on(isActive, (active) => {
    if (!active) return
    if (pendingInitialScroll && props.items().length > 0) {
      pendingInitialScroll = false
      if (initialScrollToBottom()) scrollToBottom(true)
      return
    }
    if (autoScroll() && scrollToBottomOnActivate()) scrollToBottom(true)
  }))

  onCleanup(() => {
    invalidateScrollRestore()
    if (pendingContentRenderedFrame !== null) cancelAnimationFrame(pendingContentRenderedFrame)
    if (pendingExplicitBottomPinFrame !== null) cancelAnimationFrame(pendingExplicitBottomPinFrame)
    detachScrollIntentListeners?.()
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
        <Show when={props.renderBeforeItems}>{props.renderBeforeItems!()}</Show>
        <Virtualizer
          ref={setVirtuaHandle}
          scrollRef={scrollElement()}
          data={props.items()}
          bufferSize={props.overscanPx ?? 400}
          onScroll={handleScroll}
        >
          {(item, index) => {
            const key = props.getKey(item, index())
            return <div id={getAnchorIdForKey(key)} data-virtual-follow-key={key} ref={(element) => registerItemElement(key, element)}>{props.renderItem(item, index())}</div>
          }}
        </Virtualizer>
      </div>

      <Show when={props.renderOverlay}>
        <div class="virtual-follow-list-overlay">{props.renderOverlay!()}</div>
      </Show>

      <Show when={props.renderControls}>
        <div class="virtual-follow-list-controls-container">{props.renderControls!(state, api)}</div>
      </Show>

      <Show when={!props.renderControls && (showScrollTopButton() || showScrollBottomButton()) && props.scrollToTopAriaLabel && props.scrollToBottomAriaLabel}>
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button type="button" class="message-scroll-button" onClick={() => scrollToTop()} aria-label={props.scrollToTopAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">↑</span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button type="button" class="message-scroll-button" onClick={() => scrollToBottom(true)} aria-label={props.scrollToBottomAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">↓</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
