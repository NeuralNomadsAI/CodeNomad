import { Show, batch, createEffect, createMemo, createSignal, type Accessor, type JSX, on, onCleanup, untrack } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { trackHeightDelta } from "../lib/height-delta"
import { attachScrollGestureRouting, findNestedScroller, getElementZoom, POINTER_CONTROL_SELECTOR, wheelDeltaUnit } from "../lib/scroll-gesture-routing"
import { remapVirtualMeasurements } from "./virtual-follow-measurements"
import { createVirtualReaderSettlement } from "./virtual-reader-settlement"
import { advanceBottomPinSettlement, AnchorRestoreStabilizer, canScrollInDirection, classifyVirtualItemKeyChange, describeKeyTarget, getBottomAnchoredViewportOffset, getFollowSnapshotState, getKeyboardScrollIntent, getPrimaryPointerDragDirection, isAtBottomForMode, isAutoFollowing, isMiddleButtonScrollIntent, isScrollRestoreMeasurementReady, resolveAutoPinHoldElement, restoreFollowModeFromSnapshot, SCROLL_INTENT_KEYS, USER_SCROLL_INTENT_WINDOW_MS, ScrollRestoreTokenGuard, selectTopViewportAnchor, shouldNavigateAtBoundary, VirtualScrollController, type BottomPinSettlementState, type FollowEffect, type FollowEvent, type FollowMode, type HoldTargetElementResolver, type ScrollControllerMetrics, type ScrollControllerResult } from "./virtual-follow-behavior.ts"
import { isScrollTraceEnabled, traceScroll, type ScrollReason, type ScrollTraceEntry, type ScrollTraceKind } from "./virtual-scroll-trace"

const DEFAULT_HOLD_TARGET_TOP_THRESHOLD_PX = 8
const EXPLICIT_BOTTOM_PIN_SETTLE_FRAMES = 2
// List-owned settlements (latest paging, restoration) also outlast late row measurement.
const LOCAL_BOTTOM_PIN_SETTLE_FRAMES = 8
const FOLLOW_BOTTOM_PIN_FRAMES = 2
const MEASUREMENT_PROBE_COUNT = 8
const TOP_SCROLL_EPSILON_PX = 0
const EXPLICIT_BOTTOM_PIN_MAX_FRAMES = 90
const PROGRAMMATIC_SCROLL_WINDOW_MS = 120
const SCROLL_RESTORE_MEASUREMENT_MAX_FRAMES = 90
const ELEMENT_ALIGNMENT_BOTTOM_MARGIN_PX = 48

export interface VirtualExplicitBottomPinIntent {
  token: string | number
  minItemCount?: number
  settleFrames?: number
}

export type VirtualBottomSettlement = "settled" | "cancelled" | "interrupted" | "timeout"

export interface VirtualFollowListApi {
  scrollToTop: (opts?: { immediate?: boolean }) => void
  scrollToBottom: (opts?: { immediate?: boolean }) => void
  settleAtBottom: () => Promise<VirtualBottomSettlement>
  /** Places the keyed row at the top, holding it there for the alignment window. */
  scrollToKey: (key: string) => void
  notifyContentRendered: () => void
  /** Leaves follow mode and holds `target` at `viewportOffset` px below the viewport top, clamped into view. */
  alignElement: (target: HTMLElement, viewportOffset: number) => void
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

/** One transcript position write; see `writeScroll`. */
type ScrollWriteOp =
  /** Direct DOM write (the browser clamps it); `record` publishes the synchronous result before its scroll event. */
  | { type: "dom"; top: number; record: boolean }
  | { type: "native"; top: number; behavior: ScrollBehavior; record: boolean }

/**
 * The single bottom loop, which exists only while following: each frame
 * re-pins the bottom until `frames` runs out. Following re-pins for a few
 * frames after each bottom write while layout settles; an explicit pin
 * (`settle`) instead lasts until enough rows exist and the bottom stays put.
 */
interface BottomPin {
  reason: ScrollReason
  frames: number
  settle?: {
    /** The owner's intent token; absent for list-owned settlements. */
    token?: string | number
    minItemCount: number
    requiredStableFrames: number
    progress: BottomPinSettlementState
    resolve?: (settlement: VirtualBottomSettlement) => void
  }
}

interface RestoreScrollSnapshotOptions {
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
  renderItem: (item: T, index: Accessor<number>) => JSX.Element
  getAnchorId?: (key: string) => string
  overscanPx?: number
  streamingActive?: Accessor<boolean>
  isActive?: Accessor<boolean>
  autoPinHoldEnabled?: Accessor<boolean>
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
  /** Virtua's settled-scroll notification: no scroll for 150 ms and no active touch. */
  onScrollEnd?: () => void
  onJumpTop?: () => void
  onJumpBottom?: () => void
  onUserReachedTop?: () => void
  onUserReachedBottom?: () => void
  onScrollIntent?: (direction: "up" | "down" | null) => void
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
  const [beforeItemsElement, setBeforeItemsElement] = createSignal<HTMLDivElement>()
  const [beforeItemsHeight, setBeforeItemsHeight] = createSignal(0)
  const [virtuaHandle, setVirtuaHandle] = createSignal<VirtualizerHandle | undefined>()
  const [followMode, setFollowMode] = createSignal<FollowMode>({ type: props.initialAutoScroll?.() ?? true ? "following" : "escaped" })
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [activeKey, setActiveKey] = createSignal<string | null>(null)
  const [measurementAuthority, setMeasurementAuthority] = createSignal<{ cache?: VirtualizerHandle["cache"]; probes: number[]; pendingProbeKeys: string[] }>({ probes: [], pendingProbeKeys: [] })
  const [virtualItems, setVirtualItems] = createSignal<T[]>(props.items().slice())
  // Rows that left the head of a rolling window, kept as an empty prefix of
  // `virtualItems` (see the items effect); those below `collapsedCount` are
  // measured at zero and need not stay mounted.
  const [retiredCount, setRetiredCount] = createSignal(0)
  const [collapsedCount, setCollapsedCount] = createSignal(0)

  const isActive = () => props.isActive?.() ?? true
  const initialAutoScroll = () => props.initialAutoScroll?.() ?? true
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
  let pendingContentRenderedFrame: number | null = null
  let bottomPin: BottomPin | null = null
  let bottomPinFrame: number | null = null
  // The last intent token started or cancelled: an intent never restarts itself.
  let handledBottomPinToken: string | number | null = null
  let programmaticScrollUntil = 0
  // Trace-only attribution state, written only while the `scroll` trace is enabled.
  let lastTracedWrite: ScrollReason | undefined
  let lastTracedLanding: number | undefined
  let virtualItemKeys = virtualItems().map((item, index) => props.getKey(item, index))
  let plannedItems = virtualItems().slice()
  let plannedKeys = virtualItemKeys.slice()
  let windowShiftGeneration = 0
  let virtualContentResizeObserver: ResizeObserver | null = null
  let observedVirtualContent: HTMLElement | null = null
  let nativeScrollbarDragging = false

