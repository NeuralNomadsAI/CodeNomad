import assert from "node:assert/strict"
import test from "node:test"
import { BrowserGuestLifetime } from "./browser-guest-lifetime"

function fixture() {
  const lifetime = new BrowserGuestLifetime()
  const closed: string[] = []
  const guest = (name: string) => ({ isDestroyed: () => false, close: (options: unknown) => {
    assert.deepEqual(options, { waitForBeforeUnload: false })
    assert.equal(lifetime.owner(root as never), undefined)
    assert.equal(lifetime.owner(child as never), undefined)
    closed.push(name)
  } })
  const owner = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  const root = guest("root"), child = guest("child"), grandchild = guest("grandchild")
  lifetime.register(owner as never, root as never)
  lifetime.register(owner as never, child as never, root as never)
  lifetime.register(owner as never, grandchild as never, child as never)
  return { lifetime, closed, owner, root, child, grandchild }
}

test("owner cleanup atomically invalidates nested previews before forced destruction and isolates peers", () => {
  const f = fixture()
  const peerOwner = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  const peer = { isDestroyed: () => false }
  f.lifetime.register(peerOwner as never, peer as never)
  f.lifetime.removeOwner(f.owner as never)
  assert.deepEqual(new Set(f.closed), new Set(["root", "child", "grandchild"]))
  assert.equal(f.lifetime.owner(peer as never), peerOwner)
  f.lifetime.removeOwner(f.owner as never)
  assert.equal(f.closed.length, 3)
  assert.throws(() => f.lifetime.register(f.owner as never, {} as never, f.root as never), /Expired/)
})

test("document replacement rotates the callback fence and destroys every descendant", () => {
  const f = fixture()
  // Destruction callbacks see the retained root, but all descendants are absent.
  const popup = { isDestroyed: () => false, destroy: () => {
    assert.equal(f.lifetime.owner(f.child as never), undefined)
    assert.equal(f.lifetime.owner(f.grandchild as never), undefined)
  } }
  f.lifetime.register(f.owner as never, f.child as never, f.root as never, popup as never)
  f.lifetime.register(f.owner as never, f.grandchild as never, f.child as never, popup as never)
  const before = f.lifetime.revision(f.root as never)
  f.lifetime.replaceDocument(f.root as never)
  assert.notEqual(f.lifetime.revision(f.root as never), before)
  assert.equal(f.lifetime.owner(f.root as never), f.owner)
  const other = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  assert.throws(() => f.lifetime.register(other as never, {} as never, f.root as never), /Expired/)
})
