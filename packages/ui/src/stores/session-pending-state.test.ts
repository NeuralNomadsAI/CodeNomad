import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applySessionPendingState } from "./session-pending-state.ts"

describe("applySessionPendingState", () => {
  it("reconciles interruptions that arrived before sessions", () => {
    const sessions = new Map([
      ["permission", { id: "permission" }],
      ["question", { id: "question" }],
      ["form", { id: "form" }],
      ["idle", { id: "idle", pendingPermission: true }],
    ])

    const result = applySessionPendingState(sessions, new Set(["permission"]), new Set(["question"]), new Set(["form"]))

    assert.deepEqual(result.get("permission"), {
      id: "permission",
      pendingPermission: true,
      pendingQuestion: false,
      pendingForm: false,
    })
    assert.deepEqual(result.get("question"), {
      id: "question",
      pendingPermission: false,
      pendingQuestion: true,
      pendingForm: false,
    })
    assert.deepEqual(result.get("form"), {
      id: "form",
      pendingPermission: false,
      pendingQuestion: false,
      pendingForm: true,
    })
    assert.deepEqual(result.get("idle"), {
      id: "idle",
      pendingPermission: false,
      pendingQuestion: false,
      pendingForm: false,
    })
  })

  it("preserves the map when pending state already matches", () => {
    const sessions = new Map([
      ["session", { id: "session", pendingPermission: true, pendingQuestion: false, pendingForm: false }],
    ])

    assert.equal(applySessionPendingState(sessions, new Set(["session"]), new Set(), new Set()), sessions)
  })
})
