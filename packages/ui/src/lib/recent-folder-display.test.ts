import { test } from "node:test"
import assert from "node:assert/strict"
import { filterRecents } from "./recent-folder-display"

test("quick recents search project name, full path and server name", () => {
  const local = { path: "D:/work/shared", projectName: "Local checkout" }
  const remote = { path: "/srv/shared", projectName: "Remote checkout", serverLabel: "Alpha server" }
  const recents = [local, remote]
  assert.strictEqual(filterRecents(recents, " "), recents)
  assert.deepEqual(filterRecents(recents, "ALPHA"), [remote])
  assert.deepEqual(filterRecents(recents, "Checkout"), recents)
  assert.deepEqual(filterRecents(recents, " /srv "), [remote])
  assert.deepEqual(filterRecents(recents, "unknown"), [])
})
