import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  VirtualScrollController,
  isAtBottom,
  isAutoFollowing,
  transitionFollowMode,
  type FollowMode,
  type ScrollControllerMetrics,
} from "./virtual-follow-behavior.ts"

const userScroll = (direction: "up" | "down" | null, atBottom: boolean, canPinToBottom = false) =>
  ({ type: "user-scroll", direction, atBottom, canPinToBottom }) as const

function metrics(offset: number, scrollHeight = 3000, clientHeight = 600): ScrollControllerMetrics {
  return {
    offset,
    scrollHeight,
    clientHeight,
    sentinelMarginPx: 48,
  }
}

describe("virtual follow behavior", () => {
  it("escapes follow on upward user scroll", () => {
    const next = transitionFollowMode({ type: "following" }, userScroll("up", false))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("does not rejoin follow when escaped user scrolls down above bottom without pin permission", () => {
    const next = transitionFollowMode({ type: "escaped" }, userScroll("down", false))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("rejoins follow and pins bottom when escaped user scrolls down with pin permission", () => {
    const next = transitionFollowMode({ type: "escaped" }, userScroll("down", false, true))

    assert.deepEqual(next.mode, { type: "following" })
    assert.deepEqual(next.effect, { type: "scroll-bottom", immediate: true, suppressHold: false })
  })

  it("rejoins follow when escaped user scrolls to the bottom", () => {
    const next = transitionFollowMode({ type: "escaped" }, userScroll("down", true))

    assert.deepEqual(next.mode, { type: "following" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("releases hold when the user scrolls down above bottom", () => {
    const next = transitionFollowMode({ type: "holding", key: "message-1" }, userScroll("down", false, true))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("does not rejoin follow for directionless scroll above bottom", () => {
    const next = transitionFollowMode({ type: "escaped" }, userScroll(null, false, true))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("does not rejoin follow on upward scroll at bottom", () => {
    const next = transitionFollowMode({ type: "escaped" }, userScroll("up", true, true))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("releases hold for directionless user scroll away from bottom", () => {
    const next = transitionFollowMode({ type: "holding", key: "message-1" }, userScroll(null, false, true))

    assert.deepEqual(next.mode, { type: "escaped" })
    assert.deepEqual(next.effect, { type: "none" })
  })

  it("pins content growth while following but not while escaped", () => {
    const escaped = transitionFollowMode({ type: "escaped" }, { type: "content-grew", canPinToBottom: true })
    const following = transitionFollowMode({ type: "following" }, { type: "content-grew", canPinToBottom: true })

    assert.deepEqual(escaped.effect, { type: "none" })
    assert.deepEqual(following.effect, { type: "scroll-bottom", immediate: true, suppressHold: false })
  })

  it("maintains hold alignment while held content grows", () => {
    const next = transitionFollowMode({ type: "holding", key: "message-1" }, { type: "content-grew", canPinToBottom: true })

    assert.deepEqual(next.mode, { type: "holding", key: "message-1" })
    assert.deepEqual(next.effect, { type: "align-hold", key: "message-1" })
  })

  it("enters hold mode for a valid hold candidate", () => {
    const next = transitionFollowMode({ type: "following" }, { type: "hold-candidate", key: "message-1", shouldHold: true })

    assert.deepEqual(next.mode, { type: "holding", key: "message-1" })
    assert.deepEqual(next.effect, { type: "align-hold", key: "message-1" })
  })

  it("explicit bottom jumps leave hold and suppress the next hold", () => {
    const next = transitionFollowMode({ type: "holding", key: "message-1" }, { type: "jump-bottom", immediate: true, explicit: true })

    assert.deepEqual(next.mode, { type: "following" })
    assert.deepEqual(next.effect, { type: "scroll-bottom", immediate: true, suppressHold: true })
  })

  it("key jumps can opt into follow or escape mode", () => {
    const follow = transitionFollowMode({ type: "escaped" }, { type: "jump-key", key: "a", block: "start", smooth: false, followAfter: true })
    const escape = transitionFollowMode({ type: "following" }, { type: "jump-key", key: "b", block: "center", smooth: true, followAfter: false })

    assert.deepEqual(follow.mode, { type: "following" })
    assert.deepEqual(escape.mode, { type: "escaped" })
  })

  it("derives auto-follow from modes", () => {
    const modes: Array<[FollowMode, boolean]> = [
      [{ type: "following" }, true],
      [{ type: "holding", key: "message-1" }, true],
      [{ type: "escaped" }, false],
    ]

    for (const [mode, expected] of modes) {
      assert.equal(isAutoFollowing(mode), expected)
    }
  })

  it("pins content growth instead of escaping on transient upward render movement", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)

    const result = controller.contentRendered(metrics(2200), true)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "scroll-bottom", immediate: true, suppressHold: false })
  })

  it("maintains hold alignment when held content renders", () => {
    const controller = new VirtualScrollController(true)
    controller.holdCandidate("message-1", true)

    const result = controller.contentRendered(metrics(2200), true)

    assert.deepEqual(result.state.mode, { type: "holding", key: "message-1" })
    assert.deepEqual(result.effect, { type: "align-hold", key: "message-1" })
  })

  it("lets fresh user upward movement escape even during a programmatic window", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)
    controller.setUserIntent("up", 700)

    const result = controller.observeViewport(metrics(2200), 100, true)

    assert.deepEqual(result.state.mode, { type: "escaped" })
  })

  it("does not escape for owned programmatic upward movement", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)

    const result = controller.observeViewport(metrics(2200), 100, true)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "none" })
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

  it("resumes follow only when downward movement reaches actual bottom", () => {
    const controller = new VirtualScrollController(false)
    controller.recordProgrammaticOffset(2300, false)
    controller.setUserIntent("down", 700)

    const result = controller.observeViewport(metrics(2400), 100, false)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("still escapes follow on upward movement at bottom", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(1200, false)

    const result = controller.observeViewport(metrics(1100), 100, false)

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

  it("does not pin content growth when the integration gate is closed", () => {
    const controller = new VirtualScrollController(true)

    const result = controller.contentRendered(metrics(2400), false)

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("blocks pre-pin upward reconciliation while restoring", () => {
    const controller = new VirtualScrollController(true)
    controller.recordProgrammaticOffset(2400, true)
    controller.setRestoring(true)

    const result = controller.beforeBottomPin(metrics(2200))

    assert.deepEqual(result.state.mode, { type: "following" })
    assert.deepEqual(result.effect, { type: "none" })
  })

  it("distinguishes close-to-bottom from at-bottom metrics", () => {
    const closeButNotAtBottom = metrics(2351)

    assert.equal(isAtBottom(closeButNotAtBottom), false)
  })
})
