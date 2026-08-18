import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RestorableAttachment } from "./client-state-attachments-codec.ts"
import type { RestorableSessionState, RestorableWorkspaceTabState } from "./client-state-codec.ts"
import {
  createRestorableSessionPreservation,
  createRestoredTabCommitGuard,
  markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened,
  markPreservedWorkspaceUnavailable,
  mergeRestorableSessionState,
  recordRestoredTab,
} from "./app-session-snapshot-merge.ts"

const empty = (): RestorableSessionState => ({ tabs: [], activeTabIndex: -1 })
const session = (tabs: RestorableSessionState["tabs"]): RestorableSessionState => ({ tabs, activeTabIndex: 0 })
const workspace = (
  folder: string,
  occurrence = 0,
  state: Partial<RestorableWorkspaceTabState> = {},
): RestorableWorkspaceTabState => ({
  kind: "workspace", folder, occurrence, drafts: {}, attachments: {}, scrollSnapshots: {},
  unseenIdleSince: {}, generationRecovery: {}, ...state,
})
const attachment = (id: string): RestorableAttachment => ({
  id, type: "text", display: id, url: "", filename: `${id}.txt`, mediaType: "text/plain",
  source: { type: "text", value: `${id} content` },
})
const scroll = (scrollTop: number) => ({ scrollTop, atBottom: false, updatedAt: 1 })

function workspaceAt(state: RestorableSessionState, index = 0): RestorableWorkspaceTabState {
  const tab = state.tabs[index]
  assert.equal(tab?.kind, "workspace")
  if (tab?.kind !== "workspace") throw new Error("expected workspace tab")
  return tab
}

describe("app session snapshot merge", () => {
  it("retains unsent state after a non-authoritative workspace stop", () => {
    const saved = session([workspace("/work", 0, { drafts: { missing: "saved", current: "old" } })])
    const preservation = createRestorableSessionPreservation(saved)
    recordRestoredTab(preservation, 0, "instance:work", new Set())
    markPreservedWorkspaceUnavailable(
      preservation,
      { runtimeTabId: "instance:work", folder: "/work", occurrence: 0 },
      workspace("/work", 0, { drafts: { current: "latest unsent draft" } }),
    )

    assert.deepEqual(workspaceAt(mergeRestorableSessionState(empty(), preservation)).drafts, {
      missing: "saved",
      current: "latest unsent draft",
    })
  })

  it("keeps current edits and authoritative deletion over preserved state", () => {
    const saved = session([workspace("/work", 0, {
      activeParentSessionId: "deleted", activeSessionId: "deleted",
      drafts: { edited: "saved", deleted: "draft" },
      attachments: { edited: [attachment("saved")], deleted: [attachment("deleted")] },
      scrollSnapshots: { edited: scroll(10), deleted: scroll(42) },
      unseenIdleSince: { deleted: 1_000 }, generationRecovery: { deleted: "working" },
    })])
    const current = session([workspace("/work", 0, {
      drafts: { edited: "current" }, attachments: { edited: [attachment("current")] },
      scrollSnapshots: { edited: scroll(90) },
    })])
    const merged = mergeRestorableSessionState(current, createRestorableSessionPreservation(saved), {
      currentTabIds: ["instance:work"],
      currentTabAuthorities: [{
        drafts: new Set(["edited"]), attachments: new Set(["edited"]),
        scrollSnapshots: new Set(["edited"]), deletedSessions: new Set(["deleted"]),
      }],
    })
    const tab = workspaceAt(merged)

    assert.equal(tab.drafts.edited, "current")
    assert.equal(tab.attachments.edited?.[0]?.id, "current")
    assert.equal(tab.scrollSnapshots.edited?.scrollTop, 90)
    assert.equal("deleted" in tab.drafts || "deleted" in tab.attachments || "deleted" in tab.scrollSnapshots, false)
    assert.deepEqual([tab.activeParentSessionId, tab.activeSessionId], [undefined, undefined])
  })

  it("rejects a late restore commit after close and reopen", () => {
    const preservation = createRestorableSessionPreservation(session([workspace("/work")]))
    const canCommit = createRestoredTabCommitGuard(preservation, 0)
    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:restore-event", folder: "/work", occurrence: 0,
    })
    assert.equal(canCommit(), true)

    markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:restore-event", folder: "/work", occurrence: 0,
    })
    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:user-reopened", folder: "/work", occurrence: 0,
    })
    assert.equal(canCommit(), false)
  })

  it("keeps duplicate-folder bindings independent through reorder and close", () => {
    const saved = session([
      workspace("/same", 0, { drafts: { first: "first" } }),
      workspace("/same", 1, { drafts: { second: "second" } }),
    ])
    const preservation = createRestorableSessionPreservation(saved)
    recordRestoredTab(preservation, 0, "instance:first")
    recordRestoredTab(preservation, 1, "instance:second")
    const reordered = mergeRestorableSessionState(
      session([workspace("/same", 1), workspace("/same", 0)]),
      preservation,
      { currentTabIds: ["instance:second", "instance:first"] },
    )
    assert.equal(workspaceAt(reordered, 0).drafts.second, "second")
    assert.equal(workspaceAt(reordered, 1).drafts.first, "first")

    markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:first", folder: "/same", occurrence: 0,
    })
    assert.equal(mergeRestorableSessionState(empty(), preservation).tabs.length, 1)
    markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:second", folder: "/same", occurrence: 1,
    })
    assert.equal(mergeRestorableSessionState(empty(), preservation).tabs.length, 0)
  })
})
