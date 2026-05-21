import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { SessionInfo } from "../stores/sessions.js"
import { computeThreadTotals } from "./thread-totals.js"

function makeInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    cost: 0,
    contextWindow: 0,
    isSubscriptionModel: false,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    actualUsageTokens: 0,
    modelOutputLimit: 0,
    contextAvailableTokens: null,
    ...overrides,
  }
}

describe("computeThreadTotals", () => {
  it("sums cost, input, output, and reasoning tokens for normal sessions", () => {
    const family = [{ id: "s1" }, { id: "s2" }]
    const infoMap = new Map<string, SessionInfo>([
      ["s1", makeInfo({ cost: 0.15, inputTokens: 500, outputTokens: 200, reasoningTokens: 100 })],
      ["s2", makeInfo({ cost: 0.35, inputTokens: 1000, outputTokens: 400, reasoningTokens: 200 })],
    ])

    const totals = computeThreadTotals(family, infoMap)

    assert.equal(totals.cost, 0.5)
    assert.equal(totals.inputTokens, 1500)
    assert.equal(totals.outputTokens, 600)
    assert.equal(totals.reasoningTokens, 300)
  })

  it("includes tokens but not cost for subscription model sessions", () => {
    const family = [{ id: "s1" }]
    const infoMap = new Map<string, SessionInfo>([
      [
        "s1",
        makeInfo({
          cost: 1.0,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 25,
          isSubscriptionModel: true,
        }),
      ],
    ])

    const totals = computeThreadTotals(family, infoMap)

    assert.equal(totals.cost, 0)
    assert.equal(totals.inputTokens, 100)
    assert.equal(totals.outputTokens, 50)
    assert.equal(totals.reasoningTokens, 25)
  })

  it("mixes subscription and normal sessions correctly", () => {
    const family = [{ id: "normal" }, { id: "sub" }]
    const infoMap = new Map<string, SessionInfo>([
      [
        "normal",
        makeInfo({ cost: 0.1, inputTokens: 200, outputTokens: 100, reasoningTokens: 50 }),
      ],
      [
        "sub",
        makeInfo({
          cost: 0.5,
          inputTokens: 300,
          outputTokens: 150,
          reasoningTokens: 75,
          isSubscriptionModel: true,
        }),
      ],
    ])

    const totals = computeThreadTotals(family, infoMap)

    assert.equal(totals.cost, 0.1)
    assert.equal(totals.inputTokens, 500)
    assert.equal(totals.outputTokens, 250)
    assert.equal(totals.reasoningTokens, 125)
  })

  it("returns zeros for an empty family", () => {
    const totals = computeThreadTotals([], undefined)

    assert.equal(totals.cost, 0)
    assert.equal(totals.inputTokens, 0)
    assert.equal(totals.outputTokens, 0)
    assert.equal(totals.reasoningTokens, 0)
  })

  it("returns zeros when no session info is available", () => {
    const family = [{ id: "missing" }]

    const totals = computeThreadTotals(family, undefined)

    assert.equal(totals.cost, 0)
    assert.equal(totals.inputTokens, 0)
    assert.equal(totals.outputTokens, 0)
    assert.equal(totals.reasoningTokens, 0)
  })

  it("treats missing info as zeros", () => {
    const family = [{ id: "present" }, { id: "missing" }]
    const infoMap = new Map<string, SessionInfo>([
      [
        "present",
        makeInfo({ cost: 0.1, inputTokens: 100, outputTokens: 50, reasoningTokens: 10 }),
      ],
    ])

    const totals = computeThreadTotals(family, infoMap)

    assert.equal(totals.cost, 0.1)
    assert.equal(totals.inputTokens, 100)
    assert.equal(totals.outputTokens, 50)
    assert.equal(totals.reasoningTokens, 10)
  })
})
