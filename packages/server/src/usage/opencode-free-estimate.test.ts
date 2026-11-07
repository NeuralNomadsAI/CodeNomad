import assert from "node:assert/strict"
import { test } from "node:test"
import { estimateOpenCodeFreeUsage, isOpenCodeFreeModel, openCodeFreeWindow } from "./opencode-free-estimate"

test("only OpenCode Console free models are estimated", () => {
  assert.equal(isOpenCodeFreeModel("opencode", "big-pickle"), true)
  assert.equal(isOpenCodeFreeModel("opencode", "deepseek-v4-flash-free"), true)
  assert.equal(isOpenCodeFreeModel("opencode", "claude-sonnet-4"), false)
  assert.equal(isOpenCodeFreeModel("openrouter", "some-model-free"), false)
  assert.equal(isOpenCodeFreeModel("opencode", undefined), false)
  assert.equal(isOpenCodeFreeModel(" OPENCODE ", " Example-FREE "), true)
  assert.equal(isOpenCodeFreeModel("opencode-go", "example-free"), false)
})

test("the estimate sums every free model since 00:00 UTC and resets at the next UTC midnight", () => {
  const now = Date.UTC(2026, 10, 3, 21, 30)
  const window = openCodeFreeWindow(now)
  assert.deepEqual(window, { from: Date.UTC(2026, 10, 3), to: now, resetAt: Date.UTC(2026, 10, 4) })
  assert.equal(openCodeFreeWindow(Date.UTC(2026, 10, 3)).to, Date.UTC(2026, 10, 3), "midnight has no elapsed activity")
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const model = (providerID: string, id: string, steps: number) => ({ model: { providerID, id }, steps, tokens, cost: 0 })
  const stats = { models: [model("opencode", "big-pickle", 30), model("opencode", "x-free", 20), model("opencode", "paid", 99), model("other", "y-free", 50)] }
  const usage = estimateOpenCodeFreeUsage(stats, "opencode", "x-free", now)
  assert.equal(usage.estimated, true)
  assert.equal(usage.providerName, "OpenCode Console")
  assert.deepEqual(usage.windows.daily, { usedPercent: 25, remainingPercent: 75, windowSeconds: 86_400, resetAt: window.resetAt, valueLabel: "50 / 200" })
  stats.models.push(model("opencode", "big-pickle", 500))
  assert.equal(estimateOpenCodeFreeUsage(stats, "opencode", "x-free", now).windows.daily.usedPercent, 100)
  for (const steps of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => estimateOpenCodeFreeUsage({ models: [model("opencode", "big-pickle", steps)] }, "opencode", "big-pickle", now))
  }
})
