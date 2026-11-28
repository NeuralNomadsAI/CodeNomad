import assert from "node:assert/strict"
import { test } from "node:test"
import { BrowserPreviewOwners } from "./browser-preview-owners"

test("concurrent opens are decided in arrival order without waiting for a guest", async () => {
  const owners = new BrowserPreviewOwners<string>()
  const [first, duplicate, otherWindow] = await Promise.all([
    Promise.resolve().then(() => owners.request("session", "window", "first")),
    Promise.resolve().then(() => owners.request("session", "window", "duplicate")),
    Promise.resolve().then(() => owners.request("session", "other-window", "same-id")),
  ])
  assert.equal(first.owner.instanceId, "first")
  assert.equal(duplicate.owner, first.owner)
  assert.equal(otherWindow.owner, first.owner)
})

test("only an explicit same-window transfer of the observed owner wins", () => {
  const owners = new BrowserPreviewOwners<string>()
  const { owner } = owners.request("session", "window", "first")
  assert.equal(owners.request("session", "other-window", "second", owner.revision).owner, owner)
  const moved = owners.request("session", "window", "second", owner.revision)
  assert.equal(moved.previous, owner)
  assert.equal(moved.owner.instanceId, "second")
  assert.equal(owners.request("session", "window", "first", owner.revision).owner, moved.owner)
  assert.deepEqual(owners.release("window", "first"), [])
  assert.equal(owners.release("window", "second")[0].owner, moved.owner)
  assert.equal(owners.request("session", "window", "first").owner.instanceId, "first")
})
