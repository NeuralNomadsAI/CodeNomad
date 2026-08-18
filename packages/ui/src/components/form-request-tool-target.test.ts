import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { shouldRenderFormInFallback } from "./form-request-tool-target.ts"

describe("form request tool target", () => {
  it("keeps an inline form out of the fallback while its tool call is still arriving", () => {
    const form = {
      id: "form-question", sessionID: "other", title: "Questions", fields: [],
      metadata: { tool: { messageID: "message-1", id: "call-1" } },
    } as any

    assert.equal(shouldRenderFormInFallback(form, "current"), true)
    assert.equal(shouldRenderFormInFallback(form, "other"), false)
    assert.equal(shouldRenderFormInFallback({ ...form, metadata: undefined }, "other"), true)
  })
})