  function invalidateScrollRestore() {
    restoreToken.invalidate()
    restartAnchorRestore = undefined
    cancelRestore = undefined
    scrollController.setRestoring(false)
  }

  function cancelActiveScrollRestore() {
    readerSettlement.cancel()
    const onCancelled = cancelRestore
    if (!onCancelled) return
    invalidateScrollRestore()
    onCancelled()
  }

  /** A user gesture or explicit navigation supersedes restoration, alignment and any explicit bottom pin. */
  function supersedePositioning() {
    cancelActiveScrollRestore()
    if (bottomPin?.settle || explicitBottomPinIntent()) cancelExplicitBottomPin()
  }

  /**
   * Silently stops every list-owned positioning operation and its pending
   * frame, for deactivation, session reset and unmount. The owner of a
   * restoration fences its own callbacks on those transitions.
   */
  function stopPositioning() {
    readerSettlement.cancel()
    invalidateScrollRestore()
    endBottomPin("interrupted")
    if (pendingContentRenderedFrame !== null) cancelAnimationFrame(pendingContentRenderedFrame)
    pendingContentRenderedFrame = null
  }

  /** The only follow-mode write; `source` labels the transition and any scroll it causes. */
  function syncControllerResult(result: ScrollControllerResult, source: ScrollReason) {
    if (scrollTraceEnabled()) {
      const from = untrack(followMode).type
      if (from !== result.state.mode.type) trace("mode", { from, to: result.state.mode.type, source })
    }
    setFollowMode(result.state.mode)
    // A bottom pin is follow with a deadline: leaving follow ends it.
    if (bottomPin && !isAutoFollowing(result.state.mode)) {
      if (bottomPin.settle) cancelExplicitBottomPin()
      else endBottomPin("interrupted")
    }
    applyFollowEffect(result.effect, source)
  }

  function dispatchFollowEvent(event: Exclude<FollowEvent, { type: "user-scroll" }>, source: ScrollReason = event.type) {
    switch (event.type) {
      case "jump-top": return syncControllerResult(scrollController.jumpTop(event.immediate), source)
      case "jump-bottom": return syncControllerResult(scrollController.jumpBottom(event.immediate, event.explicit), source)
      case "jump-key": return syncControllerResult(scrollController.jumpKey(event.key, event.block, event.smooth), source)
      case "content-grew": return syncControllerResult(scrollController.contentRendered(event.canPinToBottom), source)
      case "set-follow": return syncControllerResult(scrollController.setFollow(event.enabled), source)
      case "reset": return syncControllerResult(scrollController.reset(event.follow), source)
    }
  }

  function applyFollowEffect(effect: FollowEffect, source: ScrollReason) {
    switch (effect.type) {
      case "none":
        return
      case "scroll-top": return performScrollToTop(effect.immediate, source)
      case "scroll-bottom": return performScrollToBottom(effect.immediate, source)
      case "scroll-key": return performScrollToKey(effect.key, source)
    }
  }

  const readerSettlement = createVirtualReaderSettlement({
    enabled: () => isActive() && !autoScroll() && !scrollController.snapshot().restoring,
    getAnchor: () => scrollElement() ? findTopVisibleAnchor(scrollElement()!) ?? undefined : undefined,
    align: (anchor) => {
      const element = scrollElement(), target = anchor.element ?? itemElements.get(anchor.key)
      // A virtual row may remount under its key; a detached revealed part is gone.
      if (!element || !target?.isConnected) return !anchor.element
      // A held element keeps its requested offset; only its application follows the viewport.
      const delta = measureAnchorDelta(element, target, anchor.element ? clampAlignmentOffset(element, anchor.offset) : anchor.offset)
      if (Math.abs(delta) >= 1) writeScroll(anchor.element ? "align-element" : "reader-settle", { type: "dom", top: element.scrollTop + delta, record: true })
    },
  })

  /** How far `target` lies below `offset` px from the viewport top: the one anchor measurement. */
  function measureAnchorDelta(element: HTMLElement, target: Element, offset: number) {
    return target.getBoundingClientRect().top - element.getBoundingClientRect().top - offset
  }

  /** `distance` is the gesture's known amplitude in scroller pixels, if any. */
  function markUserScrollIntent(direction: "up" | "down" | null, distance = 0) {
    programmaticScrollUntil = 0
    props.onScrollIntent?.(direction)
    supersedePositioning()
    const element = scrollElement()
    syncControllerResult(scrollController.userGesture(direction, performance.now() + USER_SCROLL_INTENT_WINDOW_MS, element ? getDomMetrics(element) : null, distance), "user-gesture")
    // No list positioning outlives this: see `writeScroll`.
    // At a clamped edge a wheel/key produces no scroll event. The gesture
    // itself must be able to request the next historical window.
    if (direction) updateScrollStateFromDom()
  }

  function hasProgrammaticScrollIntent() {
    return performance.now() <= programmaticScrollUntil
  }

  function scrollTraceEnabled() {
    if (isScrollTraceEnabled()) return true
    // Lazy cleanup on the next list action/observation: no polling or layout read.
    if (lastTracedWrite !== undefined) {
      scrollElement()?.removeAttribute("data-scroll-write")
      lastTracedWrite = undefined
      lastTracedLanding = undefined
    }
    return false
  }

  /**
   * The single transcript position write: a DOM write that opens the
   * programmatic window telling writes from gestures, its synchronous target
   * recorded. Positioning never uses Virtua's imperative operations
   * (scrollTo/scrollBy/scrollToIndex): Virtua 0.51 reapplies one on every item
   * or viewport measurement until 150 ms after the last, which the rows a
   * gesture mounts (or a streaming tail) keep re-arming, and nothing public
   * cancels it, so it would undo a gesture or a later write. Rows are placed
   * from Virtua's own offsets instead (`writeIndex`) and held by the list's
   * stabilizers, which every gesture cancels. A rolling window needs no
   * operation either: its leaving rows are retired in place (see the items
   * effect). Virtua's own compensation, the browser's clamping and user
   * gestures are observed as `unowned` scrolls.
   */
  function writeScroll(reason: ScrollReason, op: ScrollWriteOp) {
    const element = scrollElement()
    if (!element) return
    const traced = scrollTraceEnabled()
      ? { from: element.scrollTop, scrollHeight: element.scrollHeight }
      : undefined
    programmaticScrollUntil = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS
    if (op.type === "dom") {
      element.scrollTop = op.top
      if (op.record) scrollController.recordProgrammaticOffset(element.scrollTop)
    } else {
      element.scrollTo({ top: op.top, behavior: op.behavior })
      if (op.record) scrollController.recordProgrammaticOffset(op.top)
    }
    if (!traced) return
    // A smooth scroll lands later, at no known offset.
    const synchronous = op.type === "dom" || op.behavior !== "smooth"
    const to = synchronous ? element.scrollTop : undefined
    // A no-op still opens a programmatic window, so it takes the attribution;
    // only its duplicate diagnostic line is omitted.
    if (element.dataset.scrollWrite !== reason) element.dataset.scrollWrite = reason
    lastTracedWrite = reason
    lastTracedLanding = to
    if (to !== undefined && Math.abs(to - traced.from) < 1) return
    trace("write", {
      reason,
      op: op.type,
      from: traced.from,
      to,
      now: synchronous ? undefined : element.scrollTop,
      target: op.top,
      scrollHeight: traced.scrollHeight,
      mode: untrack(followMode).type,
    })
  }

