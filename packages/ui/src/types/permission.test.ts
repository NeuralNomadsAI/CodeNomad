import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { mergePermissionRequest, type PermissionRequest } from "./permission.ts"

describe("mergePermissionRequest", () => {
  it("preserves v2 source metadata when duplicate payload omits it", () => {
    const previous: PermissionRequest = {
      id: "permission-1",
      sessionID: "session-1",
      action: "edit",
      resources: ["file-a.ts"],
      metadata: {
        path: "file-a.ts",
      },
      source: {
        type: "tool",
        callID: "call-1",
        messageID: "tool-message-1",
      },
    }

    const next: PermissionRequest = {
      id: "permission-1",
      sessionID: "session-1",
      action: "edit",
      resources: ["file-b.ts"],
      metadata: {
        diff: "diff --git a/file-b.ts b/file-b.ts",
      },
    }

    const merged = mergePermissionRequest(previous, next)

    assert.equal(merged.sessionID, "session-1")
    assert.deepEqual(merged.resources, ["file-b.ts"])
    assert.equal(merged.metadata?.path, "file-a.ts")
    assert.equal(merged.metadata?.diff, "diff --git a/file-b.ts b/file-b.ts")
    assert.equal(merged.source?.callID, "call-1")
    assert.equal(merged.source?.messageID, "tool-message-1")
  })
})
