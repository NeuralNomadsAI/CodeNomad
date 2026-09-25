import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseReasoningSummary } from "./reasoning-summary.ts"

describe("parseReasoningSummary", () => {
  it("separates a canonical title from its detail without changing plain reasoning", () => {
    assert.deepEqual(parseReasoningSummary("**Inspecting stability**\n\nChecking the timeline."), {
      title: "Inspecting stability",
      body: "Checking the timeline.",
    })
    assert.deepEqual(parseReasoningSummary("**Still thinking**"), { title: "Still thinking", body: "" })
    assert.deepEqual(parseReasoningSummary("Plain reasoning"), { title: null, body: "Plain reasoning" })
  })
})