  /** Callers check `scrollTraceEnabled()` first. */
  function trace(kind: ScrollTraceKind, entry: ScrollTraceEntry) {
    traceScroll(kind, { ...entry, session: untrack(() => props.resetKey?.()), at: Math.round(performance.now()) })
  }

  function traceObservation(offset: number, scrollHeight: number, programmatic: boolean, now: number) {
    const previous = scrollController.snapshot()
    if (Math.abs(offset - previous.lastObservedOffset) <= 1) return
    const handle = virtuaHandle()
    const index = handle ? findLiveItemIndex(handle, offset) : undefined
    const item = index === undefined ? undefined : untrack(virtualItems)[index]
    // A move inside a write's programmatic window is that write's, unless it
    // landed synchronously elsewhere: then Virtua or the browser moved it again.
    const owned = programmatic && lastTracedWrite !== undefined && (lastTracedLanding === undefined || Math.abs(offset - lastTracedLanding) <= 1)
    trace("observe", {
      owner: owned ? lastTracedWrite : "unowned",
      during: programmatic && !owned ? lastTracedWrite : undefined,
      from: previous.lastObservedOffset,
      to: offset,
      scrollHeight,
      intent: now <= previous.userIntentUntil ? previous.userIntentDirection : null,
      top: item === undefined ? undefined : props.getKey(item, index!),
      mode: previous.mode.type,
    })
  }

  /** The DOM offset, not Virtua's `scrollOffset`, which lags a write until its scroll event. */
  function getDomMetrics(element: HTMLDivElement, offset = element.scrollTop): ScrollControllerMetrics {
    return {
      offset,
      // Virtua's scrollSize excludes content preceding its own item root.
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }
  }

  function isActuallyAtBottom() {
    const element = scrollElement()
    if (!element) return false
    return isAtBottomForMode(followMode(), getDomMetrics(element))
  }

  function getMaxOffset(element: HTMLElement) {
    return Math.max(element.scrollHeight - element.clientHeight, 0)
  }

  function canPinFollowBottom() {
    return autoScroll() && !externalSuspendAutoPinToBottom() && !scrollController.snapshot().restoring
  }

  function performScrollToBottom(immediate: boolean, reason: ScrollReason) {
    const element = scrollElement()
    if (!element || virtualItems().length === 0) return
    if (canPinFollowBottom()) return pinFollowBottom(reason)
    if (canScrollInDirection(element, "down")) {
      writeScroll(reason, { type: "native", top: getMaxOffset(element), behavior: immediate ? "instant" : "smooth", record: false })
    }
  }

  function writeBottom(reason: ScrollReason) {
    const element = scrollElement()
    if (element && canScrollInDirection(element, "down")) {
      writeScroll(reason, { type: "dom", top: getMaxOffset(element), record: true })
    }
  }

  /** Writes a following bottom now and re-pins it while layout settles, unless an explicit pin already does. */
  function pinFollowBottom(reason: ScrollReason) {
    writeBottom(reason)
    if (bottomPin?.settle) return
    bottomPin = { reason, frames: Math.max(bottomPin?.frames ?? 0, FOLLOW_BOTTOM_PIN_FRAMES) }
    scheduleBottomPin()
  }

  function scheduleBottomPin() {
    if (bottomPin && bottomPinFrame === null) bottomPinFrame = requestAnimationFrame(runBottomPinFrame)
  }

  function runBottomPinFrame() {
    bottomPinFrame = null
    const pin = bottomPin
    if (!pin) return
    if (!isActive()) return endBottomPin("interrupted")
    const settle = pin.settle
    // An explicit pin's own target is the bottom; following defers to restoration and suspension.
    if (!settle && !canPinFollowBottom()) return endBottomPin("interrupted")
    writeBottom(pin.reason)
    pin.frames -= 1
    if (settle) {
      const element = scrollElement()
      const progress = advanceBottomPinSettlement(settle.progress, {
        ready: props.items().length >= settle.minItemCount && isActuallyAtBottom(),
        maxOffset: element ? getMaxOffset(element) : null,
        requiredStableFrames: settle.requiredStableFrames,
      })
      settle.progress = progress
      if (progress.settled) return handBottomToFollow(pin, "settled")
    }
    if (pin.frames <= 0) return settle ? handBottomToFollow(pin, "timeout") : endBottomPin("timeout")
    scheduleBottomPin()
  }

  /** An explicit pin that ends by itself leaves following re-pinning while layout settles. */
  function handBottomToFollow(pin: BottomPin, settlement: VirtualBottomSettlement) {
    const resolve = pin.settle?.resolve
    bottomPin = { reason: pin.reason, frames: FOLLOW_BOTTOM_PIN_FRAMES }
    scheduleBottomPin()
    resolve?.(settlement)
  }

  function endBottomPin(settlement: VirtualBottomSettlement) {
    const resolve = bottomPin?.settle?.resolve
    bottomPin = null
    if (bottomPinFrame !== null) cancelAnimationFrame(bottomPinFrame)
    bottomPinFrame = null
    resolve?.(settlement)
  }

  /** Cancels an explicit pin and the owner's pending intent, which then never restarts itself. */
  function cancelExplicitBottomPin() {
    const intent = explicitBottomPinIntent()
    if (intent) handledBottomPinToken = intent.token
    endBottomPin("cancelled")
    if (intent) props.onExplicitBottomPinCancelled?.()
  }

  /** Enters follow and keeps the bottom until enough rows exist and it stays put; leaving follow cancels it. */
  function startExplicitBottomPin(intent: Partial<VirtualExplicitBottomPinIntent>, resolve?: (settlement: VirtualBottomSettlement) => void) {
    endBottomPin("interrupted")
    bottomPin = {
      reason: "explicit-pin",
      frames: EXPLICIT_BOTTOM_PIN_MAX_FRAMES,
      settle: {
        token: intent.token,
        minItemCount: Math.max(0, Math.floor(intent.minItemCount ?? 0)),
        requiredStableFrames: Math.max(1, Math.floor(intent.settleFrames ?? EXPLICIT_BOTTOM_PIN_SETTLE_FRAMES)),
        progress: { stableFrames: 0, lastMaxOffset: null },
        resolve,
      },
    }
    dispatchFollowEvent({ type: "jump-bottom", immediate: true, explicit: true }, "explicit-pin")
    runBottomPinFrame()
  }

