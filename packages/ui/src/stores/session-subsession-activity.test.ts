import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import type { Session } from "../types/session.ts"
import { getInstanceSessionIndicatorStatus } from "./session-status.ts"
import {
  clearInstanceSessionExpansionState,
  expandedSessions,
  getPersistentExpandedSessionIds,
  hydrateSessionExpansion,
  revealSubsession,
  setActiveSession,
  setSessionExpanded,
  setSessionStatus,
  setSessions,
} from "./session-state.ts"
import { collectDescendantActivity } from "./session-tree.ts"

const session = (id: string, parentId: string | null, status: Session["status"] = "idle") =>
  ({ id, parentId, status, time: { created: 1, updated: 1 }, location: { directory: "/repo" } }) as unknown as Session

// root ─ parent ─ child ─ grandchild, plus an unrelated root with its own child.
function seed(...instanceIds: string[]) {
  setSessions(new Map(instanceIds.map((instanceId) => [instanceId, new Map([
    ["root", session("root", null)],
    ["parent", session("parent", "root")],
    ["child", session("child", "parent")],
    ["grandchild", session("grandchild", "child")],
    ["other", session("other", null)],
    ["other-child", session("other-child", "other")],
  ])])))
  for (const instanceId of instanceIds) {
    clearInstanceSessionExpansionState(instanceId)
  }
}

const expanded = (instanceId: string) => [...(expandedSessions().get(instanceId) ?? [])].sort()

describe("subsession activity", () => {
  beforeEach(() => seed("tab-a", "tab-b"))

  it("reveals a requested subsession only inside the conversation each tab is showing", () => {
    setActiveSession("tab-a", "parent")
    setActiveSession("tab-b", "other")
    setSessionStatus("tab-a", "grandchild", "working")
    setSessionStatus("tab-b", "grandchild", "working")
    assert.deepEqual(expanded("tab-a"), [])
    revealSubsession("tab-a", "grandchild")
    revealSubsession("tab-b", "grandchild")
    // Tab A shows `parent`: only the path below it opens. Tab B shows another family: nothing moves.
    assert.deepEqual(expanded("tab-a"), ["child", "parent"])
    assert.deepEqual(expanded("tab-b"), [])
  })

  it("restores automatic reveals just like manual expansions", () => {
    setActiveSession("tab-a", "root")
    setSessionExpanded("tab-a", "other", true)
    setSessionStatus("tab-a", "child", "working")
    revealSubsession("tab-a", "child")
    assert.deepEqual(expanded("tab-a"), ["other", "parent", "root"])
    const saved = getPersistentExpandedSessionIds("tab-a")
    assert.deepEqual(saved.sort(), ["other", "parent", "root"])
    clearInstanceSessionExpansionState("tab-a")
    hydrateSessionExpansion("tab-a", saved)
    assert.deepEqual(expanded("tab-a"), ["other", "parent", "root"])
  })

  it("keeps restored and revealed rows when a reveal races restore hydration", () => {
    // The restored selection is seeded before the expansion snapshot is hydrated.
    setActiveSession("tab-a", "root")
    setSessionStatus("tab-a", "child", "working")
    revealSubsession("tab-a", "child")
    // The snapshot held `root`; the live reveal of `parent` also survives hydration.
    hydrateSessionExpansion("tab-a", ["root"])
    assert.deepEqual(expanded("tab-a"), ["parent", "root"])
    assert.deepEqual(getPersistentExpandedSessionIds("tab-a").sort(), ["parent", "root"])

    seed("tab-c")
    setActiveSession("tab-c", "root")
    setSessionStatus("tab-c", "child", "working")
    revealSubsession("tab-c", "child")
    // An empty snapshot must not collapse a reveal for a still-running subsession.
    hydrateSessionExpansion("tab-c", [])
    assert.deepEqual(expanded("tab-c"), ["parent", "root"])
    assert.deepEqual(getPersistentExpandedSessionIds("tab-c").sort(), ["parent", "root"])
  })

  it("allows revealing the same subsession after a manual collapse", () => {
    setActiveSession("tab-a", "root")
    setSessionStatus("tab-a", "child", "working")
    revealSubsession("tab-a", "child")
    setSessionExpanded("tab-a", "parent", false)
    assert.deepEqual(expanded("tab-a"), ["root"])
    // A repeated working status alone is unchanged; a new start reopens the path.
    setSessionStatus("tab-a", "child", "working")
    assert.deepEqual(expanded("tab-a"), ["root"])
    setSessionStatus("tab-a", "child", "idle")
    setSessionStatus("tab-a", "child", "working")
    revealSubsession("tab-a", "child")
    assert.deepEqual(expanded("tab-a"), ["parent", "root"])
    // Another subsession in the same branch is still revealed.
    setSessionStatus("tab-a", "grandchild", "working")
    revealSubsession("tab-a", "grandchild")
    assert.deepEqual(expanded("tab-a"), ["child", "parent", "root"])
  })

  it("aggregates descendant activity per ancestor and lights the project tab from a subsession", () => {
    setActiveSession("tab-a", "other")
    setSessionStatus("tab-a", "grandchild", "working")
    setSessions((prev) => {
      const next = new Map(prev)
      const sessions = new Map(next.get("tab-a"))
      sessions.set("child", { ...sessions.get("child")!, pendingPermission: true })
      next.set("tab-a", sessions)
      return next
    })
    assert.equal(collectDescendantActivity(undefined).size, 0)
    const counts = collectDescendantActivity(new Map([
      ["root", session("root", null)],
      ["parent", session("parent", "root")],
      ["child", { ...session("child", "parent"), pendingPermission: true }],
      ["grandchild", session("grandchild", "child", "working")],
    ]))
    assert.deepEqual(counts.get("root"), { permission: 1, working: 1, compacting: 0, idle: 0 })
    assert.deepEqual(counts.get("child"), { permission: 0, working: 1, compacting: 0, idle: 0 })
    assert.equal(counts.has("grandchild"), false)
    // Only subsessions are active; the root and tab still report it.
    assert.equal(getInstanceSessionIndicatorStatus("tab-a"), "permission")
    assert.deepEqual(expanded("tab-a"), [])
  })
})
