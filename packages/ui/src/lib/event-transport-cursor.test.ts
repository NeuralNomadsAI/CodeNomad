import assert from "node:assert/strict"
import { test } from "node:test"

import { acquireEventTransportCursorAuthority } from "./event-transport-cursor.ts"

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

test("only the current transport generation can advance the shared cursor", () => {
  const stale = acquireEventTransportCursorAuthority()
  assert.equal(stale.commit("epoch-a:1"), true)
  const current = acquireEventTransportCursorAuthority()

  assert.equal(stale.commit("epoch-a:3"), false)
  assert.equal(current.read(), "epoch-a:1")
  assert.equal(current.commit("epoch-a:2"), true)
  assert.equal(current.read(), "epoch-a:2")
})

test("reloads the opaque cursor from storage for the same server scope", () => {
  const storage = memoryStorage()
  const firstRenderer = acquireEventTransportCursorAuthority("https://one.example", storage)
  assert.equal(firstRenderer.commit("opaque epoch:7/value"), true)

  acquireEventTransportCursorAuthority("https://other.example", storage)
  const reloadedRenderer = acquireEventTransportCursorAuthority("https://one.example", storage)
  assert.equal(reloadedRenderer.read(), "opaque epoch:7/value")

  assert.equal(reloadedRenderer.commit(), true)
  acquireEventTransportCursorAuthority("https://other.example", storage)
  assert.equal(acquireEventTransportCursorAuthority("https://one.example", storage).read(), undefined)
})

test("keeps an in-memory cursor when browser storage is unavailable", () => {
  const unavailable = {
    getItem() { throw new Error("blocked") },
    setItem() { throw new Error("blocked") },
    removeItem() { throw new Error("blocked") },
  }
  const authority = acquireEventTransportCursorAuthority("https://blocked.example", unavailable)

  assert.equal(authority.read(), undefined)
  assert.equal(authority.commit("opaque-cursor"), true)
  assert.equal(authority.read(), "opaque-cursor")
})
