import assert from "node:assert/strict"
import test from "node:test"

import { canHydrateMessages } from "./message-hydration-authority.ts"

test("rejects HTTP hydration after a newer message revision", () => {
  assert.equal(canHydrateMessages(4, 5), false)
  assert.equal(canHydrateMessages(5, 5), true)
})
