import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  ANCHOR_RESTORE_MAX_FRAMES,
  ANCHOR_RESTORE_STABLE_FRAMES,
  advanceBottomPinSettlement,
  AnchorRestoreStabilizer,
  BOTTOM_FOLLOW_EPSILON_PX,
  canScrollInDirection,
  classifyVirtualItemKeyChange,
  getKeyboardScrollIntent,
  getBottomAnchoredViewportOffset,
  getPrimaryPointerDragDirection,
  ScrollRestoreTokenGuard,
  shouldAdvanceBottomPin,
  shouldNavigateAtBoundary,
  VirtualScrollController,
  isAtBottom,
  isAutoFollowing,
  isMiddleButtonScrollIntent,
  isScrollRestoreGenerationCurrent,
  isScrollRestoreMeasurementReady,
  isSnapshotAutoFollowing,
  resolveAutoPinHoldElement,
  restoreFollowModeFromSnapshot,
  selectTopViewportAnchor,
  transitionFollowMode,
  type FollowMode,
  type ScrollControllerMetrics,
} from "./virtual-follow-behavior.ts"

const userScroll = (direction: "up" | "down" | null, atBottom: boolean) =>
  ({ type: "user-scroll", direction, atBottom }) as const

function metrics(offset: number, scrollHeight = 3000, clientHeight = 600, sentinelMarginPx = BOTTOM_FOLLOW_EPSILON_PX): ScrollControllerMetrics {
  return { offset, scrollHeight, clientHeight, sentinelMarginPx }
}

