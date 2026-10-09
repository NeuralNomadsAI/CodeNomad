import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import type { Session } from "../types/session.ts"
import { getInstanceSessionIndicatorStatus } from "./session-status.ts"
import {
  clearInstanceSessionExpansionState,
  expandedSessions,
  getPersistentExpandedSessionIds,
  setActiveSession,
  setSessionExpanded,
  setSessionStatus,
  setSessions,
  syncInstanceSessionIndicator,
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
    syncInstanceSessionIndicator(instanceId)
  }
}

const expanded = (instanceId: string) => [...(expandedSessions().get(instanceId) ?? [])].sort()

describe("subsession activity", () => {
  beforeEach(() => seed("tab-a", "tab-b"))

  it("reveals a working subsession only inside the conversation each tab is showing", () => {
    setActiveSession("tab-a", "parent")
    setActiveSession("tab-b", "other")
    setSessionStatus("tab-a", "grandchild", "working")
    setSessionStatus("tab-b", "grandchild", "working")
    // Tab A shows `parent`: only the path below it opens. Tab B shows another family: nothing moves.
    assert.deepEqual(expanded("tab-a"), ["child", "parent"])
    assert.deepEqual(expanded("tab-b"), [])
  })

  it("keeps automatic reveals out of restorable state until the user takes them over", () => {
    setActiveSession("tab-a", "root")
    setSessionExpanded("tab-a", "other", true)
    setSessionStatus("tab-a", "child", "working")
    assert.deepEqual(expanded("tab-a"), ["other", "parent", "root"])
    assert.deepEqual(getPersistentExpandedSessionIds("tab-a"), ["other"])
    setSessionExpanded("tab-a", "parent", true)
    assert.deepEqual(getPersistentExpandedSessionIds("tab-a").sort(), ["other", "parent"])
  })

  it("does not reopen a branch the user collapsed for the same running subsession", () => {
    setActiveSession("tab-a", "root")
    setSessionStatus("tab-a", "child", "working")
    setSessionExpanded("tab-a", "parent", false)
    setSessionStatus("tab-a", "child", "idle")
    setSessionStatus("tab-a", "child", "working")
    assert.deepEqual(expanded("tab-a"), ["root"])
    // Another subsession in the same branch is still revealed.
    setSessionStatus("tab-a", "grandchild", "working")
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
    syncInstanceSessionIndicator("tab-a")
    assert.equal(collectDescendantActivity(undefined).size, 0)
    const counts = collectDescendantActivity(new Map([
      ["root", session("root", null)],
      ["parent", session("parent", "root")],
      ["child", { ...session("child", "parent"), pendingPermission: true }],
      ["grandchild", session("grandchild", "child", "working")],
    ]))
    assert.deepEqual(counts.get("root"), { permission: 1, working: 1, compacting: 0 })
    assert.deepEqual(counts.get("child"), { permission: 0, working: 1, compacting: 0 })
    assert.equal(counts.has("grandchild"), false)
    // Only subsessions are active; the root and tab still report it.
    assert.equal(getInstanceSessionIndicatorStatus("tab-a"), "permission")
    assert.deepEqual(expanded("tab-a"), [])
  })
})
