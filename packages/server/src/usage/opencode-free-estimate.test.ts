import assert from "node:assert/strict"
import { test } from "node:test"
import { OPENCODE_FREE_DAILY_REQUESTS, isOpenCodeFreeModel, openCodeFreeWindow } from "./opencode-free-estimate"

test("only OpenCode Console free models use the 800-request reference", () => {
  assert.equal(OPENCODE_FREE_DAILY_REQUESTS, 800)
  assert.equal(isOpenCodeFreeModel("opencode", "big-pickle"), true)
  assert.equal(isOpenCodeFreeModel("opencode", "deepseek-v4-flash-free"), true)
  assert.equal(isOpenCodeFreeModel("opencode", "claude-sonnet-4"), false)
  assert.equal(isOpenCodeFreeModel("openrouter", "some-model-free"), false)
  assert.equal(isOpenCodeFreeModel("opencode", undefined), false)
  assert.equal(isOpenCodeFreeModel(" OPENCODE ", " Example-FREE "), true)
  assert.equal(isOpenCodeFreeModel("opencode-go", "example-free"), false)
})

test("Console's calendar day begins at 00:00 UTC and resets at the next UTC midnight", () => {
  const now = Date.UTC(2026, 10, 3, 21, 30)
  const window = openCodeFreeWindow(now)
  assert.deepEqual(window, { from: Date.UTC(2026, 10, 3), to: now, resetAt: Date.UTC(2026, 10, 4) })
  assert.equal(openCodeFreeWindow(Date.UTC(2026, 10, 3)).to, Date.UTC(2026, 10, 3), "midnight has no elapsed activity")
})
