export type FollowMode = { type: "following" } | { type: "escaped" }

export const BOTTOM_FOLLOW_EPSILON_PX = 48
export const ANCHOR_RESTORE_MAX_FRAMES = 300
export const ANCHOR_RESTORE_STABLE_FRAMES = 10
export const ANCHOR_RESTORE_REISSUE_INTERVAL_FRAMES = 12
export const ANCHOR_RESTORE_TOLERANCE_PX = 1

export function isMiddleButtonScrollIntent(button: number): boolean {
  return button === 1
}

export function getPrimaryPointerDragDirection(previousY: number, nextY: number, buttons: number): ScrollDirection {
  if ((buttons & 1) === 0 || previousY === nextY) return null
  return nextY < previousY ? "up" : "down"
}

export const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])
// Space activates these instead of scrolling (keyboard only: pointer presses
// use the gesture routing's POINTER_CONTROL_SELECTOR).
const INTERACTIVE_KEY_TARGET_SELECTOR = ["button", "a", "summary", "input", "textarea", "select", "[contenteditable='true']",
  ...["button", "link", "textbox", "checkbox", "switch", "radio", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem"].map(role => `[role='${role}']`)].join(", ")
const TEXT_EDITING_KEY_TARGET_SELECTOR = "input, textarea, select, [contenteditable='true'], [role='textbox']"
// Widgets that consume arrows (and Space). Plain buttons and links do not:
// Chromium scrolls their scroller, so their arrows remain scroll intent.
const ARROW_KEY_WIDGET_SELECTOR = ["listbox", "menu", "menubar", "radiogroup", "slider", "spinbutton", "combobox", "tablist", "tree", "treegrid", "grid"]
  .map(role => `[role='${role}']`).join(", ")

/** Which scroll keys a focused key target consumes instead of its scroller. */
export function describeKeyTarget(target: EventTarget | null) {
  const element = target as Element | null
  return {
    textEditing: Boolean(element?.closest?.(TEXT_EDITING_KEY_TARGET_SELECTOR)),
    interactive: Boolean(element?.closest?.(INTERACTIVE_KEY_TARGET_SELECTOR)),
    arrowWidget: Boolean(element?.closest?.(ARROW_KEY_WIDGET_SELECTOR)),
  }
}

export type KeyboardScrollIntent =
  | { type: "top" }
  | { type: "bottom" }
  | { type: "direction"; direction: "up" | "down"; distance: number }

/**
 * `distance` is Chromium's step in the scroller's own pixels, never more
 * (measured): a page is 0.875 of the viewport; a line is 40 DIP, which native
 * page zoom shrinks too. The renderer cannot separate that zoom from the display
 * scale, so dividing by CSS zoom × devicePixelRatio can only under-predict, and
 * an under-predicted landing just falls back to being observed.
 */
export function getKeyboardScrollIntent(input: {
  key: string
  shiftKey: boolean
  interactive: boolean
  textEditing: boolean
  arrowWidget: boolean
  viewportHeight: number
  zoom: number
  devicePixelRatio: number
}): KeyboardScrollIntent | null {
  if (input.textEditing) return null
  if (input.key === "End") return { type: "bottom" }
  if (input.key === "Home") return { type: "top" }
  const arrow = input.key.startsWith("Arrow")
  const space = input.key === " " || input.key === "Spacebar"
  if ((space && (input.interactive || input.arrowWidget)) || (arrow && input.arrowWidget)) return null
  const distance = arrow ? 40 / (input.zoom * Math.max(1, input.devicePixelRatio)) : Math.floor(input.viewportHeight * 0.875)
  if (input.key === "ArrowUp" || input.key === "PageUp" || (input.shiftKey && space)) {
    return { type: "direction", direction: "up", distance }
  }
  if (input.key === "ArrowDown" || input.key === "PageDown" || space) {
    return { type: "direction", direction: "down", distance }
  }
  return null
}

export function isScrollRestoreMeasurementReady(input: {
  hasHandle: boolean
  itemCount: number
  scrollSize: number
  viewportSize: number
}) {
  return input.itemCount === 0 || (input.hasHandle && input.scrollSize > 0 && input.viewportSize > 0)
}

export function getBottomAnchoredViewportOffset(offset: number, viewportHeightDelta: number): number {
  return Math.max(0, offset + viewportHeightDelta)
}

export interface BottomPinSettlementState {
  stableFrames: number
  lastMaxOffset: number | null
}

export function advanceBottomPinSettlement(
  state: BottomPinSettlementState,
  input: { ready: boolean; maxOffset: number | null; requiredStableFrames: number },
): BottomPinSettlementState & { settled: boolean } {
  const stableFrames = input.ready && input.maxOffset === state.lastMaxOffset
    ? state.stableFrames + 1
    : 0
  return {
    stableFrames,
    lastMaxOffset: input.maxOffset,
    settled: input.ready && stableFrames >= input.requiredStableFrames,
  }
}

// scrollHeight/clientHeight are rounded to integers while CSS zoom quantizes
// offsets to 1/zoom px: a viewport clamped at its bottom was measured 1.27px
// (zoom 1.1) and 1.33px (zoom 0.75) above the reported bottom.
export const SCROLL_EDGE_TOLERANCE_PX = 2

/** The single scroll-edge test; a viewport within the tolerance is at its true bottom. */
export function canScrollInDirection(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  direction: "up" | "down",
): boolean {
  if (direction === "up") return metrics.scrollTop > 0
  return metrics.scrollTop + metrics.clientHeight < metrics.scrollHeight - SCROLL_EDGE_TOLERANCE_PX
}

export function shouldNavigateAtBoundary(input: {
  atBoundary: boolean
  restoring: boolean
  programmatic: boolean
  hasFreshIntent: boolean
  intent: "up" | "down" | null
  direction: "up" | "down"
}): boolean {
  return input.atBoundary
    && !input.restoring
    && !input.programmatic
    && input.hasFreshIntent
    && input.intent === input.direction
}

export function classifyVirtualItemKeyChange(previous: string[], next: string[]) {
  const sharedLength = Math.min(previous.length, next.length)
  const keepsPrefix = previous.slice(0, sharedLength).every((key, index) => key === next[index])
  const shiftedStartCount = next.length > 0 ? previous.indexOf(next[0]) : -1
  const keepsShiftedSuffix = shiftedStartCount > 0
    && previous.slice(shiftedStartCount).every((key, index) => key === next[index])
  return {
    resetMeasurements: previous.length > 0 && (next.length === 0 || (!keepsPrefix && !keepsShiftedSuffix)),
    endChanged: previous.length > 0 && previous.at(-1) !== next.at(-1),
    shiftedStartCount: keepsShiftedSuffix ? shiftedStartCount : 0,
  }
}

export interface ViewportAnchorCandidate {
  key: string
  top: number
  bottom: number
}

export type AnchorRestoreFrameResult =
  | { type: "retry"; reissueIndex: boolean }
  | { type: "correct"; delta: number; finishAfterCorrection: boolean }
  | { type: "finish" }
  | { type: "fallback" }

export class ScrollRestoreTokenGuard {
  private token = 0

  begin() {
    this.token += 1
    return this.token
  }

  invalidate() {
    this.token += 1
  }

  isCurrent(token: number) {
    return token === this.token
  }
}

export class AnchorRestoreStabilizer {
  private elapsedFrames = 0
  private stableFrames = 0

  restartStability() {
    this.stableFrames = 0
  }

  snapshot() {
    return { elapsedFrames: this.elapsedFrames, stableFrames: this.stableFrames }
  }

  nextFrame(input: { targetExists: boolean; mounted: boolean; delta?: number }): AnchorRestoreFrameResult {
    this.elapsedFrames += 1
    if (!input.targetExists) {
      this.stableFrames = 0
      return this.elapsedFrames >= ANCHOR_RESTORE_MAX_FRAMES
        ? { type: "fallback" }
        : { type: "retry", reissueIndex: false }
    }

    if (input.mounted && typeof input.delta === "number") {
      if (Math.abs(input.delta) > ANCHOR_RESTORE_TOLERANCE_PX) {
        this.stableFrames = 0
        return {
          type: "correct",
          delta: input.delta,
          finishAfterCorrection: this.elapsedFrames >= ANCHOR_RESTORE_MAX_FRAMES,
        }
      }

      this.stableFrames += 1
      if (this.stableFrames >= ANCHOR_RESTORE_STABLE_FRAMES || this.elapsedFrames >= ANCHOR_RESTORE_MAX_FRAMES) {
        return { type: "finish" }
      }
    } else {
      this.stableFrames = 0
    }

    if (this.elapsedFrames >= ANCHOR_RESTORE_MAX_FRAMES && input.mounted) return { type: "finish" }
    if (this.elapsedFrames >= ANCHOR_RESTORE_MAX_FRAMES) return { type: "fallback" }
    return {
      type: "retry",
      reissueIndex: !input.mounted && this.elapsedFrames % ANCHOR_RESTORE_REISSUE_INTERVAL_FRAMES === 0,
    }
  }
}

export function selectTopViewportAnchor(
  candidates: ViewportAnchorCandidate[],
  viewportTop: number,
  viewportBottom: number,
  preferredKey?: string,
) {
  const visible = candidates.filter((candidate) => candidate.bottom > viewportTop && candidate.top < viewportBottom)
  const crossingTop = visible
    .filter((candidate) => candidate.top <= viewportTop && candidate.bottom > viewportTop)
    .sort((a, b) => b.top - a.top)[0]
  if (crossingTop) return crossingTop

  const preferred = preferredKey ? visible.find((candidate) => candidate.key === preferredKey) : undefined
  if (preferred) return preferred
  return visible.sort((a, b) => a.top - b.top)[0]
}

export function isScrollRestoreGenerationCurrent(
  startedSessionId: string,
  startedGeneration: number,
  currentSessionId: string,
  currentGeneration: number,
) {
  return startedSessionId === currentSessionId && startedGeneration === currentGeneration
}

export type FollowEffect =
  | { type: "none" }
  | { type: "scroll-top"; immediate: boolean }
  | { type: "scroll-bottom"; immediate: boolean }
  | { type: "scroll-key"; key: string; block: ScrollLogicalPosition; smooth: boolean }

export type FollowEvent =
  | { type: "user-scroll"; direction: "up" | "down" | null; atBottom: boolean }
  | { type: "jump-top"; immediate: boolean }
  | { type: "jump-bottom"; immediate: boolean; explicit: boolean }
  | { type: "jump-key"; key: string; block: ScrollLogicalPosition; smooth: boolean }
  | { type: "content-grew"; canPinToBottom: boolean }
  | { type: "set-follow"; enabled: boolean }
  | { type: "reset"; follow: boolean }

export interface FollowTransition {
  mode: FollowMode
  effect: FollowEffect
}

export type ScrollDirection = "up" | "down" | null

export interface ScrollControllerMetrics {
  offset: number
  scrollHeight: number
  clientHeight: number
  sentinelMarginPx: number
}

export interface ScrollControllerState {
  mode: FollowMode
  lastObservedOffset: number
  lastObservedAtBottom: boolean
  userIntentDirection: ScrollDirection
  userIntentUntil: number
  restoring: boolean
}

export interface ScrollControllerResult {
  effect: FollowEffect
  state: ScrollControllerState
}

export interface ScrollControllerSnapshot {
  mode: FollowMode
  lastObservedOffset: number
  lastObservedAtBottom: boolean
  userIntentDirection: ScrollDirection
  userIntentUntil: number
  restoring: boolean
}

export interface FollowSnapshotState {
  followModeType?: FollowMode["type"]
}

export type HoldTargetElementResolver = (itemWrapper: HTMLElement, key: string) => HTMLElement | null | undefined

const noFollowEffect: FollowEffect = { type: "none" }

export function isAutoFollowing(mode: FollowMode) {
  return mode.type === "following"
}

export function resolveAutoPinHoldElement(
  itemWrapper: HTMLElement | null | undefined,
  key: string,
  resolver?: HoldTargetElementResolver,
) {
  if (!itemWrapper) return null
  if (!resolver) return itemWrapper

  const resolved = resolver(itemWrapper, key)
  return resolved === undefined ? itemWrapper : resolved
}

export function isSnapshotAutoFollowing(snapshot: {
  atBottom: boolean
  followModeType?: FollowMode["type"]
  windowIsLatest?: boolean
} | null | undefined) {
  if (!snapshot) return true
  if (snapshot.windowIsLatest === false) return false
  return snapshot.atBottom && snapshot.followModeType !== "escaped"
}

export function getFollowSnapshotState(mode: FollowMode): FollowSnapshotState {
  return { followModeType: mode.type }
}

export function restoreFollowModeFromSnapshot(state: { atBottom: boolean; followModeType?: FollowMode["type"] }): FollowMode {
  if (state.followModeType === "escaped") return { type: "escaped" }
  return state.atBottom ? { type: "following" } : { type: "escaped" }
}

export function transitionFollowMode(mode: FollowMode, event: FollowEvent): FollowTransition {
  switch (event.type) {
    case "user-scroll": {
      if (event.direction === "up") return { mode: { type: "escaped" }, effect: noFollowEffect }
      if (event.atBottom) return { mode: { type: "following" }, effect: noFollowEffect }
      return { mode, effect: noFollowEffect }
    }

    case "jump-top":
      return { mode: { type: "escaped" }, effect: { type: "scroll-top", immediate: event.immediate } }

    case "jump-bottom":
      return {
        mode: { type: "following" },
        effect: { type: "scroll-bottom", immediate: event.immediate },
      }

    case "jump-key":
      return {
        mode: { type: "escaped" },
        effect: { type: "scroll-key", key: event.key, block: event.block, smooth: event.smooth },
      }

    case "content-grew":
      if (mode.type === "following" && event.canPinToBottom) {
        return { mode, effect: { type: "scroll-bottom", immediate: true } }
      }
      return { mode, effect: noFollowEffect }

    case "set-follow":
      return { mode: event.enabled ? { type: "following" } : { type: "escaped" }, effect: noFollowEffect }

    case "reset":
      return { mode: event.follow ? { type: "following" } : { type: "escaped" }, effect: noFollowEffect }
  }
}

export function getDistanceFromBottom(metrics: ScrollControllerMetrics) {
  return metrics.scrollHeight - (metrics.offset + metrics.clientHeight)
}

export function isAtBottom(metrics: ScrollControllerMetrics) {
  return getDistanceFromBottom(metrics) <= metrics.sentinelMarginPx
}

export function hasReachedBottom(metrics: ScrollControllerMetrics) {
  return !canScrollInDirection({ scrollTop: metrics.offset, scrollHeight: metrics.scrollHeight, clientHeight: metrics.clientHeight }, "down")
}

/** The proximity tolerance only maintains an active follow pin; a manual reader is at the bottom only at the true bottom. */
export function isAtBottomForMode(mode: FollowMode, metrics: ScrollControllerMetrics) {
  return isAutoFollowing(mode) ? isAtBottom(metrics) : hasReachedBottom(metrics)
}

export class VirtualScrollController {
  private state: ScrollControllerState

  constructor(initialFollow: boolean) {
    this.state = {
      mode: initialFollow ? { type: "following" } : { type: "escaped" },
      lastObservedOffset: 0,
      lastObservedAtBottom: false,
      userIntentDirection: null,
      userIntentUntil: 0,
      restoring: false,
    }
  }

  snapshot(): ScrollControllerSnapshot {
    return { ...this.state, mode: { ...this.state.mode } }
  }

  isAutoFollowing() {
    return isAutoFollowing(this.state.mode)
  }

  setUserIntent(direction: ScrollDirection, until: number) {
    this.state.userIntentDirection = direction
    this.state.userIntentUntil = until
  }

  /**
   * Records a user gesture before it scrolls. Upward intent escapes at once. A
   * downward gesture whose amplitude (`distance`, in scroller pixels) reaches
   * the bottom laid out now resumes follow at once: the browser clamps a wheel
   * to an earlier frame's bottom, and animates keys towards the bottom captured
   * when they start, so streamed growth leaves the landing short of the bottom.
   */
  userGesture(direction: ScrollDirection, until: number, metrics: ScrollControllerMetrics | null, distance = 0): ScrollControllerResult {
    this.setUserIntent(direction, until)
    if (direction === "up") return this.setFollow(false)
    if (direction === "down" && metrics && isAtBottomForMode(this.state.mode, { ...metrics, offset: metrics.offset + distance })) {
      return this.setFollow(true)
    }
    return this.result(noFollowEffect)
  }

  clearExpiredUserIntent(now: number) {
    if (now <= this.state.userIntentUntil) return false
    this.state.userIntentDirection = null
    return true
  }

  setRestoring(restoring: boolean) {
    this.state.restoring = restoring
  }

  reset(follow: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "reset", follow })
    this.state.mode = next.mode
    this.state.lastObservedOffset = 0
    this.state.lastObservedAtBottom = false
    this.state.userIntentDirection = null
    this.state.userIntentUntil = 0
    this.state.restoring = false
    return this.result(next.effect)
  }

  setFollow(enabled: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "set-follow", enabled })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  restoreMode(mode: FollowMode): ScrollControllerResult {
    this.state.mode = mode
    return this.result(noFollowEffect)
  }

  jumpTop(immediate: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "jump-top", immediate })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  jumpBottom(immediate: boolean, explicit: boolean): ScrollControllerResult {
    if (explicit) {
      this.state.userIntentDirection = null
      this.state.userIntentUntil = 0
    }
    const next = transitionFollowMode(this.state.mode, { type: "jump-bottom", immediate, explicit })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  jumpKey(key: string, block: ScrollLogicalPosition, smooth: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "jump-key", key, block, smooth })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  observeViewport(metrics: ScrollControllerMetrics, now: number, programmatic: boolean): ScrollControllerResult {
    const previousOffset = this.state.lastObservedOffset
    const offset = metrics.offset
    const scrolledUp = offset < previousOffset - 1
    const scrolledDown = offset > previousOffset + 1
    const atBottom = isAtBottom(metrics)

    this.state.lastObservedOffset = offset
    this.state.lastObservedAtBottom = this.isAutoFollowing() && atBottom
    this.clearExpiredUserIntent(now)

    const hasFreshIntent = now <= this.state.userIntentUntil
    const actualDirection: ScrollDirection = scrolledUp ? "up" : scrolledDown ? "down" : null
    if (hasFreshIntent && this.state.userIntentDirection === "up") {
      return this.setFollow(false)
    }

    if (!hasFreshIntent) {
      if (this.isAutoFollowing() && !atBottom && !this.state.restoring) {
        return this.result({ type: "scroll-bottom", immediate: true })
      }
      return this.result(noFollowEffect)
    }

    const direction = this.state.userIntentDirection ?? actualDirection
    if (direction === "up") {
      return this.setFollow(false)
    }

    // Explicit bottom commands enter follow mode through jumpBottom. A
    // measured programmatic move alone must never rejoin an escaped viewport.
    if (programmatic && this.state.mode.type === "escaped" && this.state.userIntentDirection !== "down") {
      return this.result(noFollowEffect)
    }

    const next = transitionFollowMode(this.state.mode, { type: "user-scroll", direction, atBottom: isAtBottomForMode(this.state.mode, metrics) })
    this.state.mode = next.mode
    this.state.lastObservedAtBottom = this.isAutoFollowing() && atBottom
    return this.result(next.effect)
  }

  contentRendered(_metrics: ScrollControllerMetrics, canPinToBottom: boolean): ScrollControllerResult {
    if (this.state.restoring) return this.result(noFollowEffect)
    const next = transitionFollowMode(this.state.mode, { type: "content-grew", canPinToBottom })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  recordProgrammaticOffset(offset: number, atBottom: boolean) {
    this.state.lastObservedOffset = offset
    this.state.lastObservedAtBottom = this.isAutoFollowing() && atBottom
  }

  private result(effect: FollowEffect): ScrollControllerResult {
    return { effect, state: this.snapshot() }
  }
}
