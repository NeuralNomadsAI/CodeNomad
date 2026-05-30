import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatElapsedClock, getMessageDurationMs, inferReasoningDurationMs } from "./message-timing.ts"

describe("message timing helpers", () => {
  it("formats elapsed durations as clock values without unit suffixes", () => {
    assert.equal(formatElapsedClock(900), "0:01")
    assert.equal(formatElapsedClock(65_000), "1:05")
    assert.equal(formatElapsedClock(3_725_000), "1:02:05")
  })

  it("uses message created/completed times for assistant durations", () => {
    const duration = getMessageDurationMs({ time: { created: 1_000, completed: 7_000 } } as any, "complete")
    assert.equal(duration, 6_000)
  })

  it("does not infer message duration from legacy end or updated fields", () => {
    const fromEnd = getMessageDurationMs({ time: { created: 1_000, end: 7_000 } } as any, "complete")
    const fromUpdated = getMessageDurationMs({ time: { created: 1_000, updated: 5_000 } } as any, "error")
    assert.equal(fromEnd, undefined)
    assert.equal(fromUpdated, undefined)
  })

  it("does not infer message duration from explicit duration fields", () => {
    const duration = getMessageDurationMs({ duration: 6_000, time: { duration: 6_000 } } as any, "complete")
    assert.equal(duration, undefined)
  })

  it("uses reasoning start/end times when OpenCode provides them on the part", () => {
    const reasoningPart = { id: "reasoning-1", type: "reasoning", time: { start: 1_000, end: 4_500 } } as any
    const duration = inferReasoningDurationMs([reasoningPart], reasoningPart)
    assert.equal(duration, 3_500)
  })

  it("does not infer reasoning duration from message completion or fallback fields", () => {
    const reasoningPart = { id: "reasoning-1", type: "reasoning", duration: 3_000, time: { created: 1_000, start: 2_000 } } as any
    const duration = inferReasoningDurationMs(
      [reasoningPart],
      reasoningPart,
      { time: { created: 1_000, completed: 8_000 } } as any,
      "complete",
    )
    assert.equal(duration, undefined)
  })
})