  function performScrollToTop(immediate: boolean, source: ScrollReason) {
    writeScroll(source, immediate ? { type: "dom", top: 0, record: true } : { type: "native", top: 0, behavior: "smooth", record: false })
  }

  function performScrollToKey(key: string, source: ScrollReason) {
    const index = findLiveIndex(key)
    if (index === -1) return
    // Large smooth jumps over dynamically measured items can leave Virtua's
    // mounted range behind the viewport. Semantic navigation must land first;
    // the reader settlement then holds the row at the top once it is measured,
    // for the alignment window only, like an in-place reveal.
    if (writeIndex(source, index)) readerSettlement.hold({ key, offset: 0 })
  }

  /**
   * Writes the offset Virtua's scrollToIndex would target to put row `index` at
   * the top (estimated until measured) as one DOM write. Virtua's resize
   * compensation keeps that row in place as the rows around it are measured;
   * the caller's stabilizer settles the rest.
   */
  function writeIndex(reason: ScrollReason, index: number) {
    const handle = virtuaHandle()
    if (!scrollElement() || !handle) return false
    // Virtua's item offsets exclude its start margin, the content before its items.
    writeScroll(reason, { type: "dom", top: untrack(beforeItemsHeight) + handle.getItemOffset(index), record: true })
    return true
  }

  /** The live (non-retired) row index for `key`, or -1. */
  function findLiveIndex(key: string) {
    const items = virtualItems(), start = retiredCount()
    for (let index = start; index < items.length; index++) if (props.getKey(items[index], index) === key) return index
    return -1
  }

  /** Virtua's row index at `offset`, never a retired row. */
  function findLiveItemIndex(handle: VirtualizerHandle, offset: number) {
    return Math.max(handle.findItemIndex(offset), retiredCount())
  }

  function updateScrollStateFromDom() {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return

    const offset = element.scrollTop
    const metrics = getDomMetrics(element, offset)
    const atTop = offset <= TOP_SCROLL_EPSILON_PX
    const hasItems = props.items().length > 0
    setShowScrollTopButton(hasItems && !atTop)

    const now = performance.now()
    if (nativeScrollbarDragging) {
      const previous = scrollController.snapshot()
      scrollController.setUserIntent(offset < previous.lastObservedOffset ? "up" : offset > previous.lastObservedOffset ? "down" : previous.userIntentDirection, now + USER_SCROLL_INTENT_WINDOW_MS)
    }
    const programmatic = hasProgrammaticScrollIntent()
    if (scrollTraceEnabled()) traceObservation(offset, metrics.scrollHeight, programmatic, now)
    const observed = scrollController.observeViewport(metrics, now, programmatic)
    const result = nativeScrollbarDragging ? scrollController.setFollow(false) : observed
    const restoring = result.state.restoring
    const intent = result.state.userIntentDirection
    const hasFreshIntent = now <= result.state.userIntentUntil
    const atBottom = isAtBottomForMode(result.state.mode, metrics)
    setShowScrollBottomButton(hasItems && !isAutoFollowing(result.state.mode) && !atBottom)
    // A boundary callback may synchronously start a historical load and escape
    // follow mode. Publish this observation before handing it that authority.
    syncControllerResult(result, nativeScrollbarDragging ? "thumb-drag" : "observe")
    if (!nativeScrollbarDragging && shouldNavigateAtBoundary({ atBoundary: atTop, restoring, programmatic, hasFreshIntent, intent, direction: "up" })) {
      props.onUserReachedTop?.()
    }
    if (!nativeScrollbarDragging && shouldNavigateAtBoundary({ atBoundary: atBottom, restoring, programmatic, hasFreshIntent, intent, direction: "down" })) {
      props.onUserReachedBottom?.()
    }
  }

  function handleScroll() {
    readerSettlement.notify()
    updateScrollStateFromDom()
    props.onScroll?.()

    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return
    const start = findLiveItemIndex(handle, handle.scrollOffset)
    const item = virtualItems()[start]
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
    queueMicrotask(() => {
      if (itemElements.get(key) !== element || !element.isConnected) return
      // Solid calls refs before inserting the node. Once connected, Virtua's
      // measured-height root is the parent of its item wrapper.
      observeVirtualContent(element.parentElement?.parentElement)
    })
  }

  function observeVirtualContent(element: HTMLElement | null | undefined) {
    if (!element || element === observedVirtualContent || typeof ResizeObserver === "undefined") return
    if (!virtualContentResizeObserver) {
      virtualContentResizeObserver = new ResizeObserver(() => {
        if (!isActive()) return
        if (pendingContentRenderedFrame !== null) cancelAnimationFrame(pendingContentRenderedFrame)
        pendingContentRenderedFrame = null
        flushContentRendered()
      })
    }
    if (observedVirtualContent) virtualContentResizeObserver.unobserve(observedVirtualContent)
    observedVirtualContent = element
    virtualContentResizeObserver.observe(element)
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

    dispatchFollowEvent({ type: "set-follow", enabled: false }, "hold")
    scrollController.recordProgrammaticOffset(element.scrollTop)
    // The hold changes the mode without a scroll; consumers observing
    // state.autoScroll persist the held position (as MessageSection does).
    return true
  }

  /** Layout changed. Priority: restoration > explicit bottom pin (its loop re-pins every frame) > hold > follow. */
  function flushContentRendered() {
    readerSettlement.notify()
    pendingContentRenderedFrame = null
    if (restartAnchorRestore) restartAnchorRestore()
    else if (!bottomPin?.settle && !maybeEscapeForHoldTrigger()) {
      dispatchFollowEvent({ type: "content-grew", canPinToBottom: autoScroll() && !externalSuspendAutoPinToBottom() })
    }
    updateScrollStateFromDom()
  }

