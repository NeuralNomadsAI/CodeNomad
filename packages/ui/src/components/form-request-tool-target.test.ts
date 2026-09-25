import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { shouldRenderFormInFallback } from "./form-request-tool-target.ts"

describe("form request tool target", () => {
  it("uses the fallback until an inline tool target exists", () => {
    const form = {
      id: "form-question", sessionID: "other", title: "Questions", fields: [],
      metadata: { tool: { messageID: "message-1", id: "call-1" } },
    } as any

    const missing = { getSessionMessageIds: () => [], getMessage: () => undefined }
    const resolved = {
      getSessionMessageIds: () => ["message-1"],
      getMessage: () => ({ partIds: ["call-1"], parts: { "call-1": { data: { id: "call-1", type: "tool" } } } }),
    }

    assert.equal(shouldRenderFormInFallback(form, "current", missing), true)
    assert.equal(shouldRenderFormInFallback(form, "other", missing), true)
    assert.equal(shouldRenderFormInFallback(form, "other", resolved), false)
    assert.equal(shouldRenderFormInFallback({ ...form, metadata: undefined }, "other", missing), true)
  })
})
