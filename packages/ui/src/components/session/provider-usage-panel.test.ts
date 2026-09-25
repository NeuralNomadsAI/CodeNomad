import assert from "node:assert/strict"
import { test } from "node:test"
import { shouldShowProviderUsageWindow } from "./provider-usage-panel"

test("supplemental provider credit balances are opt-in", () => {
  assert.equal(shouldShowProviderUsageWindow("credits_balance", false), false)
  assert.equal(shouldShowProviderUsageWindow("credits_balance", true), true)
  assert.equal(shouldShowProviderUsageWindow("credits", false), true)
  assert.equal(shouldShowProviderUsageWindow("weekly", false), true)
})
