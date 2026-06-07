export type FollowMode =
  | { type: "following" }
  | { type: "escaped" }
  | { type: "holding"; key: string }

export type FollowEffect =
  | { type: "none" }
  | { type: "scroll-top"; immediate: boolean }
  | { type: "scroll-bottom"; immediate: boolean; suppressHold: boolean }
  | { type: "scroll-key"; key: string; block: ScrollLogicalPosition; smooth: boolean }
  | { type: "align-hold"; key: string }

export type FollowEvent =
  | { type: "user-scroll"; direction: "up" | "down" | null; atBottom: boolean; canPinToBottom: boolean }
  | { type: "jump-top"; immediate: boolean }
  | { type: "jump-bottom"; immediate: boolean; explicit: boolean }
  | { type: "jump-key"; key: string; block: ScrollLogicalPosition; smooth: boolean; followAfter: boolean }
  | { type: "content-grew"; canPinToBottom: boolean }
  | { type: "hold-candidate"; key: string; shouldHold: boolean }
  | { type: "hold-target-changed"; key: string | null; canPinToBottom: boolean }
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

const noFollowEffect: FollowEffect = { type: "none" }

export function isAutoFollowing(mode: FollowMode) {
  return mode.type === "following" || mode.type === "holding"
}

export function getHeldKey(mode: FollowMode) {
  return mode.type === "holding" ? mode.key : null
}