  function captureScrollSnapshot(): VirtualFollowScrollSnapshot | undefined {
    const element = scrollElement()
    if (!element) return undefined
    const scrollTop = element.scrollTop
    const maxScrollTop = getMaxOffset(element)
    // A following list is at the bottom by definition, wherever its pin's
    // latest write stands (a send pin catching up, growth not yet re-pinned).
    const atBottom = autoScroll() || isAtBottomForMode(followMode(), getDomMetrics(element, scrollTop))
    const snapshot: VirtualFollowScrollSnapshot = {
      scrollTop,
      scrollRatio: maxScrollTop > 0 ? scrollTop / maxScrollTop : 0,
      maxScrollTop,
      atBottom,
      ...getFollowSnapshotState(followMode()),
    }
    // An escaped reader keeps its anchor even at the bottom (a hold triggered
    // there): growth below it scrolls nothing, so no later capture replaces this one.
    if (!autoScroll()) {
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
    // Read the rendered rows, not itemElements: a list being unmounted has
    // already dropped those entries while its rows remain laid out. Rows sit at
    // scroller > Virtua root > item > row; never walk their content.
    for (const root of element.children) for (const item of root.children) {
      const row = item.firstElementChild
      const key = row instanceof HTMLElement ? row.dataset.virtualFollowKey : undefined
      if (key === undefined) continue
      const rect = row!.getBoundingClientRect()
      candidates.push({ key, top: rect.top, bottom: rect.bottom })
    }
    const handle = virtuaHandle()
    const index = handle ? findLiveItemIndex(handle, element.scrollTop) : undefined
    const item = typeof index === "number" ? virtualItems()[index] : undefined
    const preferredKey = item === undefined || index === undefined ? undefined : props.getKey(item, index)
    const anchor = selectTopViewportAnchor(candidates, containerRect.top, containerRect.bottom, preferredKey)
    return anchor ? { key: anchor.key, offset: anchor.top - containerRect.top } : null
  }

  function restoreScrollSnapshot(snapshot: VirtualFollowScrollSnapshot, opts?: RestoreScrollSnapshotOptions) {
    // Restoration outranks a bottom pin (as in flushContentRendered): it
    // supersedes the pin, except that a restoration to the bottom joins an
    // active explicit pin and keeps its row-count guarantee. It also supersedes
    // any earlier restoration, notified once this one owns the position (a
    // re-entrant restoration from that callback then supersedes this one), and
    // reports only its own landing. An anchored snapshot (an escaped reader)
    // returns to its anchor even when it was captured at the bottom.
    const toBottom = snapshot.atBottom && snapshot.anchorKey === undefined
    const superseded = cancelRestore
    readerSettlement.cancel()
    invalidateScrollRestore()
    if (!toBottom || !bottomPin?.settle) endBottomPin("interrupted")
    const element = scrollElement()
    if (!element) {
      superseded?.()
      opts?.fallback?.()
      return
    }

    const token = restoreToken.begin()
    const isCurrent = () => restoreToken.isCurrent(token) && Boolean(scrollElement()) && isActive()
    restartAnchorRestore = undefined
    scrollController.setRestoring(true)
    cancelRestore = () => opts?.onCancelled?.()
    superseded?.()

    const finish = () => {
      if (!isCurrent()) return
      restartAnchorRestore = undefined
      cancelRestore = undefined
      syncControllerResult(scrollController.restoreMode(restoreFollowModeFromSnapshot(snapshot)), "restore-finish")
      scrollController.setRestoring(false)
      opts?.onApplied?.()
    }

    let measurementFrames = 0
    const anchorAvailability = new AnchorRestoreStabilizer()
    const apply = () => {
      if (!isCurrent()) return
      const handle = virtuaHandle()
      const ready = isScrollRestoreMeasurementReady({
        hasHandle: Boolean(handle),
        itemCount: virtualItems().length,
        scrollSize: handle?.scrollSize ?? element.scrollHeight,
        viewportSize: handle?.viewportSize ?? element.clientHeight,
      })
      if (!ready && measurementFrames < SCROLL_RESTORE_MEASUREMENT_MAX_FRAMES) {
        measurementFrames += 1
        requestAnimationFrame(apply)
        return
      }

      if (toBottom) {
        const onSettled = (settlement: VirtualBottomSettlement) => {
          if (settlement !== "cancelled") finish()
          // Follow was left without a gesture (which cancels the restoration itself).
          else if (restoreToken.isCurrent(token)) cancelActiveScrollRestore()
        }
        const joined = bottomPin?.settle
        if (!joined) startExplicitBottomPin({ settleFrames: LOCAL_BOTTOM_PIN_SETTLE_FRAMES }, onSettled)
        else {
          const resolve = joined.resolve
          joined.resolve = (settlement) => { resolve?.(settlement); onSettled(settlement) }
        }
        return
      }

      if (snapshot.anchorKey) {
        const index = findLiveIndex(snapshot.anchorKey)
        if (index !== -1) {
          writeIndex("restore-anchor", index)
          const stabilizer = new AnchorRestoreStabilizer()
          restartAnchorRestore = () => {
            if (!isCurrent()) return
            stabilizer.restartStability()
            // A mounted anchor with a saved inner offset has one target, which
            // the frame loop corrects. Rewriting the row's estimate would fight it.
            const mounted = itemElements.get(snapshot.anchorKey!)?.isConnected && typeof snapshot.anchorOffset === "number"
            if (!mounted) scrollToAnchorIndex(snapshot.anchorKey!)
          }
          retryAnchorRestore(snapshot, stabilizer, isCurrent, finish)
          return
        }
        const availability = anchorAvailability.nextFrame({ targetExists: false, mounted: false })
        if (availability.type === "retry") {
          requestAnimationFrame(apply)
          return
        }
      }

      applyPixelSnapshot(snapshot)
      requestAnimationFrame(finish)
    }
    apply()
  }

  function scrollToAnchorIndex(key: string) {
    const index = findLiveIndex(key)
    if (index === -1) return false
    writeIndex("restore-anchor", index)
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
      // The anchor was the top visible row: if it has shrunk since, keep it
      // visible rather than above the viewport, where Virtua may unmount it.
      const delta = mounted && element && itemWrapper && typeof anchorOffset === "number"
        ? measureAnchorDelta(element, itemWrapper, Math.max(anchorOffset, 1 - itemWrapper.getBoundingClientRect().height))
        : undefined
      const result = stabilizer.nextFrame({ targetExists, mounted, delta })

      if (result.type === "finish") {
        onApplied()
        return
      }
      if (result.type === "correct" && element) {
        writeScroll("restore-anchor", { type: "dom", top: element.scrollTop + result.delta, record: true })
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
      applyPixelSnapshot(snapshot)
      onApplied()
    })
  }

  function applyPixelSnapshot(snapshot: VirtualFollowScrollSnapshot) {
    const element = scrollElement()
    if (!element) return
    const maxScrollTop = getMaxOffset(element)
    const nextTop = snapshot.atBottom
      ? maxScrollTop
      : typeof snapshot.scrollRatio === "number" && snapshot.maxScrollTop !== maxScrollTop
        ? Math.min(Math.max(snapshot.scrollRatio, 0), 1) * maxScrollTop
        : Math.min(snapshot.scrollTop, maxScrollTop)
    writeScroll("restore-pixel", { type: "dom", top: nextTop, record: true })
  }

