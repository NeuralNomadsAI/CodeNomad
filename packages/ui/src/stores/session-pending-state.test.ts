import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPendingState } from "./session-pending-state.ts"

describe("applySessionPendingState", () => {
  it("reconciles interruptions that arrived before sessions", () => {
    const sessions = new Map([
      ["permission", { id: "permission" }],
      ["form", { id: "form" }],
      ["idle", { id: "idle", pendingPermission: true }],
    ])

    const result = applySessionPendingState(sessions, new Set(["permission"]), new Set(["form"]))

    assert.deepEqual(result.get("permission"), {
      id: "permission",
      pendingPermission: true,
      pendingForm: false,
    })
    assert.deepEqual(result.get("form"), {
      id: "form",
      pendingPermission: false,
      pendingForm: true,
    })
    assert.deepEqual(result.get("idle"), {
      id: "idle",
      pendingPermission: false,
      pendingForm: false,
    })
  })

  it("preserves the map when pending state already matches", () => {
    const sessions = new Map([
      ["session", { id: "session", pendingPermission: true, pendingForm: false }],
    ])

    assert.equal(applySessionPendingState(sessions, new Set(["session"]), new Set()), sessions)
  })
})
