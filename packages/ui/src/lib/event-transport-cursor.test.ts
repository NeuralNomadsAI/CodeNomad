import assert from "node:assert/strict"
import { test } from "node:test"

import { acquireEventTransportCursorAuthority } from "./event-transport-cursor.ts"

test("only the current transport generation can advance the shared cursor", () => {
  const stale = acquireEventTransportCursorAuthority()
  assert.equal(stale.commit("epoch-a:1"), true)
  const current = acquireEventTransportCursorAuthority()

  assert.equal(stale.commit("epoch-a:3"), false)
  assert.equal(current.read(), "epoch-a:1")
  assert.equal(current.commit("epoch-a:2"), true)
  assert.equal(current.read(), "epoch-a:2")
})
