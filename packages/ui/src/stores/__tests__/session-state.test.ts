import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import type { Session } from "../../types/session.ts"
import type { SessionThread } from "../session-state.ts"
import {
  getSessionThreads,
  getSessionFamily,
  isSessionExpanded,
  toggleSessionExpanded,
  setSessionExpanded,
  ensureSessionExpanded,
  getVisibleSessionIds,
  setSessions,
} from "../session-state.ts"

const INSTANCE_ID = "test-instance"

// Helper to create a mock session with required fields
function createMockSession(overrides: Partial<Session> & { id: string; parentId?: string | null; updated?: number; created?: number }): Session {
  return {
    id: overrides.id,
    instanceId: overrides.instanceId ?? INSTANCE_ID,
    parentId: overrides.parentId ?? null,
    agent: overrides.agent ?? "test-agent",
    model: overrides.model ?? { providerId: "provider", modelId: "model" },
    version: overrides.version ?? "1.0",
    status: overrides.status ?? "idle",
    time: {
      created: overrides.created ?? 1000,
      updated: overrides.updated ?? 1000,
    },
    title: overrides.title,
  } as Session
}

// Helper to set up sessions map
function setupSessions(sessionDefs: Array<{ id: string; parentId?: string | null; updated?: number; created?: number }>): void {
  const sessionsMap = new Map<string, Map<string, Session>>()
  const instanceSessions = new Map<string, Session>()

  for (const def of sessionDefs) {
    instanceSessions.set(def.id, createMockSession(def))
  }

  sessionsMap.set(INSTANCE_ID, instanceSessions)
  setSessions(sessionsMap)
}

