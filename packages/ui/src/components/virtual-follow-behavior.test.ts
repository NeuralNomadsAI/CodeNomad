import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  BOTTOM_FOLLOW_EPSILON_PX,
  VirtualScrollController,
  isAtBottom,
  isAutoFollowing,
  isSnapshotAutoFollowing,
  resolveAutoPinHoldElement,
  restoreFollowModeFromSnapshot,
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

  it("does not escape for owned programmatic upward movement", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)

    const result = controller.observeViewport(metrics(2200), 100, true)

    assert.deepEqual(result.state.mode, { type: "following" })
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
})
