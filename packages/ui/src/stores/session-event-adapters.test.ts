import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createSessionFromSessionUpdateInfo } from "./session-event-adapters.ts"
import { shouldSubagentInheritPermissionAutoAcceptValue } from "./permission-auto-accept-rules.ts"

describe("session.updated YOLO inheritance adapter", () => {
  it("preserves revert metadata before checking subagent inheritance", () => {
    const session = createSessionFromSessionUpdateInfo(
      "instance",
      {
        id: "child",
        title: "Forked child",
        parentID: "parent",
        version: "1",
        time: { created: 1, updated: 2 },
        revert: { messageID: "msg", partID: "part" },
      },
      "Untitled",
    )

    assert.deepEqual(session.revert, { messageID: "msg", partID: "part", snapshot: undefined, diff: undefined })
    assert.equal(shouldSubagentInheritPermissionAutoAcceptValue(session, true, true), false)
  })

  it("still allows non-revert child sessions to inherit when the policy allows it", () => {
    const session = createSessionFromSessionUpdateInfo(
      "instance",
      {
        id: "child",
        title: "Subagent child",
        parentID: "parent",
        version: "1",
        time: { created: 1, updated: 2 },
      },
      "Untitled",
    )

    assert.equal(session.revert, undefined)
    assert.equal(shouldSubagentInheritPermissionAutoAcceptValue(session, true, true), true)
  })
})
