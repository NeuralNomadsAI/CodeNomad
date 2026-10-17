import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatElapsedDuration, getMessageDurationMs, getPartDurationMs, getPartEndedAt, getPartStartedAt, inferReasoningDurationMs } from "./message-timing.ts"

describe("message timing helpers", () => {
  it("formats elapsed durations with short units, never as a clock reading", () => {
    assert.equal(formatElapsedDuration(900, "en"), "1s")
    assert.equal(formatElapsedDuration(3_000, "en"), "3s")
    assert.equal(formatElapsedDuration(65_000, "en"), "1m 5s")
    assert.equal(formatElapsedDuration(120_000, "en"), "2m")
    assert.equal(formatElapsedDuration(3_725_000, "en"), "1h 2m")
    assert.equal(formatElapsedDuration(3_600_000, "en"), "1h")
    assert.equal(formatElapsedDuration(0, "en"), "")
  })

  it("localizes units and digits", () => {
    const unit = (locale: string, unit: string, value: number) =>
      new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow", useGrouping: false }).format(value)

    assert.equal(formatElapsedDuration(65_000, "fr"), `${unit("fr", "minute", 1)} ${unit("fr", "second", 5)}`)
    assert.equal(formatElapsedDuration(65_000, "ar-EG"), `${unit("ar-EG", "minute", 1)} ${unit("ar-EG", "second", 5)}`)
    assert.doesNotMatch(formatElapsedDuration(65_000, "ar-EG"), /:/)
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

  it("uses OpenCode V2 created/completed reasoning times and ran/completed tool times", () => {
    const reasoningPart = { id: "reasoning-2", type: "reasoning", time: { created: 1_000, completed: 4_000 } } as any
    assert.equal(inferReasoningDurationMs([reasoningPart], reasoningPart), 3_000)
    // A tool's duration is its execution, from ran, not the streaming of its input.
    const tool = { id: "tool-1", type: "tool", time: { created: 1_000, ran: 2_500, completed: 6_500 } } as any
    assert.equal(getPartStartedAt(tool), 2_500)
    assert.equal(getPartEndedAt(tool), 6_500)
    assert.equal(getPartDurationMs(tool), 4_000)
    assert.equal(getPartDurationMs({ type: "tool", time: { created: 1_000 } } as any), undefined, "still running")
    assert.equal(getPartStartedAt({ type: "tool", time: { created: 1_000 } } as any), 1_000)
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
