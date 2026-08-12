import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Session } from "../types/session"
import {
  buildSessionThreadsFromMap,
  collectSessionThreadIds,
  collectVisibleSessionIds,
  flattenVisibleSessionThreads,
  findSessionThread,
  getDescendantSessionsFromMap,
  getSessionAncestorIdsFromMap,
  getSessionRootFromMap,
  projectSessionFamilies,
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

  it("flattens visible nested rows in pre-order with sibling metadata", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 400],
      ["grandchild", "child", 300],
      ["sibling", "root", 200],
      ["other-root", null, 50],
    ])
    const threads = buildSessionThreadsFromMap(sessions, ["root", "other-root"])
    const expanded = new Set(["root", "child"])
    const rows = flattenVisibleSessionThreads(threads, (id) => expanded.has(id))

    assert.deepEqual(rows.map((row) => row.sessionId), ["root", "child", "grandchild", "sibling", "other-root"])
    assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2, 1, 0])
    assert.deepEqual(rows.map((row) => row.isLastChild), [false, false, true, true, true])
    assert.deepEqual(rows.map((row) => row.expanded), [true, true, false, false, false])
  })

  it("does not expose descendants through a collapsed ancestor", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
      ["grandchild", "child", 300],
    ])
    const threads = buildSessionThreadsFromMap(sessions, ["root"])
    const rows = flattenVisibleSessionThreads(threads, (id) => id === "child")

    assert.deepEqual(rows.map((row) => row.sessionId), ["root"])
  })

  it("matches the existing visible-id traversal for expansion sets", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
      ["grandchild", "child", 300],
      ["sibling", "root", 400],
    ])
    const threads = buildSessionThreadsFromMap(sessions, ["root"])

    for (const expanded of [new Set<string>(), new Set(["root"]), new Set(["root", "child"])]) {
      assert.deepEqual(
        flattenVisibleSessionThreads(threads, (id) => expanded.has(id)).map((row) => row.sessionId),
        collectVisibleSessionIds(threads, expanded),
      )
    }
  })

  it("derives children from the projected filtered tree", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
    ])
    const [filteredRoot] = buildSessionThreadsFromMap(sessions, ["root"], new Set())
    const [row] = flattenVisibleSessionThreads([filteredRoot], () => true)

    assert.equal(row.hasChildren, false)
    assert.equal(row.expanded, false)
  })

  it("projects large root lists without dropping or duplicating sessions", () => {
    const definitions: Array<[string, string | null, number]> = []
    for (let index = 0; index < 1_000; index += 1) definitions.push([`session-${index}`, null, index])
    const sessions = sessionMap(definitions)
    const threads = buildSessionThreadsFromMap(sessions, definitions.map(([id]) => id))
    const rows = flattenVisibleSessionThreads(threads, () => false)

    assert.equal(rows.length, 1_000)
    assert.equal(new Set(rows.map((row) => row.sessionId)).size, 1_000)
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

  it("sorts and filters complete families", () => {
    const sessions = sessionMap([
      ["z-root", null, 100],
      ["matching-child", "z-root", 500],
      ["sibling", "z-root", 200],
      ["a-root", null, 300],
    ])
    sessions.get("z-root")!.title = "Zulu"
    sessions.get("z-root")!.location = { directory: "C:\\repo\\feature" }
    sessions.get("matching-child")!.location = { directory: "C:\\repo\\feature" }
    sessions.get("sibling")!.location = { directory: "C:\\repo\\feature" }
    sessions.get("a-root")!.title = "Alpha"
    sessions.get("a-root")!.location = { directory: "C:\\repo" }
    const threads = buildSessionThreadsFromMap(sessions, ["z-root", "a-root"])
    const labels = (directory: string) => directory.endsWith("feature") ? "feature" : "root"

    const matched = projectSessionFamilies(threads, {
      sort: "name",
      matchesSession: (item) => item.id === "matching-child",
      getWorktreeLabel: labels,
    })
    assert.deepEqual(collectSessionThreadIds(matched), ["z-root", "matching-child", "sibling"])

    const filtered = projectSessionFamilies(threads, {
      sort: "worktree",
      worktreeDirectory: "c:/REPO/FEATURE/",
      getWorktreeLabel: labels,
    })
    assert.deepEqual(collectSessionThreadIds(filtered), ["z-root", "matching-child", "sibling"])
    assert.deepEqual(projectSessionFamilies(threads, { sort: "name", getWorktreeLabel: labels }).map((item) => item.session.id), ["a-root", "z-root"])
  })
})
