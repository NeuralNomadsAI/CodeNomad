import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { explicitToolReference, resolveFormToolTarget } from "./form-request-tool-target.ts"

describe("form request tool target", () => {
  it("retains the source reference outside the resident transcript window", () => {
    const form = {
      id: "form-question", sessionID: "other", title: "Questions", fields: [],
      metadata: { tool: { messageID: "message-1", id: "call-1" } },
    } as any

    const missing = { getSessionMessageIds: () => [], getMessage: () => undefined }
    const resolved = {
      getSessionMessageIds: () => ["message-1"],
      getMessage: () => ({ partIds: ["call-1"], parts: { "call-1": { data: { id: "call-1", type: "tool" } } } }),
    }

    assert.deepEqual(explicitToolReference(form), { messageId: "message-1", callId: "call-1" })
    assert.equal(resolveFormToolTarget(form, missing), null)
    assert.deepEqual(resolveFormToolTarget(form, resolved), { messageId: "message-1", partId: "call-1" })
    assert.equal(resolveFormToolTarget({ ...form, metadata: undefined }, missing), null)
  })
})
