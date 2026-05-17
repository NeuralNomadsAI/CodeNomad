import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { MIN_RELOAD_SPINNER_MS, withMinimumDuration } from "./min-duration.ts"

/**
 * Regression tests for the bug "session list refresh icon does not animate
 * for the currently active session" (task 060).
 *
 * The user-visible symptom is that clicking the reload icon on the active
 * session shows no spinner because the underlying `loadMessages(..., { force: true })`
 * can resolve in the same microtask (silent early-return on in-flight reload).
 * `withMinimumDuration` is the floor that guarantees the spinner remains
 * visible long enough to be perceived regardless of how fast the work resolves.
 *
 * These tests exercise the pure helper with injectable time and delay so
 * they do not depend on real wall-clock time. They use the existing
 * `node:test` runner (no vitest in this repo) and are wired to follow the
 * same pattern as `packages/ui/src/components/tool-call/question-active.test.ts`.
 */

interface Frame {
  resolve: () => void
  scheduledAt: number
}

/**
 * Minimal virtual clock. `advance(ms)` moves time forward and resolves any
 * delays whose deadlines have been reached, in insertion order, so callers
 * can deterministically drive the helper.
 */
function createVirtualClock(start = 1_000_000) {
  let nowMs = start
  const frames: Array<Frame & { deadline: number }> = []

  function now(): number {
    return nowMs
  }

  function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      frames.push({ resolve, scheduledAt: nowMs, deadline: nowMs + ms })
    })
  }

  async function advance(ms: number): Promise<void> {
    nowMs += ms
    // Flush any frames whose deadline is now in the past, in deadline order.
    frames.sort((a, b) => a.deadline - b.deadline)
    while (frames.length > 0 && frames[0]!.deadline <= nowMs) {
      const frame = frames.shift()!
      frame.resolve()
      // Yield to the microtask queue so awaiters can observe the resolution
      // before we continue advancing.
      await Promise.resolve()
    }
  }

  return { now, delay, advance, pending: () => frames.length }
}

describe("withMinimumDuration", () => {
  it("holds a fast-resolving promise until the minimum duration has elapsed", async () => {
    const clock = createVirtualClock()

    const work = Promise.resolve("done")
    const wrapped = withMinimumDuration(work, 450, { now: clock.now, delay: clock.delay })

    // The inner work has already resolved, so the helper has scheduled a
    // delay for the remaining 450ms. Advancing time by less than that must
    // not settle the wrapper.
    await clock.advance(449)
    let settled = false
    void wrapped.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    // Give the microtask queue a chance to observe any incorrect early-resolve.
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(settled, false, "wrapper resolved before minimum duration elapsed")

    // Push time over the threshold; the wrapper must now resolve with the
    // original value.
    await clock.advance(1)
    const value = await wrapped
    assert.equal(value, "done")
  })

  it("forwards a slow-resolving promise immediately once it resolves (no extra delay)", async () => {
    const clock = createVirtualClock()

    let resolveWork: ((value: string) => void) | null = null
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve
    })
    const wrapped = withMinimumDuration(work, 450, { now: clock.now, delay: clock.delay })

    // Advance well past the minimum-duration threshold while the work is
    // still pending.
    await clock.advance(900)

    // Now resolve the work. The wrapper must surface the value without
    // scheduling any additional delay (elapsed > minMs at this point).
    resolveWork!("late-done")
    const value = await wrapped
    assert.equal(value, "late-done")
    assert.equal(clock.pending(), 0, "no pending delays should remain")
  })

  it("propagates a fast rejection but holds it until the minimum duration has elapsed", async () => {
    const clock = createVirtualClock()

    const failure = new Error("boom")
    const work = Promise.reject(failure)
    const wrapped = withMinimumDuration(work, 450, { now: clock.now, delay: clock.delay })

    // Attach a catch handler immediately so the unhandled-rejection guard
    // does not abort the test runner. The handler must not see the
    // rejection before the minimum duration has elapsed.
    let observed: unknown = null
    const observation = wrapped.catch((err) => {
      observed = err
    })

    await clock.advance(449)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(observed, null, "rejection surfaced before minimum duration elapsed")

    await clock.advance(1)
    await observation
    assert.equal(observed, failure)
  })

  it("propagates a slow rejection immediately once the work rejects (no extra delay)", async () => {
    const clock = createVirtualClock()

    let rejectWork: ((reason: unknown) => void) | null = null
    const work = new Promise<string>((_resolve, reject) => {
      rejectWork = reject
    })
    const wrapped = withMinimumDuration(work, 450, { now: clock.now, delay: clock.delay })

    await clock.advance(900)
    const failure = new Error("late-boom")
    rejectWork!(failure)

    let observed: unknown = null
    await wrapped.catch((err) => {
      observed = err
    })
    assert.equal(observed, failure)
    assert.equal(clock.pending(), 0, "no pending delays should remain")
  })

  it("returns the underlying promise unchanged when minMs is non-positive", async () => {
    const clock = createVirtualClock()
    const work = Promise.resolve(42)
    const wrapped = withMinimumDuration(work, 0, { now: clock.now, delay: clock.delay })
    assert.equal(await wrapped, 42)
    assert.equal(clock.pending(), 0, "no delays should be scheduled when minMs <= 0")
  })

  it("exports a default minimum duration suitable for the reload spinner", () => {
    // Codified to lock in a UX-tuned value; bumping requires a deliberate
    // edit to the constant.
    assert.equal(typeof MIN_RELOAD_SPINNER_MS, "number")
    assert.ok(MIN_RELOAD_SPINNER_MS >= 300, "minimum should not feel like a flicker")
    assert.ok(MIN_RELOAD_SPINNER_MS <= 1000, "minimum should not feel sluggish")
  })
})
