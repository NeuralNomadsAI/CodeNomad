import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolvePermissionAutoAcceptFamilyRoot } from "./permission-auto-accept.ts"

describe("resolvePermissionAutoAcceptFamilyRoot", () => {
  it("keeps a loaded child as root when its parent is missing", () => {
    const root = resolvePermissionAutoAcceptFamilyRoot("child", (sessionId) => {
      if (sessionId === "child") return { id: "child", parentId: "parent" }
      return undefined
    })

    assert.equal(root, "child")
  })

  it("resolves to the master session when the full parent chain is loaded", () => {
    const root = resolvePermissionAutoAcceptFamilyRoot("grandchild", (sessionId) => {
      if (sessionId === "grandchild") return { id: "grandchild", parentId: "child" }
      if (sessionId === "child") return { id: "child", parentId: "master" }
      if (sessionId === "master") return { id: "master", parentId: null }
      return undefined
    })

    assert.equal(root, "master")
  })

  it("keeps a fork session as its own root", () => {
    const root = resolvePermissionAutoAcceptFamilyRoot("fork", (sessionId) => {
      if (sessionId === "fork") return { id: "fork", parentId: "master", revert: { messageID: "msg", partID: "part" } }
      if (sessionId === "master") return { id: "master", parentId: null }
      return undefined
    })

    assert.equal(root, "fork")
  })
})
