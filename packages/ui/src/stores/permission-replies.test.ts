import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  clearRepliedPermissions,
  hasRepliedPermission,
  markPermissionReplied,
  pruneRepliedPermissions,
} from "./permission-replies.ts"

describe("replied permission tracking", () => {
  it("keeps replied ids when an older sync does not include them", () => {
    const instanceId = "instance-old-sync"
    const permissionId = "permission-1"

    markPermissionReplied(instanceId, permissionId, 1_000)
    pruneRepliedPermissions(instanceId, new Set(), 900)

    assert.equal(hasRepliedPermission(instanceId, permissionId), true)
    clearRepliedPermissions(instanceId)
  })

  it("keeps replied ids while the server still reports them pending", () => {
    const instanceId = "instance-still-pending"
    const permissionId = "permission-1"

    markPermissionReplied(instanceId, permissionId, 1_000)
    pruneRepliedPermissions(instanceId, new Set([permissionId]), 1_100)

    assert.equal(hasRepliedPermission(instanceId, permissionId), true)
    clearRepliedPermissions(instanceId)
  })

  it("clears replied ids once a newer sync observes them missing", () => {
    const instanceId = "instance-new-sync"
    const permissionId = "permission-1"

    markPermissionReplied(instanceId, permissionId, 1_000)
    pruneRepliedPermissions(instanceId, new Set(), 1_100)

    assert.equal(hasRepliedPermission(instanceId, permissionId), false)
    clearRepliedPermissions(instanceId)
  })
})
