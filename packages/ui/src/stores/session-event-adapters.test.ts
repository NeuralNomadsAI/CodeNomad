import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { adoptSubagentPermissionAutoAcceptAndDrain, createSessionFromSessionUpdateInfo } from "./session-event-adapters.ts"
import { drainAutoAcceptPermissions, setPermissionAutoAcceptEnabled } from "./permission-auto-accept.ts"
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
    assert.equal(shouldSubagentInheritPermissionAutoAcceptValue(session, true), false)
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
    assert.equal(shouldSubagentInheritPermissionAutoAcceptValue(session, true), true)
  })

  it("drains queued session permissions after inherited YOLO adoption", () => {
    const drained: Array<{ instanceId: string; sessionId: string }> = []
    const adopted = adoptSubagentPermissionAutoAcceptAndDrain(
      "instance",
      { id: "child", parentId: "parent", revert: undefined },
      () => true,
      (instanceId, sessionId) => drained.push({ instanceId, sessionId }),
    )

    assert.equal(adopted, true)
    assert.deepEqual(drained, [{ instanceId: "instance", sessionId: "child" }])
  })

  it("does not drain queued permissions when inherited YOLO is not adopted", () => {
    const drained: Array<{ instanceId: string; sessionId: string }> = []
    const adopted = adoptSubagentPermissionAutoAcceptAndDrain(
      "instance",
      { id: "child", parentId: "parent", revert: undefined },
      () => false,
      (instanceId, sessionId) => drained.push({ instanceId, sessionId }),
    )

    assert.equal(adopted, false)
    assert.deepEqual(drained, [])
  })

  it("drains already queued child permissions after inherited YOLO is adopted", () => {
    const instanceId = "queued-adoption-instance"
    const parentSessionId = "parent-session"
    const childSessionId = "child-session"
    const replies: Array<{ sessionId: string; requestId: string; reply: string }> = []
    const queuedPermissions = [
      { id: "parent-permission", sessionID: parentSessionId },
      { id: "child-permission", sessionID: childSessionId },
    ]

    setPermissionAutoAcceptEnabled(instanceId, parentSessionId, true)

    const adopted = adoptSubagentPermissionAutoAcceptAndDrain(
      instanceId,
      { id: childSessionId, parentId: parentSessionId, revert: undefined },
      (_instanceId, session) => {
        setPermissionAutoAcceptEnabled(_instanceId, session.id, true)
        return true
      },
      (_instanceId, sessionId) => {
        const sessionPermissions = queuedPermissions.filter((permission) => permission.sessionID === sessionId)
        drainAutoAcceptPermissions(
          _instanceId,
          sessionPermissions,
          async (_replyInstanceId, replySessionId, requestId, reply) => {
            replies.push({ sessionId: replySessionId, requestId, reply })
          },
          (_pendingInstanceId, requestId) => queuedPermissions.some((permission) => permission.id === requestId),
        )
      },
    )

    assert.equal(adopted, true)
    assert.deepEqual(replies, [{ sessionId: childSessionId, requestId: "child-permission", reply: "once" }])
  })
})