describe("getSessionThreads", () => {
  afterEach(() => {
    setSessions(new Map())
  })

  it("returns empty array when no sessions exist", () => {
    setupSessions([])
    const threads = getSessionThreads(INSTANCE_ID)
    assert.equal(threads.length, 0)
  })

  it("returns single top-level session with no children", () => {
    setupSessions([{ id: "session-1", parentId: null, updated: 1000 }])
    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads.length, 1)
    assert.equal(threads[0].session.id, "session-1")
    assert.equal(threads[0].depth, 0)
    assert.equal(threads[0].hasChildren, false)
    assert.equal(threads[0].children.length, 0)
  })

  it("returns session with single level of children", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child-1", parentId: "parent", updated: 1500 },
      { id: "child-2", parentId: "parent", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads.length, 1)
    assert.equal(threads[0].session.id, "parent")
    assert.equal(threads[0].hasChildren, true)
    assert.equal(threads[0].children.length, 2)
    // Children should be sorted by update time descending
    assert.equal(threads[0].children[0].session.id, "child-1")
    assert.equal(threads[0].children[1].session.id, "child-2")
    // Children at depth 1
    assert.equal(threads[0].children[0].depth, 1)
    assert.equal(threads[0].children[1].depth, 1)
  })

  it("returns session with multiple levels of nested children", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 3000 },
      { id: "level-1a", parentId: "root", updated: 2500 },
      { id: "level-1b", parentId: "root", updated: 2000 },
      { id: "level-2a", parentId: "level-1a", updated: 1800 },
      { id: "level-2b", parentId: "level-1a", updated: 1500 },
      { id: "level-3a", parentId: "level-2a", updated: 1200 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads.length, 1)
    const rootThread = threads[0]
    assert.equal(rootThread.session.id, "root")
    assert.equal(rootThread.depth, 0)
    assert.equal(rootThread.hasChildren, true)

    // First level children
    assert.equal(rootThread.children.length, 2)
    const level1a = rootThread.children.find((t) => t.session.id === "level-1a")!
    const level1b = rootThread.children.find((t) => t.session.id === "level-1b")!

    // Level 1a has children, level 1b does not
    assert.equal(level1a.hasChildren, true)
    assert.equal(level1b.hasChildren, false)

    // Check depth propagation
    assert.equal(level1a.depth, 1)
    assert.equal(level1b.depth, 1)

    // Level 2 children of level-1a
    assert.equal(level1a.children.length, 2)
    const level2a = level1a.children.find((t) => t.session.id === "level-2a")!
    const level2b = level1a.children.find((t) => t.session.id === "level-2b")!

    assert.equal(level2a.depth, 2)
    assert.equal(level2b.depth, 2)
    assert.equal(level2a.hasChildren, true)
    assert.equal(level2b.hasChildren, false)

    // Level 3 child
    assert.equal(level2a.children.length, 1)
    assert.equal(level2a.children[0].session.id, "level-3a")
    assert.equal(level2a.children[0].depth, 3)
    assert.equal(level2a.children[0].hasChildren, false)
  })

  it("sorts children by update time descending", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 5000 },
      { id: "oldest", parentId: "parent", updated: 1000 },
      { id: "newest", parentId: "parent", updated: 3000 },
      { id: "middle", parentId: "parent", updated: 2000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)
    const children = threads[0].children

    assert.equal(children[0].session.id, "newest")
    assert.equal(children[1].session.id, "middle")
    assert.equal(children[2].session.id, "oldest")
  })

  it("sorts threads by latestUpdated descending", () => {
    setupSessions([
      { id: "session-old", parentId: null, updated: 1000 },
      { id: "session-new", parentId: null, updated: 5000 },
      { id: "session-mid", parentId: null, updated: 3000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads[0].session.id, "session-new")
    assert.equal(threads[1].session.id, "session-mid")
    assert.equal(threads[2].session.id, "session-old")
  })

  it("correctly computes latestUpdated for nested threads", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 1000 },
      { id: "child", parentId: "root", updated: 5000 },
      { id: "grandchild", parentId: "child", updated: 3000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    // Root's latestUpdated should be max of all descendants (5000)
    assert.equal(threads[0].latestUpdated, 5000)
    // Child's latestUpdated should be max of itself and grandchild (5000)
    const childThread = threads[0].children[0]
    assert.equal(childThread.latestUpdated, 5000)
  })

  it("hasChildren is true when session has direct children", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads[0].hasChildren, true)
    assert.equal(threads[0].children[0].hasChildren, false)
  })

  it("hasChildren is true for sessions with nested children (not just direct)", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 3000 },
      { id: "middle", parentId: "root", updated: 2000 },
      { id: "leaf", parentId: "middle", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    // Root has a descendant
    assert.equal(threads[0].hasChildren, true)
    // Middle has a child
    assert.equal(threads[0].children[0].hasChildren, true)
    // Leaf has no children
    assert.equal(threads[0].children[0].children[0].hasChildren, false)
  })

  it("rebuilds tree when a deep descendant is added (cache invalidation)", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 1000 },
      { id: "child", parentId: "root", updated: 1000 },
      { id: "grandchild", parentId: "child", updated: 1000 },
    ])

    const initial = getSessionThreads(INSTANCE_ID)
    assert.equal(initial[0].children[0].children.length, 1)
    assert.equal(initial[0].children[0].children[0].session.id, "grandchild")

    // Add a great-grandchild below "grandchild" without changing root or
    // root's direct children. This simulates a live SSE event arriving for
    // a deeply nested subagent.
    setupSessions([
      { id: "root", parentId: null, updated: 1000 },
      { id: "child", parentId: "root", updated: 1000 },
      { id: "grandchild", parentId: "child", updated: 1000 },
      { id: "great-grandchild", parentId: "grandchild", updated: 2000 },
    ])

    const updated = getSessionThreads(INSTANCE_ID)
    const grandchildThread = updated[0].children[0].children[0]
    assert.equal(grandchildThread.children.length, 1)
    assert.equal(grandchildThread.children[0].session.id, "great-grandchild")
    assert.equal(grandchildThread.hasChildren, true)
  })

  it("rebuilds tree when a descendant's updated time changes", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 1000 },
      { id: "child", parentId: "root", updated: 1000 },
      { id: "grandchild", parentId: "child", updated: 1000 },
    ])

    const initial = getSessionThreads(INSTANCE_ID)
    assert.equal(initial[0].latestUpdated, 1000)

    // Bump only the grandchild's updated time — root and direct children unchanged
    setupSessions([
      { id: "root", parentId: null, updated: 1000 },
      { id: "child", parentId: "root", updated: 1000 },
      { id: "grandchild", parentId: "child", updated: 5000 },
    ])

    const updated = getSessionThreads(INSTANCE_ID)
    // latestUpdated must propagate the deep descendant's new time
    assert.equal(updated[0].latestUpdated, 5000)
  })

  it("threads are sorted by latestUpdated when update times differ", () => {
    setupSessions([
      { id: "root-old", parentId: null, updated: 1000 },
      { id: "child-new", parentId: "root-old", updated: 5000 },
      { id: "root-new", parentId: null, updated: 3000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    // root-old has child with latestUpdated=5000, so it should come first
    assert.equal(threads[0].session.id, "root-old")
    assert.equal(threads[0].latestUpdated, 5000)
    assert.equal(threads[1].session.id, "root-new")
  })
})

describe("getSessionFamily", () => {
  afterEach(() => {
    setSessions(new Map())
  })

  it("returns only the session if it has no children", () => {
    setupSessions([{ id: "session-1", parentId: null, updated: 1000 }])

    const family = getSessionFamily(INSTANCE_ID, "session-1")

    assert.equal(family.length, 1)
    assert.equal(family[0].id, "session-1")
  })

  it("returns session plus all recursive descendants", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 4000 },
      { id: "child-1", parentId: "root", updated: 3000 },
      { id: "child-2", parentId: "root", updated: 2000 },
      { id: "grandchild", parentId: "child-1", updated: 1000 },
    ])

    const family = getSessionFamily(INSTANCE_ID, "root")

    assert.equal(family.length, 4)
    // First element should be the root
    assert.equal(family[0].id, "root")
    // Should contain all descendants
    const ids = family.map((s) => s.id)
    assert.deepEqual(ids, ["root", "child-1", "grandchild", "child-2"])
  })

  it("returns empty array for non-existent session", () => {
    setupSessions([{ id: "session-1", parentId: null, updated: 1000 }])

    const family = getSessionFamily(INSTANCE_ID, "non-existent")

    assert.equal(family.length, 0)
  })

  it("returns session plus deep nested descendants", () => {
    setupSessions([
      { id: "level-0", parentId: null, updated: 5000 },
      { id: "level-1", parentId: "level-0", updated: 4000 },
      { id: "level-2", parentId: "level-1", updated: 3000 },
      { id: "level-3", parentId: "level-2", updated: 2000 },
    ])

    const family = getSessionFamily(INSTANCE_ID, "level-0")

    assert.equal(family.length, 4)
    const ids = family.map((s) => s.id)
    assert.deepEqual(ids, ["level-0", "level-1", "level-2", "level-3"])
  })

  it("only returns descendants of specified session, not siblings", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 5000 },
      { id: "child-1", parentId: "parent", updated: 4000 },
      { id: "child-2", parentId: "parent", updated: 3000 },
      { id: "grandchild", parentId: "child-1", updated: 2000 },
      { id: "sibling-child", parentId: "child-2", updated: 1000 },
    ])

    const family = getSessionFamily(INSTANCE_ID, "child-1")

    assert.equal(family.length, 2)
    const ids = family.map((s) => s.id)
    assert.deepEqual(ids, ["child-1", "grandchild"])
  })
})