describe("virtual follow behavior", () => {
  it("treats only the middle pointer button as scroll ownership", () => {
    assert.equal(isMiddleButtonScrollIntent(1), true)
    assert.equal(isMiddleButtonScrollIntent(0), false)
    assert.equal(isMiddleButtonScrollIntent(2), false)
  })

  it("classifies primary selection drags without treating hover as scroll ownership", () => {
    assert.equal(getPrimaryPointerDragDirection(200, 150, 1), "up")
    assert.equal(getPrimaryPointerDragDirection(150, 200, 1), "down")
    assert.equal(getPrimaryPointerDragDirection(200, 150, 0), null)
  })

  it("keeps page navigation available from non-editing interactive descendants", () => {
    assert.deepEqual(getKeyboardScrollIntent({ key: "PageUp", shiftKey: false, interactive: true, textEditing: false }), {
      type: "direction",
      direction: "up",
    })
    assert.deepEqual(getKeyboardScrollIntent({ key: "Home", shiftKey: false, interactive: true, textEditing: false }), { type: "top" })
    assert.equal(getKeyboardScrollIntent({ key: "PageUp", shiftKey: false, interactive: true, textEditing: true }), null)
    assert.equal(getKeyboardScrollIntent({ key: " ", shiftKey: false, interactive: true, textEditing: false }), null)
  })

  it("waits for Virtua measurements before applying a restored offset", () => {
    assert.equal(isScrollRestoreMeasurementReady({ hasHandle: false, itemCount: 20, scrollSize: 0, viewportSize: 0 }), false)
    assert.equal(isScrollRestoreMeasurementReady({ hasHandle: true, itemCount: 20, scrollSize: 0, viewportSize: 600 }), false)
    assert.equal(isScrollRestoreMeasurementReady({ hasHandle: true, itemCount: 20, scrollSize: 3000, viewportSize: 600 }), true)
    assert.equal(isScrollRestoreMeasurementReady({ hasHandle: false, itemCount: 0, scrollSize: 0, viewportSize: 0 }), true)
  })

  it("escapes follow on any upward user intent", () => {
    const next = transitionFollowMode({ type: "following" }, userScroll("up", true))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("does not rejoin follow from downward movement above the exact bottom", () => {
    const next = transitionFollowMode({ type: "escaped" }, userScroll("down", false))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("rejoins follow only at the exact bottom", () => {
    const next = transitionFollowMode({ type: "escaped" }, userScroll("down", true))

    assert.deepEqual(next.mode, { type: "following" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("pins content growth while following but not while escaped", () => {
    const escaped = transitionFollowMode({ type: "escaped" }, { type: "content-grew", canPinToBottom: true })
    const following = transitionFollowMode({ type: "following" }, { type: "content-grew", canPinToBottom: true })

    assert.deepEqual(escaped.effect, { type: "none" })
    assert.deepEqual(following.effect, { type: "scroll-bottom", immediate: true })
  })

  it("does not pin content growth when the integration gate is closed", () => {
    const next = transitionFollowMode({ type: "following" }, { type: "content-grew", canPinToBottom: false })

    assert.deepEqual(next.mode, { type: "following" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("explicit bottom jumps enter follow mode", () => {
    const next = transitionFollowMode({ type: "escaped" }, { type: "jump-bottom", immediate: true, explicit: true })

    assert.deepEqual(next.mode, { type: "following" })
    assert.deepEqual(next.effect, { type: "scroll-bottom", immediate: true })
  })

  it("explicit bottom jumps override stale upward user intent", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2200, false)
    controller.setUserIntent("up", 700)

    const jump = controller.jumpBottom(true, true)
    const observed = controller.observeViewport(metrics(2400), 100, true)

    assert.deepEqual(jump.state.mode, { type: "following" })
    assert.deepEqual(observed.state.mode, { type: "following" })
  })

  it("key jumps always escape follow mode", () => {
    const fromEscaped = transitionFollowMode({ type: "escaped" }, { type: "jump-key", key: "a", block: "start", smooth: false })
    const fromFollowing = transitionFollowMode({ type: "following" }, { type: "jump-key", key: "b", block: "center", smooth: true })

    assert.deepEqual(fromEscaped.mode, { type: "escaped" })
    assert.deepEqual(fromFollowing.mode, { type: "escaped" })
  })

  it("derives auto-follow from the two modes", () => {
    const modes: Array<[FollowMode, boolean]> = [
      [{ type: "following" }, true],
      [{ type: "escaped" }, false],
    ]

    for (const [mode, expected] of modes) {
      assert.equal(isAutoFollowing(mode), expected)
    }
  })

  it("does not resume follow on directionless scroll above bottom", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2220, false)

    const result = controller.observeViewport(metrics(2220), 100, false)

    assert.deepEqual(result.state.mode, { type: "escaped" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("does not resume follow from pixel distance alone", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2100, false)
    controller.setUserIntent("down", 700)

    const result = controller.observeViewport(metrics(2220), 100, false)

    assert.deepEqual(result.state.mode, { type: "escaped" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("resumes follow only when downward movement reaches exact bottom", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2300, false)
    controller.setUserIntent("down", 700)

    const result = controller.observeViewport(metrics(2400), 100, false)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("lets fresh user upward movement escape even during a programmatic window", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)
    controller.setUserIntent("up", 700)

    const result = controller.observeViewport(metrics(2200), 100, true)

    assert.deepEqual(result.state.mode, { type: "escaped" })
  })

  it("keeps fresh upward intent escaped even if a programmatic scroll later moves down to bottom", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2200, false)
    controller.setUserIntent("up", 700)

    const result = controller.observeViewport(metrics(2400), 100, true)

    assert.deepEqual(result.state.mode, { type: "escaped" })
  })

  it("repins an off-bottom correction during the programmatic window", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)

    const result = controller.observeViewport(metrics(2200), 100, true)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "scroll-bottom", immediate: true })
  })

  it("never moves a bottom pin upward while measurements settle", () => {
    assert.equal(shouldAdvanceBottomPin(2400, 2200), false)
    assert.equal(shouldAdvanceBottomPin(2400, 2401), false)
    assert.equal(shouldAdvanceBottomPin(2400, 2500), true)
  })

  it("restarts bottom settlement when Virtua discovers a later maximum", () => {
    let state: { stableFrames: number; lastMaxOffset: number | null; settled?: boolean } = {
      stableFrames: 0,
      lastMaxOffset: null,
    }
    for (let frame = 0; frame < 7; frame += 1) {
      state = advanceBottomPinSettlement(state, { ready: true, maxOffset: 24_000, requiredStableFrames: 8 })
      assert.equal(state.settled, false)
    }

    state = advanceBottomPinSettlement(state, { ready: true, maxOffset: 26_000, requiredStableFrames: 8 })
    assert.deepEqual(state, { stableFrames: 0, lastMaxOffset: 26_000, settled: false })
    for (let frame = 0; frame < 8; frame += 1) {
      state = advanceBottomPinSettlement(state, { ready: true, maxOffset: 26_000, requiredStableFrames: 8 })
    }
    assert.equal(state.settled, true)
  })

  it("leaves nested scroll ownership with a descendant that can consume it", () => {
    assert.equal(canScrollInDirection({ scrollTop: 20, scrollHeight: 500, clientHeight: 100 }, "up"), true)
    assert.equal(canScrollInDirection({ scrollTop: 20, scrollHeight: 500, clientHeight: 100 }, "down"), true)
    assert.equal(canScrollInDirection({ scrollTop: 0, scrollHeight: 500, clientHeight: 100 }, "up"), false)
    assert.equal(canScrollInDirection({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 }, "down"), false)
  })

  it("requires fresh matching user intent before paging at a virtual boundary", () => {
    const base = { atBoundary: true, restoring: false, programmatic: false, hasFreshIntent: true, intent: "up" as const, direction: "up" as const }
    assert.equal(shouldNavigateAtBoundary(base), true)
    assert.equal(shouldNavigateAtBoundary({ ...base, hasFreshIntent: false }), false)
    assert.equal(shouldNavigateAtBoundary({ ...base, restoring: true }), false)
    assert.equal(shouldNavigateAtBoundary({ ...base, programmatic: true }), false)
    assert.equal(shouldNavigateAtBoundary({ ...base, intent: "down" }), false)
    assert.equal(shouldNavigateAtBoundary({ ...base, atBoundary: false }), false)
  })

  it("keeps the timeline viewport bottom anchored when its height changes", () => {
    assert.equal(getBottomAnchoredViewportOffset(2400, 200), 2600)
    assert.equal(getBottomAnchoredViewportOffset(2600, -200), 2400)
    assert.equal(getBottomAnchoredViewportOffset(50, -200), 0)
  })

  it("invalidates measurements when a capped window slides", () => {
    const previous = Array.from({ length: 200 }, (_, index) => `m${index}`)
    const next = [...previous.slice(1), "compaction"]

    assert.deepEqual(classifyVirtualItemKeyChange(previous, next), {
      resetMeasurements: true,
      endChanged: true,
    })
    assert.deepEqual(classifyVirtualItemKeyChange(next, next), {
      resetMeasurements: false,
      endChanged: false,
    })
    assert.equal(classifyVirtualItemKeyChange(next, []).resetMeasurements, true)
  })

  it("lets fresh downward intent rejoin at bottom during a programmatic window", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2200, false)
    controller.setUserIntent("down", 700)

    const result = controller.observeViewport(metrics(2400), 100, true)

    assert.deepEqual(result.state.mode, { type: "following" })
  })

  it("repins after an unowned virtualizer measurement correction", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)

    const result = controller.observeViewport(metrics(2200), 1000, false)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "scroll-bottom", immediate: true })
  })

  it("does not rejoin escaped mode from measurement-only downward movement", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2200, false)

    const result = controller.observeViewport(metrics(2400), 1000, false)

    assert.deepEqual(result.state.mode, { type: "escaped" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("keeps hold-driven escape stable across later viewport measurements", () => {
    const controller = new VirtualScrollController(true)
    controller.setFollow(false)
    controller.recordProgrammaticOffset(2200, false)

    const result = controller.observeViewport(metrics(2400), 1000, false)

    assert.deepEqual(result.state.mode, { type: "escaped" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("blocks content pinning while restoring", () => {
    const controller = new VirtualScrollController(true)
    controller.setRestoring(true)

    const result = controller.contentRendered(metrics(2400), true)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("uses a small bottom follow tolerance", () => {
    const bottomOffset = 2400

    assert.equal(isAtBottom(metrics(bottomOffset - BOTTOM_FOLLOW_EPSILON_PX - 0.1)), false)
    assert.equal(isAtBottom(metrics(bottomOffset - BOTTOM_FOLLOW_EPSILON_PX)), true)
    assert.equal(isAtBottom(metrics(bottomOffset)), true)
  })

  it("treats fractional distance inside the tolerance as at-bottom", () => {
    const bottomOffset = 2400

    assert.equal(isAtBottom(metrics(bottomOffset - BOTTOM_FOLLOW_EPSILON_PX - 0.5)), false)
    assert.equal(isAtBottom(metrics(bottomOffset - 0.5)), true)
  })

  it("does not restore follow from an off-bottom snapshot", () => {
    assert.equal(isSnapshotAutoFollowing({ atBottom: false, followModeType: "following" }), false)
    assert.deepEqual(restoreFollowModeFromSnapshot({ atBottom: false, followModeType: "following" }), { type: "escaped" })
  })

  it("keeps hold element resolution as a DOM concern", () => {
    const itemWrapper = { id: "message-wrapper" } as unknown as HTMLElement
    const assistantAnswerText = { id: "assistant-answer-text" } as unknown as HTMLElement

    assert.equal(resolveAutoPinHoldElement(itemWrapper, "message-1", () => null), null)
    assert.equal(resolveAutoPinHoldElement(itemWrapper, "message-1", () => assistantAnswerText), assistantAnswerText)
    assert.equal(resolveAutoPinHoldElement(itemWrapper, "message-1", () => undefined), itemWrapper)
  })

  it("selects the item crossing the viewport top instead of the nearest item top", () => {
    const anchor = selectTopViewportAnchor([
      { key: "crossing", top: -80, bottom: 120 },
      { key: "below", top: 2, bottom: 102 },
    ], 0, 600)

    assert.equal(anchor?.key, "crossing")
  })

  it("keeps waiting for an existing anchor that mounts after six frames", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    let result

    for (let frame = 1; frame <= 7; frame += 1) {
      result = stabilizer.nextFrame({ targetExists: true, mounted: false })
      assert.equal(result.type, "retry")
    }
    for (let frame = 8; frame <= 12; frame += 1) {
      result = stabilizer.nextFrame({ targetExists: true, mounted: false })
    }

    assert.deepEqual(result, { type: "retry", reissueIndex: true })
  })

  it("waits for a paginated anchor before falling back at the strict frame bound", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    let result
    for (let frame = 1; frame < ANCHOR_RESTORE_MAX_FRAMES; frame += 1) {
      result = stabilizer.nextFrame({ targetExists: false, mounted: false })
    }
    assert.deepEqual(result, { type: "retry", reissueIndex: false })
    assert.deepEqual(stabilizer.nextFrame({ targetExists: false, mounted: false }), { type: "fallback" })
  })

  it("resets stable frame counting after an anchor offset correction", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    for (let frame = 0; frame < ANCHOR_RESTORE_STABLE_FRAMES - 2; frame += 1) {
      assert.equal(stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 0.5 }).type, "retry")
    }

    assert.deepEqual(stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 4 }), {
      type: "correct",
      delta: 4,
      finishAfterCorrection: false,
    })
    assert.equal(stabilizer.snapshot().stableFrames, 0)
    for (let frame = 0; frame < ANCHOR_RESTORE_STABLE_FRAMES - 1; frame += 1) {
      assert.equal(stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 0 }).type, "retry")
    }
    assert.equal(stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 0 }).type, "finish")
  })

  it("restarts anchor stabilization when content grows", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    for (let frame = 0; frame < ANCHOR_RESTORE_STABLE_FRAMES - 1; frame += 1) {
      stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 0 })
    }

    stabilizer.restartStability()

    assert.equal(stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 0 }).type, "retry")
    assert.equal(stabilizer.snapshot().stableFrames, 1)
  })

  it("finishes a mounted anchor at the frame bound instead of ratio fallback", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    let result
    for (let frame = 1; frame <= ANCHOR_RESTORE_MAX_FRAMES; frame += 1) {
      stabilizer.restartStability()
      result = stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 0 })
    }

    assert.deepEqual(result, { type: "finish" })
  })

  it("requests one final mounted-anchor correction at the frame bound", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    for (let frame = 1; frame < ANCHOR_RESTORE_MAX_FRAMES; frame += 1) {
      stabilizer.restartStability()
      stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 0 })
    }

    assert.deepEqual(stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 6 }), {
      type: "correct",
      delta: 6,
      finishAfterCorrection: true,
    })
  })

  it("ratio-fallbacks at the frame bound only when an existing anchor never mounts", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    let result
    for (let frame = 1; frame < ANCHOR_RESTORE_MAX_FRAMES; frame += 1) {
      result = stabilizer.nextFrame({ targetExists: true, mounted: false })
    }

    assert.equal(result?.type, "retry")
    assert.equal(stabilizer.snapshot().elapsedFrames, ANCHOR_RESTORE_MAX_FRAMES - 1)
    result = stabilizer.nextFrame({ targetExists: true, mounted: false })
    assert.deepEqual(result, { type: "fallback" })
    assert.equal(stabilizer.snapshot().elapsedFrames, ANCHOR_RESTORE_MAX_FRAMES)
  })

  it("fallbacks when a previously mounted anchor is unmounted at the strict frame bound", () => {
    const stabilizer = new AnchorRestoreStabilizer()
    stabilizer.nextFrame({ targetExists: true, mounted: true, delta: 4 })
    let result
    for (let frame = 2; frame <= ANCHOR_RESTORE_MAX_FRAMES; frame += 1) {
      result = stabilizer.nextFrame({ targetExists: true, mounted: false })
    }

    assert.deepEqual(result, { type: "fallback" })
    assert.equal(stabilizer.snapshot().elapsedFrames, ANCHOR_RESTORE_MAX_FRAMES)
  })

  it("invalidates deferred at-bottom and pixel-only restore finishes on cancellation", () => {
    for (const path of ["at-bottom", "pixel-only"]) {
      const guard = new ScrollRestoreTokenGuard()
      const token = guard.begin()
      let cancelled = false
      let restoredOldMode = false
      const finish = () => {
        if (guard.isCurrent(token)) restoredOldMode = true
      }
      const cancel = () => {
        guard.invalidate()
        cancelled = true
      }

      cancel()
      finish()

      assert.equal(cancelled, true, path)
      assert.equal(restoredOldMode, false, path)
    }
  })

  it("rejects stale applied or cancellation callbacks from another session generation", () => {
    assert.equal(isScrollRestoreGenerationCurrent("session-a", 3, "session-a", 3), true)
    assert.equal(isScrollRestoreGenerationCurrent("session-a", 3, "session-b", 4), false)
    assert.equal(isScrollRestoreGenerationCurrent("session-a", 3, "session-a", 4), false)
  })
})
