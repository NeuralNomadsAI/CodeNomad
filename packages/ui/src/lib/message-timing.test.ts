import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatElapsedClock, getMessageDurationMs, inferReasoningDurationMs } from "./message-timing.ts"

describe("message timing helpers", () => {
  it("formats elapsed durations as clock values", () => {
    assert.equal(formatElapsedClock(900), "0:01")
    assert.equal(formatElapsedClock(65_000), "1:05")
    assert.equal(formatElapsedClock(3_725_000), "1:02:05")
  })

  it("prefers message end time for completed durations", () => {
    const duration = getMessageDurationMs({ time: { created: 1_000, end: 7_000 } } as any, "complete")
    assert.equal(duration, 6_000)
  })

  it("falls back to updated time once a non-streaming message has finished", () => {
    const duration = getMessageDurationMs({ time: { created: 1_000, updated: 5_000 } } as any, "error")
    assert.equal(duration, 4_000)
  })

  it("uses explicit reasoning duration when present", () => {
    const reasoningPart = { id: "reasoning-1", type: "reasoning", duration: 3_000 } as any
    const duration = inferReasoningDurationMs([reasoningPart], reasoningPart)
    assert.equal(duration, 3_000)
  })

  it("infers reasoning duration from the next timed part", () => {
    const reasoningPart = { id: "reasoning-1", type: "reasoning", time: { start: 1_000 } } as any
    const textPart = { id: "text-1", type: "text", text: "done", time: { start: 4_500 } } as any
    const duration = inferReasoningDurationMs([reasoningPart, textPart], reasoningPart)
    assert.equal(duration, 3_500)
  })

  it("falls back to message completion when no later timed part exists", () => {
    const reasoningPart = { id: "reasoning-1", type: "reasoning", time: { start: 2_000 } } as any
    const duration = inferReasoningDurationMs(
      [reasoningPart],
      reasoningPart,
      { time: { created: 1_000, end: 8_000 } } as any,
      "complete",
    )
    assert.equal(duration, 6_000)
  })
})