  function attachScrollIntentListeners(element: HTMLDivElement | undefined) {
    detachScrollIntentListeners?.()
    detachScrollIntentListeners = undefined
    if (!element) return
    const nestedScrollerConsumes = (target: EventTarget | null, direction: "up" | "down") => findNestedScroller(element, target, direction) !== null
    // The gesture routing already decided which scroller owns each wheel event.
    const handleWheelIntent = (event: WheelEvent) => {
      markUserScrollIntent(event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : null, event.deltaY * wheelDeltaUnit(event, element))
    }
    let lastPrimaryPointerY: number | null = null
    const handlePointerIntent = (event: PointerEvent) => {
      // The routing's own exclusion: summaries, tabs and similar widgets still
      // start middle-button autoscroll and text-selection drags, which scroll.
      if ((event.target as HTMLElement | null)?.closest(POINTER_CONTROL_SELECTOR)) return
      if (isMiddleButtonScrollIntent(event.button)) {
        markUserScrollIntent("up")
        return
      }
      if (event.button === 0) lastPrimaryPointerY = event.clientY
      if (event.target !== element) return
      const rect = element.getBoundingClientRect()
      const scale = rect.width / element.offsetWidth
      const contentLeft = rect.left + element.clientLeft * scale
      const contentRight = contentLeft + element.clientWidth * scale
      const overlayEdge = element.offsetWidth === element.clientWidth && (
        getComputedStyle(element).direction === "rtl" ? event.clientX < rect.left + 12 * scale : event.clientX >= rect.right - 12 * scale
      )
      if (event.button === 0 && element.scrollHeight > element.clientHeight
        && (event.clientX < contentLeft || event.clientX >= contentRight || overlayEdge)) {
        nativeScrollbarDragging = true
        dispatchFollowEvent({ type: "set-follow", enabled: false }, "thumb-drag")
      }
      markUserScrollIntent(null)
    }
    const handlePointerMove = (event: PointerEvent) => {
      const previousY = lastPrimaryPointerY
      if (previousY === null) return
      lastPrimaryPointerY = event.clientY
      const direction = getPrimaryPointerDragDirection(previousY, event.clientY, event.buttons)
      if (direction) markUserScrollIntent(direction)
      if ((event.buttons & 1) === 0) lastPrimaryPointerY = null
    }
    const handlePointerEnd = () => {
      const wasDragging = nativeScrollbarDragging
      nativeScrollbarDragging = false
      lastPrimaryPointerY = null
      if (wasDragging) {
        programmaticScrollUntil = 0
        updateScrollStateFromDom()
      }
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
      const direction = nextY > previousY ? "up" : nextY < previousY ? "down" : null
      if (direction && nestedScrollerConsumes(event.target, direction)) return
      markUserScrollIntent(direction, (previousY - nextY) / getElementZoom(element))
    }
    const handleTouchEnd = () => {
      lastTouchY = null
    }
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (!isActive() || event.defaultPrevented) return
      if (!SCROLL_INTENT_KEYS.has(event.key)) return
      const intent = getKeyboardScrollIntent({
        key: event.key,
        shiftKey: event.shiftKey,
        ...describeKeyTarget(event.target),
        viewportHeight: element.clientHeight,
        zoom: getElementZoom(element),
        devicePixelRatio: window.devicePixelRatio,
      })
      if (!intent) return
      const direction = intent.type === "top" ? "up" : intent.type === "bottom" ? "down" : intent.direction
      if (nestedScrollerConsumes(event.target, direction)) return
      if (intent.type === "bottom") {
        event.preventDefault()
        jumpToBottom(true)
        return
      }
      if (intent.type === "top") {
        event.preventDefault()
        jumpToTop(true)
        return
      }
      markUserScrollIntent(intent.direction, intent.distance)
    }
    // Moving focus elsewhere (Tab, assistive technology) ends an in-place reveal's hold.
    const handleFocusIn = (event: FocusEvent) => {
      const held = readerSettlement.held()
      if (held && !itemElements.get(held.key)?.contains(event.target as Node)) readerSettlement.cancel()
    }
    const detachGestureRouting = attachScrollGestureRouting(element, handleWheelIntent)
    element.addEventListener("focusin", handleFocusIn)
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("pointermove", handlePointerMove)
    element.addEventListener("pointerup", handlePointerEnd)
    element.addEventListener("pointercancel", handlePointerEnd)
    window.addEventListener("pointerup", handlePointerEnd)
    window.addEventListener("mouseup", handlePointerEnd)
    window.addEventListener("blur", handlePointerEnd)
    element.addEventListener("touchstart", handleTouchStart, { passive: true })
    element.addEventListener("touchmove", handleTouchMove, { passive: true })
    element.addEventListener("touchend", handleTouchEnd, { passive: true })
    element.addEventListener("touchcancel", handleTouchEnd, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      detachGestureRouting()
      element.removeEventListener("focusin", handleFocusIn)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("pointermove", handlePointerMove)
      element.removeEventListener("pointerup", handlePointerEnd)
      element.removeEventListener("pointercancel", handlePointerEnd)
      window.removeEventListener("pointerup", handlePointerEnd)
      window.removeEventListener("mouseup", handlePointerEnd)
      window.removeEventListener("blur", handlePointerEnd)
      nativeScrollbarDragging = false
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
    supersedePositioning()
    dispatchFollowEvent({ type: "jump-top", immediate })
  }

  function jumpToTop(immediate = true) {
    scrollToTop(immediate)
    props.onJumpTop?.()
  }

  function jumpToBottom(immediate = true) {
    scrollToBottom(immediate)
    props.onJumpBottom?.()
  }

  function scrollToKey(key: string) {
    supersedePositioning()
    dispatchFollowEvent({ type: "jump-key", key, block: "start", smooth: false })
  }

  function alignElement(target: HTMLElement, viewportOffset: number) {
    const element = scrollElement()
    const key = target.closest<HTMLElement>("[data-virtual-follow-key]")?.dataset.virtualFollowKey
    if (!element || !element.contains(target) || key === undefined) return
    supersedePositioning()
    dispatchFollowEvent({ type: "set-follow", enabled: false }, "align-element")
    // The virtualizer's resize compensation and late layout (fonts, lazy cards) can move
    // the target after this correction: the reader settlement re-measures it on every
    // frame of a bounded window, unless a gesture, navigation or focus elsewhere ends it.
    readerSettlement.hold({ key, offset: viewportOffset, element: target })
  }

  /** A keyboard activation can happen off-screen (or mid-layout); always land in view. */
  function clampAlignmentOffset(element: HTMLElement, offset: number) {
    return Math.min(Math.max(offset, 0), Math.max(0, element.clientHeight - ELEMENT_ALIGNMENT_BOTTOM_MARGIN_PX))
  }

  const api: VirtualFollowListApi = {
    scrollToTop: (opts) => scrollToTop(opts?.immediate ?? true),
    scrollToBottom: (opts) => scrollToBottom(opts?.immediate ?? true),
    settleAtBottom: () => new Promise<VirtualBottomSettlement>((resolve) => {
      cancelActiveScrollRestore()
      startExplicitBottomPin({ settleFrames: LOCAL_BOTTOM_PIN_SETTLE_FRAMES }, resolve)
    }),
    scrollToKey,
    notifyContentRendered: () => {
      // A hidden list keeps its position; activation positions it anew.
      if (!isActive()) return
      if (restartAnchorRestore) {
        restartAnchorRestore()
        return
      }
      if (pendingContentRenderedFrame !== null) return
      pendingContentRenderedFrame = requestAnimationFrame(() => flushContentRendered())
    },
    alignElement,
    setAutoScroll: (enabled) => dispatchFollowEvent({ type: "set-follow", enabled }),
    getAutoScroll: () => autoScroll(),
    getScrollElement: () => scrollElement(),
    getShellElement: () => shellElement(),
    captureScrollSnapshot,
    restoreScrollSnapshot,
  }

