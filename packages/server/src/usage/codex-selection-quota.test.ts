import assert from "node:assert/strict"
import test from "node:test"
import { parseCodexSelectionQuota } from "./codex-selection-quota"

const window = (used = 20, seconds = 18000) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: (Date.now() + 3600000) / 1000 })
test("activation evidence validates every declared quota window before display normalization", () => {
  const primary = window()
  for (const secondary of [window(-1, 604800), window(101, 604800), { ...window(20, 604800), used_percent: "invalid" },
    { ...window(20, 604800), reset_at: 1 }, { ...window(20, 604800), reset_at: null },
    { ...window(20, 604800), limit_window_seconds: 0 }, window(20), "unknown"]) {
    assert.throws(() => parseCodexSelectionQuota({ rate_limit: { primary_window: primary, secondary_window: secondary } }), /Quota unavailable/)
  }
  for (const rate of [{}, { primary_window: primary, allowed: false }, { primary_window: primary, limit_reached: true },
    { primary_window: primary, allowed: "true" }]) {
    assert.throws(() => parseCodexSelectionQuota({ rate_limit: rate }), /Quota unavailable/)
  }
  const usage = parseCodexSelectionQuota({ rate_limit: { primary_window: primary, secondary_window: window(100, 604800) } })
  assert.equal(usage.windows.weekly.usedPercent, 100)
  assert.equal(usage.windows["5h"].usedPercent, 20)
})
