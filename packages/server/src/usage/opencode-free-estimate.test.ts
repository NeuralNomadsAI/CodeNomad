import assert from "node:assert/strict"
import { test } from "node:test"
import { OPENCODE_FREE_DAILY_REQUESTS, isOpenCodeFreeModel } from "./opencode-free-estimate"

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