describe("Expansion state", () => {
  afterEach(() => {
    setSessions(new Map())
  })

  it("default state is collapsed", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), false)
    assert.equal(isSessionExpanded(INSTANCE_ID, "child"), false)
  })

  it("toggle expands a collapsed session", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    toggleSessionExpanded(INSTANCE_ID, "parent")
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), true)
  })

  it("toggle collapses an expanded session", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    toggleSessionExpanded(INSTANCE_ID, "parent")
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), true)

    toggleSessionExpanded(INSTANCE_ID, "parent")
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), false)
  })

  it("setSessionExpanded to true expands", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    setSessionExpanded(INSTANCE_ID, "parent", true)
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), true)
  })

  it("setSessionExpanded to false collapses", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    setSessionExpanded(INSTANCE_ID, "parent", true)
    setSessionExpanded(INSTANCE_ID, "parent", false)
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), false)
  })

  it("ensureSessionExpanded only expands if collapsed", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    // First call should expand
    ensureSessionExpanded(INSTANCE_ID, "parent")
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), true)

    // Second call should be no-op (already expanded)
    ensureSessionExpanded(INSTANCE_ID, "parent")
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent"), true)
  })

  it("multiple sessions can be expanded independently", () => {
    setupSessions([
      { id: "parent-1", parentId: null, updated: 3000 },
      { id: "parent-2", parentId: null, updated: 2000 },
      { id: "child-1", parentId: "parent-1", updated: 1000 },
      { id: "child-2", parentId: "parent-2", updated: 500 },
    ])

    setSessionExpanded(INSTANCE_ID, "parent-1", true)
    setSessionExpanded(INSTANCE_ID, "parent-2", true)

    assert.equal(isSessionExpanded(INSTANCE_ID, "parent-1"), true)
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent-2"), true)

    setSessionExpanded(INSTANCE_ID, "parent-1", false)
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent-1"), false)
    assert.equal(isSessionExpanded(INSTANCE_ID, "parent-2"), true)
  })
})

