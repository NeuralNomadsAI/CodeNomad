import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { AutoAcceptStore, resolveFamilyRoot } from "./auto-accept-store"

describe("resolveFamilyRoot", () => {
  it("returns the session id itself when no info is known", () => {
    assert.equal(resolveFamilyRoot("orphan", () => undefined), "orphan")
  })

  it("keeps a loaded child as root when its parent is missing", () => {
    const root = resolveFamilyRoot("child", (id) =>
      id === "child" ? { id: "child", parentId: "parent" } : undefined,
    )
    assert.equal(root, "child")
  })

  it("resolves to the master session when the full parent chain is loaded", () => {
    const root = resolveFamilyRoot("grandchild", (id) => {
      if (id === "grandchild") return { id: "grandchild", parentId: "child" }
      if (id === "child") return { id: "child", parentId: "master" }
      if (id === "master") return { id: "master", parentId: null }
      return undefined
    })
    assert.equal(root, "master")
  })

  it("keeps a session with native fork metadata as its own root", () => {
    const root = resolveFamilyRoot("fork", (id) => {
      if (id === "fork")
        return { id: "fork", parentId: "master", fork: { sessionID: "master", boundary: { type: "through", messageID: "msg" } } }
      if (id === "master") return { id: "master", parentId: null }
      return undefined
    })
    assert.equal(root, "fork")
  })

  it("terminates on cyclic parent chains without looping forever", () => {
    const root = resolveFamilyRoot("a", (id) => {
      if (id === "a") return { id: "a", parentId: "b" }
      if (id === "b") return { id: "b", parentId: "a" }
      return undefined
    })
    // cycle: last known id before re-entering the cycle is returned
    assert.ok(root === "a" || root === "b")
  })
})

describe("AutoAcceptStore inheritance", () => {
  it("is disabled by default for an unknown session", () => {
    const store = new AutoAcceptStore()
    assert.equal(store.isEnabled("inst", "s1"), false)
  })

  it("enabling a parent enables every descendant that resolves to it", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.upsertSession("inst", { id: "child", parentId: "master" })
    store.upsertSession("inst", { id: "grandchild", parentId: "child" })

    store.setEnabled("inst", "master", true)

    assert.equal(store.isEnabled("inst", "master"), true)
    assert.equal(store.isEnabled("inst", "child"), true)
    assert.equal(store.isEnabled("inst", "grandchild"), true)
  })

  it("enabling a child also covers the parent family root and siblings", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.upsertSession("inst", { id: "child-a", parentId: "master" })
    store.upsertSession("inst", { id: "child-b", parentId: "master" })

    store.setEnabled("inst", "child-a", true)

    assert.equal(store.isEnabled("inst", "child-a"), true)
    assert.equal(store.isEnabled("inst", "child-b"), true)
    assert.equal(store.isEnabled("inst", "master"), true)
  })

  it("a fork session is isolated: enabling it does not enable its parent", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.upsertSession("inst", {
      id: "fork",
      parentId: "master",
      fork: { sessionID: "master", boundary: { type: "through", messageID: "msg" } },
    })

    store.setEnabled("inst", "fork", true)

    assert.equal(store.isEnabled("inst", "fork"), true)
    assert.equal(store.isEnabled("inst", "master"), false)
  })

  it("disabling the family root clears the setting for all descendants", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.upsertSession("inst", { id: "child", parentId: "master" })

    store.setEnabled("inst", "child", true)
    assert.equal(store.isEnabled("inst", "child"), true)

    store.setEnabled("inst", "master", false)
    assert.equal(store.isEnabled("inst", "child"), false)
    assert.equal(store.isEnabled("inst", "master"), false)
  })

  it("toggle flips the resolved family-root state and reports the new value", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.upsertSession("inst", { id: "child", parentId: "master" })

    assert.equal(store.toggle("inst", "child"), true)
    assert.equal(store.isEnabled("inst", "child"), true)
    assert.equal(store.toggle("inst", "master"), false)
    assert.equal(store.isEnabled("inst", "child"), false)
  })

  it("keeps per-instance state independent", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst-a", { id: "root", parentId: null })
    store.upsertSession("inst-b", { id: "root", parentId: null })

    store.setEnabled("inst-a", "root", true)
    assert.equal(store.isEnabled("inst-a", "root"), true)
    assert.equal(store.isEnabled("inst-b", "root"), false)
  })
})

describe("AutoAcceptStore session tree maintenance", () => {
  it("migrates enabled root when a parent is discovered later", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "child", parentId: "parent" })
    // parent unknown -> child is its own root
    store.setEnabled("inst", "child", true)

    // later the parent shows up — root should migrate from "child" to "parent"
    store.upsertSession("inst", { id: "parent", parentId: null })
    assert.equal(store.isEnabled("inst", "parent"), true)
    assert.equal(store.isEnabled("inst", "child"), true)
  })

  it("removing a session does not clear an enabled family root", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.setEnabled("inst", "master", true)
    store.removeSession("inst", "master")
    // the toggle is independent of the session tree: it survives session deletion
    assert.equal(store.isEnabled("inst", "master"), true)
  })

  it("clearInstance drops both tree and enabled state", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.setEnabled("inst", "master", true)
    store.clearInstance("inst")
    assert.equal(store.isEnabled("inst", "master"), false)
    store.upsertSession("inst", { id: "master", parentId: null })
    assert.equal(store.isEnabled("inst", "master"), false)
  })

  it("discovering native fork metadata re-roots the session", () => {
    const store = new AutoAcceptStore()
    store.upsertSession("inst", { id: "master", parentId: null })
    store.upsertSession("inst", { id: "child", parentId: "master" })
    store.setEnabled("inst", "child", true)
    // parent family enabled
    assert.equal(store.isEnabled("inst", "master"), true)

    // The exact session.forked event adds the native fork marker.
    store.upsertSession("inst", {
      id: "child",
      parentId: "master",
      fork: { sessionID: "master", boundary: { type: "before", messageID: "m" } },
    })
    // now child resolves to itself; the family setting was on "master" so still on for master
    assert.equal(store.isEnabled("inst", "master"), true)
    // child is its own root now, not enabled unless toggled
    assert.equal(store.isEnabled("inst", "child"), false)
  })
})
