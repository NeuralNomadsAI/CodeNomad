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
  projectSessionSearchResults,
  projectUnarchivedSessionThreads,
  sortSessionIdsDeepestFirst,
} from "./session-tree"
import { normalizeSessionDirectory } from "./session-list-options"

function session(id: string, parentId: string | null, updated: number): Session {
  return { id, parentId, time: { created: updated, updated } } as Session
}

function sessionMap(definitions: Array<[string, string | null, number]>): Map<string, Session> {
  return new Map(definitions.map(([id, parentId, updated]) => [id, session(id, parentId, updated)]))
}

describe("session tree", () => {
  it("projects native archives without altering flags, selected paths or live work", () => {
    const sessions = sessionMap([["root", null, 1], ["child", "root", 2], ["nested", "child", 3], ["other", null, 4]])
    for (const value of sessions.values()) value.status = "idle"
    sessions.get("root")!.time.archived = 10
    const threads = buildSessionThreadsFromMap(sessions, ["root", "other"])
    const ids = (selected?: string) => collectSessionThreadIds(projectUnarchivedSessionThreads(threads, selected))
    assert.deepEqual(ids(), ["other"])
    assert.deepEqual(ids("nested"), ["other", "root", "child", "nested"])
    sessions.get("nested")!.pendingForm = true
    assert.deepEqual(ids(), ["other", "root", "child", "nested"])
    sessions.get("nested")!.pendingForm = false
    sessions.get("child")!.status = "working"
    assert.deepEqual(ids(), ["other", "root", "child"])
    sessions.get("child")!.status = "idle"
    assert.equal(sessions.get("child")!.time.archived, undefined)
    const options = { sort: "activity" as const, getWorktreeLabel: () => "", includeMainSessions: true, includeSubsessions: true }
    const filtered = (archive: "active" | "archived" | "all") => projectSessionSearchResults(sessions.values(), { ...options, archive }).map(row => row.session.id)
    assert.deepEqual(filtered("archived"), ["root"])
    assert.deepEqual(filtered("active"), ["other", "nested", "child"])
    assert.equal(filtered("all").length, 4)
    assert.equal(collectSessionThreadIds(threads).length, 4, "authoritative family remains intact")
  })
  it("hides reserved schedule carriers in browsing and search without removing native observations", () => {
    const carrier = "ses_cn_schedule_fixture", sessions = sessionMap([["ordinary", null, 1], [carrier, null, 2]])
    const threads = buildSessionThreadsFromMap(sessions, ["ordinary", carrier])
    assert.deepEqual(threads.map(item => item.session.id), ["ordinary"])
    const options = { sort: "activity" as const, getWorktreeLabel: () => "", includeMainSessions: true, includeSubsessions: true }
    assert.deepEqual(projectSessionSearchResults(sessions.values(), options).map(item => item.session.id), ["ordinary"])
    assert.deepEqual(projectSessionFamilies([{ session: sessions.get(carrier)!, children: [], depth: 0, hasChildren: false, latestUpdated: 2 }], options), [])
    assert.equal(sessions.has(carrier), true, "display filtering preserves authoritative native data")
  })
  it("preserves case in the Linux portion of WSL UNC paths", () => {
    assert.equal(
      normalizeSessionDirectory("\\\\WSL.localhost\\Ubuntu\\Repo\\Feature"),
      "//wsl.localhost/ubuntu/Repo/Feature",
    )
    assert.equal(normalizeSessionDirectory("\\\\wsl$\\Ubuntu\\Repo\\Feature"), "//wsl$/ubuntu/Repo/Feature")
  })

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

  it("ranks favorites only among siblings at each depth while pending requests still lift their branch", () => {
    const sessions = sessionMap([
      ["favorite-parent", null, 1], ["favorite-child", "favorite-parent", 2],
      ["newer-sibling", "favorite-parent", 9], ["waiting-parent", null, 3],
      ["waiting-child", "waiting-parent", 4], ["recent", null, 10],
      ["deep-favorite", "favorite-child", 5], ["deep-recent", "favorite-child", 8],
      ["pending-sibling", "favorite-parent", 6],
    ])
    sessions.get("waiting-child")!.pendingForm = true
    sessions.get("pending-sibling")!.pendingPermission = true
    const roots = ["favorite-parent", "waiting-parent", "recent"]
    const original = buildSessionThreadsFromMap(sessions, roots)
    const project = (...ids: string[]) => projectSessionFamilies(original, {
      sort: "activity", getWorktreeLabel: () => "", favoriteIds: new Set(ids),
    })
    assert.deepEqual(collectSessionThreadIds(project("deep-favorite")), [
      "favorite-parent", "pending-sibling", "newer-sibling", "favorite-child", "deep-favorite", "deep-recent",
      "waiting-parent", "waiting-child", "recent",
    ])
    const promoted = project("favorite-child", "deep-favorite")
    assert.deepEqual(collectSessionThreadIds(promoted), [
      "favorite-parent", "pending-sibling", "favorite-child", "deep-favorite", "deep-recent", "newer-sibling",
      "waiting-parent", "waiting-child", "recent",
    ])
    sessions.get("pending-sibling")!.pendingPermission = false
    assert.deepEqual(project("favorite-child").map(row => row.session.id), ["waiting-parent", "recent", "favorite-parent"])
    assert.deepEqual(project("favorite-parent").map(row => row.session.id), ["waiting-parent", "favorite-parent", "recent"])
    assert.deepEqual(original.map(row => row.session.id), ["recent", "favorite-parent", "waiting-parent"])
  })

  it("ranks flat favorite matches without adding ancestors or overriding filters or explicit sorts", () => {
    const sessions = sessionMap([
      ["parent", null, 1], ["z-favorite", "parent", 2], ["a-recent", "parent", 3], ["hidden-favorite", "parent", 4],
    ])
    for (const value of sessions.values()) value.title = value.id
    const options = {
      includeMainSessions: true, includeSubsessions: true, favoriteIds: new Set(["z-favorite", "hidden-favorite"]),
      getWorktreeLabel: () => "", matchesSession: (session: Session) => ["z-favorite", "a-recent"].includes(session.id),
    }
    const project = (sort: "activity" | "name" | "worktree", includeSubsessions = true) =>
      projectSessionSearchResults(sessions.values(), { ...options, sort, includeSubsessions }).map(row => row.session.id)
    assert.deepEqual(project("activity"), ["z-favorite", "a-recent"])
    assert.deepEqual(project("name"), ["a-recent", "z-favorite"])
    assert.deepEqual(project("worktree"), ["a-recent", "z-favorite"])
    assert.deepEqual(project("activity", false), [])
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

  it("keeps a complete family when a descendant matches", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["matching-child", "root", 500],
      ["sibling", "root", 200],
    ])
    const matched = projectSessionFamilies(buildSessionThreadsFromMap(sessions, ["root"]), {
      sort: "activity",
      matchesSession: (item) => item.id === "matching-child",
      getWorktreeLabel: () => "root",
    })
    assert.deepEqual(collectSessionThreadIds(matched), ["root", "matching-child", "sibling"])
  })

  it("searches individual sessions without ancestors, inherited activity or hidden selection descendants", () => {
    const sessions = sessionMap([
      ["root", null, 100],
      ["child", "root", 200],
      ["grandchild", "child", 300],
      ["local-root", null, 400],
    ])
    for (const item of sessions.values()) {
      item.location = { directory: "D:\\repo" }
      item.status = "idle"
    }
    const parent = sessions.get("root")!
    parent.location = { directory: "D:\\worktrees\\feature" }
    parent.status = "working"
    const grandchild = sessions.get("grandchild")!
    const project = (worktreeDirectory: string, includeSubsessions = true) => projectSessionSearchResults(
      sessions.values(),
      { sort: "activity", worktreeDirectory, includeMainSessions: true, includeSubsessions, getWorktreeLabel: directory => directory },
    )
    assert.deepEqual(project("D:\\repo").map(thread => thread.session.id), ["local-root", "grandchild", "child"])
    assert.deepEqual(collectSessionThreadIds(project("D:\\repo", false)), ["local-root"])
    assert.equal(project("D:/worktrees/feature")[0].session.id, "root")
    assert.deepEqual(collectSessionThreadIds(project("")), ["local-root", "grandchild", "child", "root"], "each row uses its own activity")
    assert.equal(project("", false).length, 2)
    for (const status of ["working", "compacting"] as const) {
      grandchild.status = status
      assert.deepEqual(collectSessionThreadIds(project("D:\\repo")), ["local-root", "grandchild", "child"])
      assert.deepEqual(collectSessionThreadIds(project("D:/worktrees/feature")), ["root"])
    }
    grandchild.location = { directory: "D:\\another-checkout" }
    assert.equal(project("D:\\repo").length, 2)
    grandchild.location = { directory: "D:\\repo" }
    grandchild.status = "idle"
    assert.equal(project("D:\\repo").length, 3)
    const match = projectSessionSearchResults([grandchild], {
      sort: "name", worktreeDirectory: "D:\\repo", includeMainSessions: true, includeSubsessions: true,
      matchesSession: item => item.id === "grandchild", getWorktreeLabel: directory => directory,
    })
    assert.deepEqual(collectSessionThreadIds(match), ["grandchild"], "a result renders even without its parents loaded")
    assert.equal(match[0].depth, 0)
    assert.equal(match[0].hasChildren, false)
    assert.equal(projectSessionSearchResults([grandchild], {
      sort: "worktree", worktreeDirectory: parent.location.directory, includeMainSessions: true, includeSubsessions: true,
      matchesSession: item => item.id === "grandchild", getWorktreeLabel: directory => directory,
    }).length, 0, "text and directory must match the same session")
  })

  it("backtracks ancestor tracking cleanly across deep sibling trees", () => {
    const sessions = sessionMap([
      ["r1", null, 100],
      ["r1-a", "r1", 200],
      ["r1-a-1", "r1-a", 300],
      ["r1-b", "r1", 250],
      ["r2", null, 400],
      ["r2-a", "r2", 500],
      ["r2-a-1", "r2-a", 600],
    ])
    const threads = buildSessionThreadsFromMap(sessions, ["r1", "r2"], undefined, undefined, true)
    assert.deepEqual(
      collectSessionThreadIds(threads),
      ["r2", "r2-a", "r2-a-1", "r1", "r1-a", "r1-a-1", "r1-b"],
    )
    assert.equal(threads[0].children[0].children[0].depth, 2)
    assert.equal(threads[1].children[0].children[0].depth, 2)
  })
})