describe("getVisibleSessionIds", () => {
  afterEach(() => {
    setSessions(new Map())
  })

  it("returns only top-level sessions when all collapsed", () => {
    setupSessions([
      { id: "parent-1", parentId: null, updated: 3000 },
      { id: "parent-2", parentId: null, updated: 2000 },
      { id: "child-1", parentId: "parent-1", updated: 1000 },
      { id: "child-2", parentId: "parent-2", updated: 500 },
    ])

    const visible = getVisibleSessionIds(INSTANCE_ID)

    // Only top-level parents visible
    assert.equal(visible.length, 2)
    assert.deepEqual(visible, ["parent-1", "parent-2"])
  })

  it("returns visible children when parent expanded", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child-1", parentId: "parent", updated: 1500 },
      { id: "child-2", parentId: "parent", updated: 1000 },
    ])

    setSessionExpanded(INSTANCE_ID, "parent", true)

    const visible = getVisibleSessionIds(INSTANCE_ID)

    assert.equal(visible.length, 3)
    assert.deepEqual(visible, ["parent", "child-1", "child-2"])
  })

  it("returns nested children when ancestor expanded", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 3000 },
      { id: "child", parentId: "root", updated: 2000 },
      { id: "grandchild", parentId: "child", updated: 1000 },
    ])

    setSessionExpanded(INSTANCE_ID, "root", true)

    const visible = getVisibleSessionIds(INSTANCE_ID)

    assert.equal(visible.length, 3)
    assert.deepEqual(visible, ["root", "child", "grandchild"])
  })

  it("only returns children of expanded sessions", () => {
    setupSessions([
      { id: "parent-1", parentId: null, updated: 4000 },
      { id: "parent-2", parentId: null, updated: 3000 },
      { id: "child-1", parentId: "parent-1", updated: 2000 },
      { id: "child-2", parentId: "parent-2", updated: 1000 },
    ])

    setSessionExpanded(INSTANCE_ID, "parent-1", true)

    const visible = getVisibleSessionIds(INSTANCE_ID)

    // Only parent-1 and its child should be visible
    assert.equal(visible.length, 2)
    assert.deepEqual(visible, ["parent-1", "child-1"])
  })

  it("handles multiple levels of expansion", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 5000 },
      { id: "level-1a", parentId: "root", updated: 4000 },
      { id: "level-1b", parentId: "root", updated: 3500 },
      { id: "level-2a", parentId: "level-1a", updated: 3000 },
      { id: "level-2b", parentId: "level-1a", updated: 2500 },
      { id: "level-3a", parentId: "level-2a", updated: 2000 },
    ])

    // Expand root and level-1a
    setSessionExpanded(INSTANCE_ID, "root", true)
    setSessionExpanded(INSTANCE_ID, "level-1a", true)

    const visible = getVisibleSessionIds(INSTANCE_ID)

    // root, level-1a, level-2a, level-3a, level-1b (child of root but not expanded, so not its children)
    assert.equal(visible.length, 5)
    assert.deepEqual(visible, ["root", "level-1a", "level-2a", "level-3a", "level-1b"])
  })

  it("returns empty array when no sessions exist", () => {
    setupSessions([])

    const visible = getVisibleSessionIds(INSTANCE_ID)

    assert.equal(visible.length, 0)
  })

  it("returns visible children for a middle-level expanded session", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 4000 },
      { id: "child", parentId: "root", updated: 3000 },
      { id: "grandchild", parentId: "child", updated: 2000 },
    ])

    // Only expand child, not root
    setSessionExpanded(INSTANCE_ID, "child", true)

    const visible = getVisibleSessionIds(INSTANCE_ID)

    // root is always visible, child is visible (expanded), grandchild visible (child expanded)
    // But wait - grandchild is NOT visible because root is not expanded!
    // Actually looking at the code, root is always visible (it's a top-level session)
    // And child should be visible if root is expanded. But root is not expanded here.
    // Let me re-read the code...
    //
    // Looking at collectVisibleSessionIds:
    // - "This session is visible because its root is always visible" - this means top-level
    // - If this session is expanded, recursively collect visible children
    //
    // Wait, the logic seems to be that:
    // 1. Root sessions are always visible
    // 2. Children are only visible if their parent is expanded
    //
    // So if root is NOT expanded, child is NOT visible even if child IS expanded
    // because child can only be reached through root.

    // Hmm, let me trace through:
    // getVisibleSessionIds calls getSessionThreads which returns all roots
    // Then collectVisibleSessionIds is called
    // For root: add root.id to visible, if root is expanded (NO), don't recurse
    // So only root is visible

    assert.equal(visible.length, 1)
    assert.deepEqual(visible, ["root"])
  })
})

