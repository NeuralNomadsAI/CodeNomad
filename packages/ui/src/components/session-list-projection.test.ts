import assert from "node:assert/strict"
import test from "node:test"
import type { SessionThread } from "../stores/session-state"
import {
  filterSessionThreads,
  getSessionDeletionFallback,
  getSessionListProjectionIds,
  registerSessionListProjection,
} from "./session-list-projection"

const thread = (id: string, title: string, children: SessionThread[] = []): SessionThread => ({
  session: { id, title } as SessionThread["session"],
  children,
  depth: 0,
  hasChildren: children.length > 0,
  latestUpdated: 0,
})

test("projection remains available independently of the sidebar", () => {
  const unregister = registerSessionListProjection("instance", () => ["filtered"])
  assert.deepEqual(getSessionListProjectionIds("instance", () => ["fallback"]), ["filtered"])
  unregister()
  assert.deepEqual(getSessionListProjectionIds("instance", () => ["fallback"]), ["fallback"])
})

test("filter preserves matching ancestry and deletion fallback follows projected order", () => {
  const projected = filterSessionThreads(
    [thread("root", "Root", [thread("child", "Needle")]), thread("hidden", "Other")],
    "needle",
    (item) => item.session.title.toLowerCase(),
  )
  assert.deepEqual(projected.map((item) => [item.session.id, item.children.map((child) => child.session.id)]), [["root", ["child"]]])
  assert.equal(getSessionDeletionFallback(["root", "child", "next"], "child", new Set(["child"])), "next")
})
