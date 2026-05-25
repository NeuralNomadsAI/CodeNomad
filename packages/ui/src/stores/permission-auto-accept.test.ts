import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { shouldSubagentInheritPermissionAutoAcceptValue } from "./permission-auto-accept-rules.ts"
import type { Session } from "../types/session.ts"
import * as store from "./permission-auto-accept.ts"

describe("subagent YOLO inheritance", () => {
  it("inherits only for non-fork child sessions when parent YOLO is enabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        true,
      ),
      true,
    )
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: { messageID: "msg", partID: "part" } },
        true,
      ),
      false,
    )
  })

  it("does not inherit when parent YOLO is disabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        false,
      ),
      false,
    )
  })

})

describe("permission auto-accept store", () => {
  it("live-updates inherited child YOLO from parent state", () => {
      const instanceId = "inheritance-instance"
      const parentId = "master-session"
      const childId = "child-session"
      const siblingId = "sibling-session"
      const sessions: Array<Pick<Session, "id" | "parentId" | "revert">> = [
        { id: parentId, parentId: null, revert: undefined },
        { id: childId, parentId, revert: undefined },
        { id: siblingId, parentId, revert: undefined },
      ]
      const drained: string[] = []
      const syncChildren = () =>
        store.syncInheritedPermissionAutoAcceptForChildren(instanceId, parentId, sessions, (_instanceId, sessionId) => {
          drained.push(sessionId)
        })

      store.setPermissionAutoAcceptEnabled(instanceId, parentId, true)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), true)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), true)
      assert.deepEqual(drained, [childId, siblingId])

      store.setPermissionAutoAcceptEnabled(instanceId, childId, false)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, parentId), true)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), false)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), true)

      store.setPermissionAutoAcceptEnabled(instanceId, parentId, false)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), false)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), false)

      store.setPermissionAutoAcceptEnabled(instanceId, parentId, true)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), true)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), true)
  })
})