describe("hasChildren computation", () => {
  afterEach(() => {
    setSessions(new Map())
  })

  it("hasChildren is false for sessions with no children", () => {
    setupSessions([{ id: "orphan", parentId: null, updated: 1000 }])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads[0].hasChildren, false)
  })

  it("hasChildren is true for sessions with direct children", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads[0].hasChildren, true)
    assert.equal(threads[0].children[0].hasChildren, false)
  })

  it("hasChildren is true for sessions with nested children", () => {
    setupSessions([
      { id: "grandparent", parentId: null, updated: 3000 },
      { id: "parent", parentId: "grandparent", updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads[0].hasChildren, true) // grandparent has parent
    assert.equal(threads[0].children[0].hasChildren, true) // parent has child
    assert.equal(threads[0].children[0].children[0].hasChildren, false) // child has none
  })

  it("hasChildren is computed correctly across sibling branches", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 5000 },
      { id: "branch-a", parentId: "root", updated: 4000 },
      { id: "branch-b", parentId: "root", updated: 3000 },
      { id: "leaf-a", parentId: "branch-a", updated: 2000 },
      { id: "leaf-b", parentId: "branch-b", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)
    const root = threads[0]
    const branchA = root.children.find((t) => t.session.id === "branch-a")!
    const branchB = root.children.find((t) => t.session.id === "branch-b")!

    assert.equal(root.hasChildren, true)
    assert.equal(branchA.hasChildren, true)
    assert.equal(branchB.hasChildren, true)

    const leafA = branchA.children.find((t) => t.session.id === "leaf-a")!
    const leafB = branchB.children.find((t) => t.session.id === "leaf-b")!

    assert.equal(leafA.hasChildren, false)
    assert.equal(leafB.hasChildren, false)
  })
})

describe("depth computation", () => {
  afterEach(() => {
    setSessions(new Map())
  })

  it("depth is 0 for top-level sessions", () => {
    setupSessions([
      { id: "root-1", parentId: null, updated: 2000 },
      { id: "root-2", parentId: null, updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads[0].depth, 0)
    assert.equal(threads[1].depth, 0)
  })

  it("depth is 1 for direct children", () => {
    setupSessions([
      { id: "parent", parentId: null, updated: 2000 },
      { id: "child", parentId: "parent", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)

    assert.equal(threads[0].depth, 0)
    assert.equal(threads[0].children[0].depth, 1)
  })

  it("depth is correctly computed at each level", () => {
    setupSessions([
      { id: "level-0", parentId: null, updated: 4000 },
      { id: "level-1", parentId: "level-0", updated: 3000 },
      { id: "level-2", parentId: "level-1", updated: 2000 },
      { id: "level-3", parentId: "level-2", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)
    let current = threads[0]

    assert.equal(current.depth, 0)
    assert.equal(current.children.length, 1)

    current = current.children[0]
    assert.equal(current.depth, 1)
    assert.equal(current.children.length, 1)

    current = current.children[0]
    assert.equal(current.depth, 2)
    assert.equal(current.children.length, 1)

    current = current.children[0]
    assert.equal(current.depth, 3)
    assert.equal(current.children.length, 0)
  })

  it("depth is computed independently in sibling branches", () => {
    setupSessions([
      { id: "root", parentId: null, updated: 6000 },
      { id: "branch-a", parentId: "root", updated: 5000 },
      { id: "branch-b", parentId: "root", updated: 4000 },
      { id: "leaf-a", parentId: "branch-a", updated: 3000 },
      { id: "leaf-b", parentId: "branch-b", updated: 2000 },
      { id: "deep-leaf", parentId: "leaf-a", updated: 1000 },
    ])

    const threads = getSessionThreads(INSTANCE_ID)
    const root = threads[0]
    const branchA = root.children.find((t) => t.session.id === "branch-a")!
    const branchB = root.children.find((t) => t.session.id === "branch-b")!

    assert.equal(root.depth, 0)
    assert.equal(branchA.depth, 1)
    assert.equal(branchB.depth, 1)

    const leafA = branchA.children.find((t) => t.session.id === "leaf-a")!
    const leafB = branchB.children.find((t) => t.session.id === "leaf-b")!

    assert.equal(leafA.depth, 2)
    assert.equal(leafB.depth, 2)

    const deepLeaf = leafA.children.find((t) => t.session.id === "deep-leaf")!
    assert.equal(deepLeaf.depth, 3)
  })
})