export function transitionFollowMode(mode: FollowMode, event: FollowEvent): FollowTransition {
  switch (event.type) {
    case "user-scroll": {
      if (event.direction === "up") {
        return { mode: { type: "escaped" }, effect: noFollowEffect }
      }
      if (mode.type === "holding" && event.direction === null) {
        return { mode: { type: "escaped" }, effect: noFollowEffect }
      }
      if (mode.type === "holding" && event.direction === "down") {
        return { mode: { type: "escaped" }, effect: noFollowEffect }
      }
      if (mode.type === "escaped" && event.direction === "down" && event.canPinToBottom) {
        return {
          mode: { type: "following" },
          effect: { type: "scroll-bottom", immediate: true, suppressHold: false },
        }
      }
      if (event.atBottom && mode.type !== "holding") {
        return { mode: { type: "following" }, effect: noFollowEffect }
      }
      return { mode, effect: noFollowEffect }
    }

    case "jump-top":
      return { mode: { type: "escaped" }, effect: { type: "scroll-top", immediate: event.immediate } }

    case "jump-bottom":
      return {
        mode: { type: "following" },
        effect: { type: "scroll-bottom", immediate: event.immediate, suppressHold: event.explicit },
      }

    case "jump-key":
      return {
        mode: event.followAfter ? { type: "following" } : { type: "escaped" },
        effect: { type: "scroll-key", key: event.key, block: event.block, smooth: event.smooth },
      }

    case "content-grew":
      if (mode.type === "following" && event.canPinToBottom) {
        return { mode, effect: { type: "scroll-bottom", immediate: true, suppressHold: false } }
      }
      if (mode.type === "holding" && event.canPinToBottom) {
        return { mode, effect: { type: "align-hold", key: mode.key } }
      }
      return { mode, effect: noFollowEffect }

    case "hold-candidate":
      if (mode.type === "following" && event.shouldHold) {
        return { mode: { type: "holding", key: event.key }, effect: { type: "align-hold", key: event.key } }
      }
      return { mode, effect: noFollowEffect }

    case "hold-target-changed":
      if (mode.type !== "holding" || event.key === mode.key) {
        return { mode, effect: noFollowEffect }
      }
      return {
        mode: { type: "following" },
        effect: event.canPinToBottom ? { type: "scroll-bottom", immediate: false, suppressHold: false } : noFollowEffect,
      }

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

  heldKey() {
    return this.state.mode.type === "holding" ? this.state.mode.key : null
  }

  setUserIntent(direction: ScrollDirection, until: number) {
    this.state.userIntentDirection = direction
    this.state.userIntentUntil = until
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

  jumpTop(immediate: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "jump-top", immediate })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  jumpBottom(immediate: boolean, explicit: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "jump-bottom", immediate, explicit })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  jumpKey(key: string, block: ScrollLogicalPosition, smooth: boolean, followAfter: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "jump-key", key, block, smooth, followAfter })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  holdCandidate(key: string, shouldHold: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "hold-candidate", key, shouldHold })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  holdTargetChanged(key: string | null, canPinToBottom: boolean): ScrollControllerResult {
    const next = transitionFollowMode(this.state.mode, { type: "hold-target-changed", key, canPinToBottom })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  observeViewport(metrics: ScrollControllerMetrics, now: number, programmatic: boolean, canPinToBottom = false): ScrollControllerResult {
    const previousOffset = this.state.lastObservedOffset
    const offset = metrics.offset
    const scrolledUp = offset < previousOffset - 1
    const scrolledDown = offset > previousOffset + 1
    const atBottom = isAtBottom(metrics)

    this.state.lastObservedOffset = offset
    this.state.lastObservedAtBottom = this.isAutoFollowing() && atBottom
    this.clearExpiredUserIntent(now)

    const hasFreshIntent = now <= this.state.userIntentUntil
    if (scrolledUp && this.isAutoFollowing() && !atBottom && this.heldKey() === null && (!programmatic || hasFreshIntent)) {
      return this.setFollow(false)
    }

    const actualDirection: ScrollDirection = scrolledUp ? "up" : scrolledDown ? "down" : null
    if (!hasFreshIntent && (!actualDirection || programmatic)) {
      return this.result(noFollowEffect)
    }

    const direction = actualDirection ?? this.state.userIntentDirection
    const canMagnetToBottom = hasFreshIntent && direction === "down" && canPinToBottom
    const next = transitionFollowMode(this.state.mode, {
      type: "user-scroll",
      direction,
      atBottom,
      canPinToBottom: canMagnetToBottom,
    })
    this.state.mode = next.mode
    this.state.lastObservedAtBottom = this.isAutoFollowing() && atBottom
    return this.result(next.effect)
  }

  contentRendered(metrics: ScrollControllerMetrics, canPinToBottom: boolean): ScrollControllerResult {
    if (this.state.restoring) return this.result(noFollowEffect)
    if (!canPinToBottom || !this.isAutoFollowing()) {
      const reconcile = this.reconcileUpwardDomMovement(metrics)
      if (reconcile.effect.type !== "none") return reconcile
    }

    const next = transitionFollowMode(this.state.mode, { type: "content-grew", canPinToBottom })
    this.state.mode = next.mode
    return this.result(next.effect)
  }

  beforeBottomPin(metrics: ScrollControllerMetrics): ScrollControllerResult {
    if (this.state.restoring) return this.result(noFollowEffect)
    return this.reconcileUpwardDomMovement(metrics)
  }

  recordProgrammaticOffset(offset: number, atBottom: boolean) {
    this.state.lastObservedOffset = offset
    this.state.lastObservedAtBottom = this.isAutoFollowing() && atBottom
  }

  private reconcileUpwardDomMovement(metrics: ScrollControllerMetrics): ScrollControllerResult {
    if (!this.isAutoFollowing()) return this.result(noFollowEffect)
    if (this.heldKey() !== null) return this.result(noFollowEffect)
    if (isAtBottom(metrics)) return this.result(noFollowEffect)
    if (metrics.offset >= this.state.lastObservedOffset - 1) return this.result(noFollowEffect)
    this.state.lastObservedOffset = metrics.offset
    this.state.lastObservedAtBottom = false
    return this.setFollow(false)
  }

  private result(effect: FollowEffect): ScrollControllerResult {
    return { effect, state: this.snapshot() }
  }
}
