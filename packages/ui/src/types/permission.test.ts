import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { mergePermissionRequest, type PermissionRequestLike } from "./permission.ts"

describe("mergePermissionRequest", () => {
  it("preserves known routing metadata when duplicate payloads are sparse", () => {
    const previous: PermissionRequestLike = {
      id: "permission-1",
      sessionID: "session-1",
      messageID: "message-1",
      callID: "call-1",
      metadata: {
        callID: "metadata-call-1",
        messageID: "metadata-message-1",
      },
      tool: {
        callID: "tool-call-1",
        messageID: "tool-message-1",
      },
      time: { created: 1_000 },
    }

    const next: PermissionRequestLike = {
      id: "permission-1",
      sessionID: undefined,
      messageID: undefined,
      callID: undefined,
      metadata: {
        callID: undefined,
      },
      tool: {
        callID: undefined,
      },
      time: { created: undefined },
    } as PermissionRequestLike

    const merged = mergePermissionRequest(previous, next)

    assert.equal(merged.sessionID, "session-1")
    assert.equal(merged.messageID, "message-1")
    assert.equal(merged.callID, "call-1")
    assert.equal(merged.metadata?.callID, "metadata-call-1")
    assert.equal(merged.metadata?.messageID, "metadata-message-1")
    assert.equal(merged.tool?.callID, "tool-call-1")
    assert.equal(merged.tool?.messageID, "tool-message-1")
    assert.equal(merged.time?.created, 1_000)
  })
})