  createEffect(() => props.registerApi?.(api))
  createEffect(() => props.registerState?.(state))

  createEffect(() => {
    const element = beforeItemsElement()
    const stream = scrollElement()
    if (!element || !stream) return
    let height = element.getBoundingClientRect().height
    let stableOffset = stream.scrollTop
    setBeforeItemsHeight(height)
    const captureOffset = () => {
      // A shrinking prefix can clamp scrollTop before ResizeObserver runs.
      // Retain the pre-layout offset until that resize has been accounted for.
      if (element.getBoundingClientRect().height === height) stableOffset = stream.scrollTop
    }
    const measure = () => {
      const nextHeight = element.getBoundingClientRect().height
      const delta = nextHeight - height
      const offset = delta < 0 && !canScrollInDirection(stream, "down") ? stableOffset : stream.scrollTop
      // A bottom pin exists only while following, so it never retains a reader.
      const retainReader = delta !== 0 && isActive() && !autoScroll() && !scrollController.snapshot().restoring
      // The correction below keeps a held element in place; a retained reader restarts.
      if (retainReader && !readerSettlement.held()) readerSettlement.cancel()
      setBeforeItemsHeight(nextHeight)
      if (retainReader && !nativeScrollbarDragging && offset >= height) {
        // One synchronous layout correction, not a deferred pin that can
        // reassert over the next wheel/thumb gesture. Header readers stay put.
        writeScroll("before-items", { type: "dom", top: Math.max(0, offset + delta), record: true })
      }
      height = nextHeight
      stableOffset = stream.scrollTop
      if (isActive() && !nativeScrollbarDragging) api.notifyContentRendered()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    stream.addEventListener("scroll", captureOffset, { passive: true })
    onCleanup(() => {
      observer.disconnect()
      stream.removeEventListener("scroll", captureOffset)
    })
  })

  createEffect(on(explicitBottomPinIntent, (intent) => {
    if (!intent) {
      handledBottomPinToken = null
      if (bottomPin?.settle?.token !== undefined) endBottomPin("interrupted")
      return
    }
    if (intent.token === handledBottomPinToken) return
    handledBottomPinToken = intent.token
    cancelActiveScrollRestore()
    startExplicitBottomPin(intent)
  }))

  createEffect(on(() => props.followToken?.(), () => {
    if (autoScroll()) api.notifyContentRendered()
  }, { defer: true }))

  createEffect(on(
    () => {
      const items = props.items()
      return { items, keys: items.map((item, index) => props.getKey(item, index)) }
    },
    ({ items: nextItems, keys: nextItemKeys }) => {
      // Equivalent source reprojections are not new window plans. In particular,
      // they must not invalidate a rolling adjustment waiting for its first RAF.
      if (nextItems.length === plannedItems.length && nextItems.every((item, index) =>
        item === plannedItems[index] && nextItemKeys[index] === plannedKeys[index])) return
      plannedItems = nextItems.slice()
      plannedKeys = nextItemKeys.slice()
      const shiftGeneration = ++windowShiftGeneration

      // Rows leaving the head of a rolling window are retired in place: they
      // stay in Virtua's data as an empty prefix, so Virtua only ever sees the
      // data grow, measures them at zero, and its ordinary resize anchoring
      // compensates their disappearance. Shift mode, which needs an imperative
      // operation to leave and then reasserts it, is never entered. A reset
      // (page navigation, a disjoint window, an emptied list) drops them.
      const retiredBefore = retiredCount()
      const liveKeys = virtualItemKeys.slice(retiredBefore)
      const change = classifyVirtualItemKeyChange(liveKeys, nextItemKeys)
      const retiredNext = change.resetMeasurements ? 0 : retiredBefore + change.shiftedStartCount
      const plannedVirtualKeys = [...virtualItemKeys.slice(0, retiredNext), ...nextItemKeys]
      // A short append also needs measured probes: a hidden native metadata row
      // estimated at the mean height of a tall answer can pin beyond every row.
      // Keep large page loads and rolling-window shifts on their bounded path.
      // Escaped readers must retain their DOM gesture target: remounting an
      // existing tool scroller cancels a held native middle-button drag.
      const appendedCount = nextItemKeys.length - liveKeys.length
      const measureAppend = autoScroll() && liveKeys.length > 0 && appendedCount > 0
        && appendedCount <= MEASUREMENT_PROBE_COUNT && change.shiftedStartCount === 0
      const resetMeasurements = change.resetMeasurements || measureAppend
      const measurementCache = resetMeasurements
        ? remapVirtualMeasurements(virtualItemKeys, plannedVirtualKeys, virtuaHandle()?.cache, autoScroll(), measurementAuthority().pendingProbeKeys)
        : undefined
      const viewport = resetMeasurements ? scrollElement()?.getBoundingClientRect() : undefined
      // Visible rows and pending measurements have separate lifetimes: many
      // visible rows must never evict a zero-seeded insertion before its measure.
      const visibleKeys = resetMeasurements && viewport
        ? new Set(Array.from(itemElements).filter(([, element]) => {
            const rect = element.getBoundingClientRect()
            return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
          }).map(([key]) => key))
        : new Set<string>()
      if (change.shiftedStartCount > 0) {
        const reader = !autoScroll() ? readerSettlement.capture() : undefined
        if (reader?.anchor && !nextItemKeys.includes(reader.anchor.key)) readerSettlement.cancel()
        // The keyed DOM stays intact for a held nested middle-button drag.
        requestAnimationFrame(() => {
          if (shiftGeneration !== windowShiftGeneration) return
          readerSettlement.settle(reader)
          // After this frame's layout Virtua has measured the mounted retired
          // rows: those at zero no longer need to stay mounted.
          requestAnimationFrame(() => {
            const handle = virtuaHandle()
            if (!handle || shiftGeneration !== windowShiftGeneration) return
            let collapsed = collapsedCount()
            while (collapsed < retiredCount() && handle.getItemSize(collapsed) === 0) collapsed++
            setCollapsedCount(collapsed)
          })
        })
      }
      batch(() => {
        if (retiredNext === 0) setCollapsedCount(0)
        setRetiredCount(retiredNext)
        setVirtualItems([...virtualItems().slice(0, retiredNext), ...nextItems])
      })
      virtualItemKeys = plannedVirtualKeys

      if (resetMeasurements) {
        itemElements.clear()
        setMeasurementAuthority({
          cache: measurementCache?.cache,
          pendingProbeKeys: measurementCache?.probes.map(index => plannedVirtualKeys[index]) ?? [],
          probes: [...(measurementCache?.probes ?? []), ...plannedVirtualKeys.flatMap((key, index) => visibleKeys.has(key) ? [index] : [])],
        })
      }
      if (change.endChanged && autoScroll()) api.notifyContentRendered()
    },
    { defer: true },
  ))

  createEffect(on(() => props.resetKey?.(), (nextKey) => {
    if (nextKey === lastResetKey) return
    lastResetKey = nextKey
    stopPositioning()
    handledBottomPinToken = null
    dispatchFollowEvent({ type: "reset", follow: initialAutoScroll() })
    windowShiftGeneration += 1
    const items = props.items()
    setRetiredCount(0)
    setCollapsedCount(0)
    setVirtualItems(items.slice())
    virtualItemKeys = items.map((item, index) => props.getKey(item, index))
    plannedItems = items.slice()
    plannedKeys = virtualItemKeys.slice()
    itemElements.clear()
  }))

  createEffect(on(isActive, (active) => {
    if (active) return
    // Includes a restoration in flight: its frames stop at inactivity, and
    // an armed restart or a sticky `restoring` would outlive this session view.
    stopPositioning()
  }))

  createEffect(() => {
    const element = scrollElement()
    // A session reset drops a pending resize delta along with its tracker.
    props.resetKey?.()
    if (!element || typeof ResizeObserver === "undefined") return
    const viewportHeight = trackHeightDelta(element, (heightDelta) => {
      if (!isActive() || scrollController.snapshot().restoring) return
      if (canPinFollowBottom()) {
        pinFollowBottom("viewport-resize")
      } else if (!readerSettlement.held()) {
        writeScroll("viewport-resize", { type: "dom", top: getBottomAnchoredViewportOffset(element.scrollTop, heightDelta), record: true })
      }
      updateScrollStateFromDom()
    })
    const observer = new ResizeObserver(() => {
      // An inactive or restoring list only rebases. A held element re-aligns itself on its next frame.
      if (viewportHeight.update(isActive() && !scrollController.snapshot().restoring) && !readerSettlement.held()) readerSettlement.cancel()
    })
    observer.observe(element)
    onCleanup(() => {
      observer.disconnect()
      viewportHeight.dispose()
    })
  })

  onCleanup(() => {
    stopPositioning()
    windowShiftGeneration += 1
    virtualContentResizeObserver?.disconnect()
    virtualContentResizeObserver = null
    observedVirtualContent = null
    detachScrollIntentListeners?.()
  })

  return (
    <div class="virtual-follow-list-shell" ref={shellElement => {
      setShellElement(shellElement)
      props.onShellElementChange?.(shellElement)
    }}>
      <div
        class="message-stream"
        data-follow-mode={autoScroll() ? "following" : "escaped"}
        tabIndex={0}
        ref={el => {
          setScrollElement(el)
          props.onScrollElementChange?.(el)
          attachScrollIntentListeners(el)
        }}
        onMouseUp={props.onMouseUp}
        onClick={props.onClick}
      >
        <div class="virtual-follow-list-before" ref={setBeforeItemsElement}>{props.renderBeforeItems?.()}</div>
        {/* Client-only: keep bounded measurement probes, not an SSR range that
            stays pinned until a real scroll event (short threads cannot scroll). */}
        <Show keyed when={measurementAuthority()}>
          {(authority) => (
            <Virtualizer
              cache={authority.cache}
              // Each instance otherwise re-estimates its default row size once
              // newly measured rows outgrow the viewport (e.g. a streaming reply)
              // and resizes every never-measured row at once. A remount already
              // carries the previous estimate (`cache[1]`, refreshed by the remap):
              // keep it, so measurement stays the only size change Virtua has to
              // compensate above a reader. This also applies `bufferSize`
              // overscan from the first frame, so each remount mounts more rows.
              // CacheSnapshot is internal to Virtua; its layout and this itemSize
              // contract are pinned by virtual-follow-measurements.test.ts.
              itemSize={authority.cache?.[1]}
              ref={handle => {
                setVirtuaHandle(handle)
                // A new instance reads offset 0 until the next scroll event, so it
                // would render and measure the head rows instead of the viewport.
                // Its scroll listener attaches right after this ref: seed it. The
                // remount has already recreated every row, so the scroll-driven
                // closing of image previews and quote selections loses nothing.
                if (handle) queueMicrotask(() => {
                  const element = scrollElement()
                  if (virtuaHandle() === handle && element && element.scrollTop > 0) element.dispatchEvent(new Event("scroll"))
                })
              }}
              scrollRef={scrollElement()}
              startMargin={beforeItemsHeight()}
              data={virtualItems()}
              bufferSize={props.overscanPx ?? 400}
              keepMounted={[...new Set([
                // Retired rows stay mounted until Virtua has measured them at zero.
                ...Array.from({ length: retiredCount() - collapsedCount() }, (_, index) => collapsedCount() + index),
                ...Array.from({ length: Math.min(virtualItems().length - retiredCount(), MEASUREMENT_PROBE_COUNT) }, (_, index) => retiredCount() + index),
                // A disjoint older page is entered at its bottom. Its first
                // records may all be hidden native metadata, so head probes
                // alone cannot render the destination before the scroll event.
                ...Array.from({ length: Math.min(virtualItems().length - retiredCount(), MEASUREMENT_PROBE_COUNT) }, (_, index) => virtualItems().length - 1 - index),
                ...authority.probes.filter(index => index < virtualItems().length),
              ])]}
              onScroll={handleScroll}
              onScrollEnd={props.onScrollEnd}
            >
              {(item, index) => {
                const key = props.getKey(item, index())
                // A retired row renders nothing; callers see live indexes only.
                return <Show when={index() >= retiredCount()} fallback={<div data-virtual-follow-retired="" />}><div
                  id={getAnchorIdForKey(key)}
                  data-virtual-follow-key={key}
                  ref={(element) => {
                    registerItemElement(key, element)
                    onCleanup(() => {
                      if (itemElements.get(key) === element) itemElements.delete(key)
                    })
                  }}
                >{props.renderItem(item, () => index() - retiredCount())}</div></Show>
              }}
            </Virtualizer>
          )}
        </Show>
      </div>

      <Show when={Boolean(props.renderOverlay)}>
        <div class="virtual-follow-list-overlay">{props.renderOverlay!()}</div>
      </Show>

      <Show when={Boolean(props.renderControls)}>
        <div class="virtual-follow-list-controls-container">{props.renderControls!(state, api)}</div>
      </Show>

      <Show when={!props.renderControls && (showScrollTopButton() || showScrollBottomButton()) && props.scrollToTopAriaLabel && props.scrollToBottomAriaLabel}>
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button type="button" class="message-scroll-button" onClick={() => jumpToTop()} aria-label={props.scrollToTopAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">↑</span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button type="button" class="message-scroll-button" onClick={() => jumpToBottom(true)} aria-label={props.scrollToBottomAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">↓</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
