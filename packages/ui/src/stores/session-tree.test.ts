import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Session } from "../types/session"
import {
  buildSessionThreadsFromMap,
  collectSessionThreadIds,
  collectVisibleSessionIds,
  findSessionThread,
  getDescendantSessionsFromMap,
  getSessionAncestorIdsFromMap,
  getSessionRootFromMap,
  sortSessionIdsDeepestFirst,
} from "./session-tree"

function session(id: string, parentId: string | null, updated: number): Session {
  return { id, parentId, time: { created: updated, updated } } as Session
}

function sessionMap(definitions: Array<[string, string | null, number]>): Map<string, Session> {
  return new Map(definitions.map(([id, parentId, updated]) => [id, session(id, parentId, updated)]))
}

describe("session tree", () => {
  it("preserves nesting and sorts siblings by descendant activity", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["older-branch", "root", 200],
      ["newer-branch", "root", 300],
      ["deep-active", "older-branch", 500],
    ])

    const [root] = buildSessionThreadsFromMap(sessions, ["root"])
    assert.equal(root.latestUpdated, 500)
    assert.deepEqual(root.children.map((child) => child.session.id), ["older-branch", "newer-branch"])
    assert.equal(root.children[0].children[0].session.id, "deep-active")
    assert.equal(root.children[0].children[0].depth, 2)
  })

  it("includes the complete ancestor path for filtered descendants", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
      ["grandchild", "child", 300],
      ["sibling", "root", 400],
    ])

    const [root] = buildSessionThreadsFromMap(sessions, ["root"], new Set(["grandchild"]))
    assert.deepEqual(root.children.map((child) => child.session.id), ["child"])
    assert.deepEqual(root.children[0].children.map((child) => child.session.id), ["grandchild"])
    assert.equal(buildSessionThreadsFromMap(sessions, ["root", "root"]).length, 1)
  })

  it("only exposes descendants whose full parent path is expanded", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
      ["grandchild", "child", 300],
    ])
    const threads = buildSessionThreadsFromMap(sessions, ["root"])

    assert.deepEqual(collectVisibleSessionIds(threads, undefined), ["root"])
    assert.deepEqual(collectVisibleSessionIds(threads, new Set(["root"])), ["root", "child"])
    assert.deepEqual(collectVisibleSessionIds(threads, new Set(["root", "child"])), ["root", "child", "grandchild"])
  })

  it("resolves roots and ancestors across arbitrary depth", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
      ["grandchild", "child", 300],
    ])

    assert.equal(getSessionRootFromMap(sessions, "grandchild")?.id, "root")
    assert.deepEqual(getSessionAncestorIdsFromMap(sessions, "grandchild"), ["root", "child"])
  })

  it("terminates safely for cycles and missing parents", () => {
    const sessions = sessionMap([
      ["a", "b", 100],
      ["b", "a", 200],
      ["orphan", "missing", 300],
    ])

    assert.equal(getSessionRootFromMap(sessions, "a"), null)
    assert.equal(getSessionRootFromMap(sessions, "orphan"), null)
    assert.deepEqual(getSessionAncestorIdsFromMap(sessions, "a"), [])
    assert.deepEqual(getDescendantSessionsFromMap(sessions, "a").map((item) => item.id), ["b"])
    assert.deepEqual(buildSessionThreadsFromMap(sessions, ["a", "orphan"]), [])
  })

  it("collects an intermediate subtree and orders deletion children before parents", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
      ["grandchild", "child", 300],
      ["sibling", "root", 400],
    ])
    const threads = buildSessionThreadsFromMap(sessions, ["root"])
    const child = findSessionThread(threads, "child")

    assert.ok(child)
    assert.deepEqual(collectSessionThreadIds([child]), ["child", "grandchild"])
    assert.deepEqual(
      sortSessionIdsDeepestFirst(sessions, ["root", "child", "grandchild"]),
      ["grandchild", "child", "root"],
    )
  })
})
