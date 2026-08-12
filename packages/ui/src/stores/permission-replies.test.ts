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

    assert.equal(hasRepliedPermission(instanceId, permissionId, 1_100), true)
    clearRepliedPermissions(instanceId)
  })

  it("keeps replied ids while the server still reports them pending", () => {
    const instanceId = "instance-still-pending"
    const permissionId = "permission-1"

    markPermissionReplied(instanceId, permissionId, 1_000)
    pruneRepliedPermissions(instanceId, new Set([permissionId]), 1_100)

    assert.equal(hasRepliedPermission(instanceId, permissionId, 1_100), true)
    clearRepliedPermissions(instanceId)
  })

  it("clears replied ids only after two newer syncs observe them missing", () => {
    const instanceId = "instance-new-sync"
    const permissionId = "permission-1"

    markPermissionReplied(instanceId, permissionId, 1_000)
    pruneRepliedPermissions(instanceId, new Set(), 1_100)
    assert.equal(hasRepliedPermission(instanceId, permissionId, 1_100), true)
    pruneRepliedPermissions(instanceId, new Set(), 1_200)

    assert.equal(hasRepliedPermission(instanceId, permissionId, 1_200), false)
    clearRepliedPermissions(instanceId)
  })

  it("expires and caps replied ids", () => {
    const instanceId = "instance-bounded"
    markPermissionReplied(instanceId, "expired", 1_000)
    assert.equal(hasRepliedPermission(instanceId, "expired", Number.MAX_SAFE_INTEGER), false)

    for (let index = 0; index <= 4_096; index += 1) {
      markPermissionReplied(instanceId, `permission-${index}`, 10_000 + index)
    }
    assert.equal(hasRepliedPermission(instanceId, "permission-0", 20_000), false)
    assert.equal(hasRepliedPermission(instanceId, "permission-4096", 20_000), true)
    clearRepliedPermissions(instanceId)
  })
})
