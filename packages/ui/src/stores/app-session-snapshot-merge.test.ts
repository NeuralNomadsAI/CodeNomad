import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RestorableSessionState, RestorableWorkspaceTabState } from "./client-state-codec.ts"
import {
  createRestorableSessionPreservation,
  mapRestoredWorkspace,
  mapRestoredWorkspaces,
  markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened,
  markRestoredTab,
  mergeRestorableSessionState,
} from "./app-session-snapshot-merge.ts"
import { reconcileWorkspaceTabs } from "./app-session-reconciliation.ts"

function workspace(
  folder: string,
  occurrence: number,
  state: Partial<RestorableWorkspaceTabState> = {},
): RestorableWorkspaceTabState {
  return {
    kind: "workspace",
    folder,
    occurrence,
    drafts: {},
    attachments: {},
    scrollSnapshots: {},
    unseenIdleSince: {},
    generationRecovery: {},
    expandedSessionIds: [],
    ...state,
  }
}

describe("app session snapshot merge", () => {
  it("retains transient tabs and missing session state while persisting current and new tabs", () => {
    const savedAttachment = {
      id: "paste",
      type: "text" as const,
      display: "pasted #1 (4 lines)",
      url: "",
      filename: "paste.txt",
      mediaType: "text/plain",
      source: { type: "text" as const, value: "saved paste" },
    }
    const saved: RestorableSessionState = {
      activeTabIndex: 1,
      tabs: [
        workspace("/work/a", 0, {
          activeParentSessionId: "missing-session",
          activeSessionId: "missing-session",
          drafts: { "missing-session": "saved draft" },
          attachments: { "missing-session": [savedAttachment] },
          scrollSnapshots: {
            "missing-session": { scrollTop: 42, atBottom: false, updatedAt: 1 },
          },
        }),
        { kind: "sidecar", sidecarId: "transient" },
        { kind: "sidecar", sidecarId: "deleted" },
        workspace("/work/b", 0),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 0, new Set(["missing-session"]))
    preservation = markRestoredTab(preservation, 2)
    preservation = markRestoredTab(preservation, 3)

    const current: RestorableSessionState = {
      activeTabIndex: 2,
      tabs: [
        workspace("/work/a", 0, { drafts: { visible: "current draft" } }),
        workspace("/work/b", 0),
        { kind: "sidecar", sidecarId: "new-runtime-tab" },
      ],
    }
    const merged = mergeRestorableSessionState(current, preservation)

    assert.deepEqual(merged.tabs.map((tab) => tab.kind === "sidecar" ? tab.sidecarId : tab.folder), [
      "/work/a",
      "transient",
      "/work/b",
      "new-runtime-tab",
    ])
    assert.equal(merged.activeTabIndex, 3)
    const first = merged.tabs[0]
    assert.equal(first?.kind, "workspace")
    if (first?.kind !== "workspace") return
    assert.deepEqual(first.drafts, { "missing-session": "saved draft", visible: "current draft" })
    assert.deepEqual(first.attachments["missing-session"], [savedAttachment])
    assert.equal(first.scrollSnapshots["missing-session"]?.scrollTop, 42)
    assert.equal(first.activeParentSessionId, "missing-session")
    assert.equal(first.activeSessionId, "missing-session")
  })

  it("uses a recovered runtime tab instead of duplicating a retained whole tab", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [{ kind: "sidecar", sidecarId: "preview" }],
    }
    const preservation = createRestorableSessionPreservation(saved)
    const current: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        { kind: "sidecar", sidecarId: "preview" },
        { kind: "sidecar", sidecarId: "new" },
      ],
    }

    assert.deepEqual(mergeRestorableSessionState(current, preservation), current)
  })

  it("backfills failed hydration state into a blank matching runtime workspace during capture", () => {
    const savedAttachment = {
      id: "paste",
      type: "text" as const,
      display: "pasted #1 (4 lines)",
      url: "",
      filename: "paste.txt",
      mediaType: "text/plain",
      source: { type: "text" as const, value: "unsaved paste" },
    }
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        workspace("/failed", 0, {
          projectName: "saved metadata",
          activeParentSessionId: "unsaved-session",
          activeSessionId: "unsaved-session",
          drafts: { "unsaved-session": "[pasted #1]", live: "stale draft" },
          attachments: { "unsaved-session": [savedAttachment] },
          scrollSnapshots: {
            "unsaved-session": { scrollTop: 37, atBottom: false, updatedAt: 1 },
          },
        }),
        workspace("/restored", 0),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 1, new Set(), "instance:restored")

    const current: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        workspace("/restored", 0),
        workspace("/failed", 0, {
          projectName: "current metadata",
          drafts: { live: "current draft" },
        }),
      ],
    }
    const merged = mergeRestorableSessionState(current, preservation, {
      currentTabIds: ["instance:restored", "instance:failed"],
    })

    assert.equal(merged.activeTabIndex, 0)
    assert.deepEqual(merged.tabs.map((tab) => tab.kind === "workspace" ? tab.folder : tab.kind), [
      "/restored",
      "/failed",
    ])
    const failed = merged.tabs[1]
    assert.equal(failed?.kind, "workspace")
    if (failed?.kind !== "workspace") return
    assert.equal(failed.occurrence, 0)
    assert.equal(failed.projectName, "current metadata")
    assert.deepEqual(failed.drafts, {
      "unsaved-session": "[pasted #1]",
      live: "current draft",
    })
    assert.deepEqual(failed.attachments["unsaved-session"], [savedAttachment])
    assert.equal(failed.scrollSnapshots["unsaved-session"]?.scrollTop, 37)
    assert.equal(failed.activeParentSessionId, "unsaved-session")
    assert.equal(failed.activeSessionId, "unsaved-session")
  })

  it("keeps untouched failed-hydration records as capture fallbacks", () => {
    const saved = {
      tabs: [workspace("/failed", 0, {
        drafts: { missing: "saved draft" },
        attachments: { missing: [{
          id: "paste",
          type: "text" as const,
          display: "pasted #1 (4 lines)",
          url: "",
          filename: "paste.txt",
          mediaType: "text/plain",
          source: { type: "text" as const, value: "saved paste" },
        }] },
      })],
      activeTabIndex: 0,
    }
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/failed", 0)], activeTabIndex: 0 },
      createRestorableSessionPreservation(saved),
      { currentTabIds: ["instance:failed"], currentTabAuthorities: [{}] },
    )
    const tab = merged.tabs[0]
    assert.equal(tab?.kind, "workspace")
    if (tab?.kind !== "workspace") return
    assert.equal(tab.drafts.missing, "saved draft")
    assert.equal(tab.attachments.missing?.[0]?.id, "paste")
  })

  it("excludes an explicitly closed failed-hydration workspace while retaining transient absence", () => {
    const saved = {
      tabs: [workspace("/failed", 0, { drafts: { missing: "retry me" } })],
      activeTabIndex: 0,
    }
    const unresolved = createRestorableSessionPreservation(saved)
    const empty = { tabs: [], activeTabIndex: -1 }

    assert.equal(mergeRestorableSessionState(empty, unresolved).tabs.length, 1)

    const removed = markPreservedWorkspaceRemoved(unresolved, {
      runtimeTabId: "instance:failed",
      folder: "/failed",
      occurrence: 0,
    })
    assert.deepEqual(mergeRestorableSessionState(empty, removed), empty)

    const reopened = markPreservedWorkspaceReopened(removed, {
      runtimeTabId: "instance:reopened",
      folder: "/failed",
      occurrence: 0,
    })
    assert.equal(mergeRestorableSessionState(empty, reopened).tabs.length, 1)
  })

  it("clears a restored workspace binding when its runtime ID is reopened", () => {
    let preservation = markRestoredTab(
      createRestorableSessionPreservation({
        tabs: [workspace("/work", 0)],
        activeTabIndex: 0,
      }),
      0,
      new Set(),
      "instance:reused",
    )
    assert.equal(preservation.restoredWorkspaceSourceIndexes.get("instance:reused"), 0)

    preservation = markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:reused",
      folder: "/work",
      occurrence: 0,
    })
    assert.equal(preservation.restoredWorkspaceSourceIndexes.size, 0)
    assert.equal(preservation.restoredTabIds[0], null)
  })

  it("does not restore any state for an authoritatively deleted session", () => {
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, {
        activeParentSessionId: "deleted",
        activeSessionId: "deleted",
        drafts: { deleted: "saved draft" },
        attachments: { deleted: [{
          id: "paste",
          type: "text",
          display: "pasted #1 (4 lines)",
          url: "",
          filename: "paste.txt",
          mediaType: "text/plain",
          source: { type: "text", value: "saved paste" },
        }] },
        scrollSnapshots: { deleted: { scrollTop: 42, atBottom: false, updatedAt: 1 } },
      })],
      activeTabIndex: 0,
    })
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ deletedSessions: new Set(["deleted"]) }],
      },
    )
    const tab = merged.tabs[0]
    assert.equal(tab?.kind, "workspace")
    if (tab?.kind !== "workspace") return
    assert.deepEqual(tab.drafts, {})
    assert.deepEqual(tab.attachments, {})
    assert.deepEqual(tab.scrollSnapshots, {})
    assert.equal(tab.activeParentSessionId, undefined)
    assert.equal(tab.activeSessionId, undefined)
  })

  it("does not resurrect a preserved draft after an explicit runtime clear", () => {
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/failed", 0, { drafts: { missing: "saved draft" } })],
      activeTabIndex: 0,
    })
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/failed", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:failed"],
        currentTabAuthorities: [{ drafts: new Set(["missing"]) }],
      },
    )

    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts : undefined, {})
  })

  it("does not resurrect preserved attachments after the last runtime attachment is removed", () => {
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/failed", 0, {
        attachments: { missing: [{
          id: "paste",
          type: "text",
          display: "pasted #1 (4 lines)",
          url: "",
          filename: "paste.txt",
          mediaType: "text/plain",
          source: { type: "text", value: "saved paste" },
        }] },
      })],
      activeTabIndex: 0,
    })
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/failed", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:failed"],
        currentTabAuthorities: [{ attachments: new Set(["missing"]) }],
      },
    )

    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].attachments : undefined, {})
  })

  it("does not resurrect a preserved idle marker after it is seen at runtime", () => {
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, { unseenIdleSince: { seen: 1_000 } })],
      activeTabIndex: 0,
    })
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ idleMarkers: new Set(["seen"]) }],
      },
    )

    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].unseenIdleSince : undefined, {})
  })

  it("preserves idle markers for sessions unavailable during partial restore", () => {
    let preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, {
        unseenIdleSince: { missing: 1_000, loaded: 2_000 },
      })],
      activeTabIndex: 0,
    })
    preservation = markRestoredTab(preservation, 0, new Set(["missing"]), "instance:work")

    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ idleMarkers: new Set(["loaded"]) }],
      },
    )

    assert.deepEqual(
      merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].unseenIdleSince : undefined,
      { missing: 1_000 },
    )
  })

  it("does not re-expand an authoritative session collapsed after restore", () => {
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, { expandedSessionIds: ["collapsed", "still-expanded"] })],
      activeTabIndex: 0,
    })
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0, { expandedSessionIds: ["still-expanded"] })], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ sessionExpansion: new Set(["collapsed", "still-expanded"]) }],
      },
    )

    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].expandedSessionIds : undefined, ["still-expanded"])
  })

  it("preserves expansion for a session unavailable during partial restore", () => {
    let preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, { expandedSessionIds: ["missing", "loaded"] })],
      activeTabIndex: 0,
    })
    preservation = markRestoredTab(preservation, 0, new Set(["missing"]), "instance:work")
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ sessionExpansion: new Set(["loaded"]) }],
      },
    )

    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].expandedSessionIds : undefined, ["missing"])
  })

  it("does not resurrect cleared generation recovery for an authoritative runtime session", () => {
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, { generationRecovery: { resumed: "working" } })],
      activeTabIndex: 0,
    })
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ generationRecovery: new Set(["resumed"]) }],
      },
    )

    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].generationRecovery : undefined, {})
  })

  it("preserves generation recovery for a session unavailable during partial restore", () => {
    let preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, {
        generationRecovery: { missing: "working", loaded: "interrupted" },
      })],
      activeTabIndex: 0,
    })
    preservation = markRestoredTab(preservation, 0, new Set(["missing"]), "instance:work")

    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0)], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ generationRecovery: new Set(["loaded"]) }],
      },
    )

    assert.deepEqual(
      merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].generationRecovery : undefined,
      { missing: "working" },
    )
  })

  it("keeps current interrupted recovery over a preserved working marker", () => {
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/work", 0, { generationRecovery: { session: "working" } })],
      activeTabIndex: 0,
    })
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0, { generationRecovery: { session: "interrupted" } })], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:work"],
        currentTabAuthorities: [{ generationRecovery: new Set(["session"]) }],
      },
    )

    assert.deepEqual(
      merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].generationRecovery : undefined,
      { session: "interrupted" },
    )
  })

  it("keeps new authoritative runtime values over preserved values", () => {
    const savedAttachment = {
      id: "saved",
      type: "text" as const,
      display: "saved attachment",
      url: "",
      filename: "saved.txt",
      mediaType: "text/plain",
      source: { type: "text" as const, value: "saved attachment" },
    }
    const currentAttachment = {
      ...savedAttachment,
      id: "current",
      display: "current attachment",
      filename: "current.txt",
      source: { type: "text" as const, value: "current attachment" },
    }
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace("/failed", 0, {
        drafts: { missing: "saved draft" },
        attachments: { missing: [savedAttachment] },
        scrollSnapshots: { missing: { scrollTop: 10, atBottom: false, updatedAt: 1 } },
      })],
      activeTabIndex: 0,
    })
    const current = workspace("/failed", 0, {
      drafts: { missing: "current draft" },
      attachments: { missing: [currentAttachment] },
      scrollSnapshots: { missing: { scrollTop: 90, atBottom: true, updatedAt: 2 } },
    })
    const merged = mergeRestorableSessionState(
      { tabs: [current], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: ["instance:failed"],
        currentTabAuthorities: [{
          drafts: new Set(["missing"]),
          attachments: new Set(["missing"]),
          scrollSnapshots: new Set(["missing"]),
        }],
      },
    )
    const tab = merged.tabs[0]
    assert.equal(tab?.kind, "workspace")
    if (tab?.kind !== "workspace") return
    assert.equal(tab.drafts.missing, "current draft")
    assert.equal(tab.attachments.missing?.[0]?.id, "current")
    assert.equal(tab.scrollSnapshots.missing?.scrollTop, 90)
  })

  it("keeps a later current session selection over a missing preserved selection", () => {
    const saved = {
      tabs: [workspace("/work", 0, {
        activeParentSessionId: "missing-parent",
        activeSessionId: "missing-child",
      })],
      activeTabIndex: 0,
    }
    const preservation = markRestoredTab(
      createRestorableSessionPreservation(saved),
      0,
      new Set(["missing-parent", "missing-child"]),
      "instance:work",
    )
    const current = workspace("/work", 0, {
      activeParentSessionId: "current-parent",
      activeSessionId: "current-child",
    })
    const merged = mergeRestorableSessionState(
      { tabs: [current], activeTabIndex: 0 },
      preservation,
      { currentTabIds: ["instance:work"] },
    )
    const tab = merged.tabs[0]
    assert.equal(tab?.kind === "workspace" ? tab.activeParentSessionId : undefined, "current-parent")
    assert.equal(tab?.kind === "workspace" ? tab.activeSessionId : undefined, "current-child")
  })

  it("keeps a current info selection over a missing preserved selection", () => {
    const saved = {
      tabs: [workspace("/work", 0, {
        activeParentSessionId: "missing-parent",
        activeSessionId: "missing-child",
      })],
      activeTabIndex: 0,
    }
    const preservation = markRestoredTab(
      createRestorableSessionPreservation(saved),
      0,
      new Set(["missing-parent", "missing-child"]),
      "instance:work",
    )
    const current = workspace("/work", 0, { activeSessionId: "info" })
    const merged = mergeRestorableSessionState(
      { tabs: [current], activeTabIndex: 0 },
      preservation,
      { currentTabIds: ["instance:work"] },
    )
    const tab = merged.tabs[0]
    assert.equal(tab?.kind === "workspace" ? tab.activeParentSessionId : undefined, undefined)
    assert.equal(tab?.kind === "workspace" ? tab.activeSessionId : undefined, "info")
  })

  it("preserves a missing source selection while runtime selection is untouched", () => {
    const saved = {
      tabs: [workspace("/work", 0, {
        activeParentSessionId: "missing-parent",
        activeSessionId: "missing-child",
      })],
      activeTabIndex: 0,
    }
    const preservation = markRestoredTab(
      createRestorableSessionPreservation(saved),
      0,
      new Set(["missing-parent", "missing-child"]),
      "instance:work",
    )
    const merged = mergeRestorableSessionState(
      { tabs: [workspace("/work", 0)], activeTabIndex: 0 },
      preservation,
      { currentTabIds: ["instance:work"] },
    )
    const tab = merged.tabs[0]
    assert.equal(tab?.kind === "workspace" ? tab.activeParentSessionId : undefined, "missing-parent")
    assert.equal(tab?.kind === "workspace" ? tab.activeSessionId : undefined, "missing-child")
  })

  it("does not reinsert an authoritatively deleted SideCar", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [{ kind: "sidecar", sidecarId: "deleted" }],
    }
    const preservation = markRestoredTab(createRestorableSessionPreservation(saved), 0)
    assert.deepEqual(mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, preservation), {
      tabs: [],
      activeTabIndex: -1,
    })
  })

  it("does not relaunch a removed first occurrence from a restored duplicate pair", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 1,
      tabs: [
        workspace("/same", 0),
        workspace("/same", 1, { drafts: { missing: "preserve me" } }),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 0, new Set(), "instance:first")
    preservation = markRestoredTab(preservation, 1, new Set(["missing"]), "instance:second")
    const current: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [workspace("/same", 0, { drafts: { current: "captured" } })],
    }

    const merged = mergeRestorableSessionState(current, preservation, {
      currentTabIds: ["instance:second"],
    })

    assert.equal(merged.tabs.length, 1)
    assert.equal(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].occurrence : undefined, 0)
    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts : undefined, {
      missing: "preserve me",
      current: "captured",
    })
    const nextLaunch = reconcileWorkspaceTabs(
      merged.tabs.map((tab) => tab.kind === "workspace"
        ? { kind: tab.kind, folderPath: tab.folder, occurrence: tab.occurrence }
        : { kind: tab.kind }),
      [{ id: "second", folderPath: "/same" }],
    )
    assert.deepEqual(nextLaunch.map((match) => match.existingWorkspaceId), ["second"])
  })

  it("tombstones both same-folder whole preservations when closed first then remaining", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        workspace("/same", 0, { drafts: { first: "preserve first" } }),
        workspace("/same", 1, { drafts: { second: "preserve second" } }),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = mapRestoredWorkspace(preservation, 0, "instance:first")
    preservation = mapRestoredWorkspace(preservation, 1, "instance:second")

    preservation = markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:first",
      folder: "/same",
      occurrence: 0,
    })
    const afterFirstClose = mergeRestorableSessionState(
      { tabs: [workspace("/same", 0)], activeTabIndex: 0 },
      preservation,
      { currentTabIds: ["instance:second"] },
    )
    assert.equal(afterFirstClose.tabs.length, 1)
    assert.equal(afterFirstClose.tabs[0]?.kind === "workspace" ? afterFirstClose.tabs[0].drafts.second : undefined, "preserve second")

    preservation = markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:second",
      folder: "/same",
      occurrence: 0,
    })
    assert.deepEqual(
      mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, preservation),
      { tabs: [], activeTabIndex: -1 },
    )
  })

  it("keeps duplicate source mappings through reorder and reverse close order", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        workspace("/same", 0, { drafts: { first: "source first" } }),
        workspace("/same", 1, { drafts: { second: "source second" } }),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = mapRestoredWorkspace(preservation, 0, "instance:first")
    preservation = mapRestoredWorkspace(preservation, 1, "instance:second")

    const reordered = mergeRestorableSessionState({
      tabs: [workspace("/same", 1), workspace("/same", 0)],
      activeTabIndex: 0,
    }, preservation, {
      currentTabIds: ["instance:second", "instance:first"],
    })
    assert.equal(reordered.tabs[0]?.kind === "workspace" ? reordered.tabs[0].drafts.second : undefined, "source second")
    assert.equal(reordered.tabs[1]?.kind === "workspace" ? reordered.tabs[1].drafts.first : undefined, "source first")

    preservation = markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:second",
      folder: "/same",
      occurrence: 1,
    })
    preservation = markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:first",
      folder: "/same",
      occurrence: 0,
    })
    assert.equal(mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, preservation).tabs.length, 0)
  })

  it("preserves transient absence for mapped duplicate workspaces", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [workspace("/same", 0), workspace("/same", 1)],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = mapRestoredWorkspace(preservation, 0, "instance:first")
    preservation = mapRestoredWorkspace(preservation, 1, "instance:second")

    const merged = mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, preservation)
    assert.equal(merged.tabs.length, 2)
  })

  it("preserves an uncertain duplicate instead of advancing to the first remaining source", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        workspace("/same", 0, { drafts: { first: "first source" } }),
        workspace("/same", 1, { drafts: { second: "uncertain source" } }),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:unknown-first",
      folder: "/same",
      occurrence: 0,
    })
    preservation = markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:unknown-second",
      folder: "/same",
      occurrence: 0,
    })

    const merged = mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, preservation)
    assert.equal(merged.tabs.length, 1)
    assert.equal(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts.second : undefined, "uncertain source")
  })

  it("atomically binds every matched duplicate before close events can renumber occurrences", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [workspace("/same", 0), workspace("/same", 1), workspace("/same", 2)],
    }
    const preservation = mapRestoredWorkspaces(createRestorableSessionPreservation(saved), [
      { sourceIndex: 0, runtimeTabId: "instance:first" },
      { sourceIndex: 1, runtimeTabId: "instance:middle" },
      { sourceIndex: 2, runtimeTabId: "instance:last" },
    ])

    assert.deepEqual([...preservation.restoredWorkspaceSourceIndexes], [
      ["instance:first", 0],
      ["instance:middle", 1],
      ["instance:last", 2],
    ])
  })

  it("keeps the current order after restored tabs are reordered", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [workspace("/a", 0), workspace("/b", 0)],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 0, new Set(), "instance:a")
    preservation = markRestoredTab(preservation, 1, new Set(), "instance:b")
    const current: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [workspace("/b", 0), workspace("/a", 0)],
    }

    assert.deepEqual(mergeRestorableSessionState(current, preservation, {
      currentTabIds: ["instance:b", "instance:a"],
    }), current)
  })

  it("keeps a new tab interleaved between restored tabs", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [workspace("/a", 0), workspace("/b", 0)],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 0, new Set(), "instance:a")
    preservation = markRestoredTab(preservation, 1, new Set(), "instance:b")
    const current: RestorableSessionState = {
      activeTabIndex: 1,
      tabs: [
        workspace("/a", 0),
        { kind: "sidecar", sidecarId: "new" },
        workspace("/b", 0),
      ],
    }

    assert.deepEqual(mergeRestorableSessionState(current, preservation, {
      currentTabIds: ["instance:a", "sidecar:new", "instance:b"],
    }), current)
  })

  it("keeps the current active workspace after partial state preservation", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        workspace("/a", 0, { drafts: { missing: "preserve me" } }),
        workspace("/b", 0),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 0, new Set(["missing"]), "instance:a")
    preservation = markRestoredTab(preservation, 1, new Set(), "instance:b")
    const currentTabs = [workspace("/a", 0), workspace("/b", 0)]
    const options = { currentTabIds: ["instance:a", "instance:b"] }

    assert.equal(mergeRestorableSessionState({ tabs: currentTabs, activeTabIndex: 0 }, preservation, options).activeTabIndex, 0)
    assert.equal(mergeRestorableSessionState({ tabs: currentTabs, activeTabIndex: 1 }, preservation, options).activeTabIndex, 1)
  })

  it("does not pin future captures to an unresolved source active tab", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [
        { kind: "sidecar", sidecarId: "unresolved" },
        workspace("/a", 0),
        workspace("/b", 0),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 1, new Set(), "instance:a")
    preservation = markRestoredTab(preservation, 2, new Set(), "instance:b")
    const currentTabs = [workspace("/a", 0), workspace("/b", 0)]
    const options = { currentTabIds: ["instance:a", "instance:b"] }

    assert.equal(mergeRestorableSessionState({ tabs: currentTabs, activeTabIndex: 0 }, preservation, options).activeTabIndex, 1)
    assert.equal(mergeRestorableSessionState({ tabs: currentTabs, activeTabIndex: 1 }, preservation, options).activeTabIndex, 2)
  })

  it("retains an unresolved tab beside its nearest restored source neighbor", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 1,
      tabs: [
        workspace("/a", 0),
        { kind: "sidecar", sidecarId: "unresolved" },
        workspace("/b", 0),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 0, new Set(), "instance:a")
    preservation = markRestoredTab(preservation, 2, new Set(), "instance:b")
    const current: RestorableSessionState = {
      activeTabIndex: 1,
      tabs: [workspace("/a", 0), workspace("/b", 0)],
    }

    const merged = mergeRestorableSessionState(current, preservation, {
      currentTabIds: ["instance:a", "instance:b"],
    })
    assert.deepEqual(merged.tabs.map((tab) => tab.kind === "sidecar" ? tab.sidecarId : tab.folder), [
      "/a",
      "unresolved",
      "/b",
    ])
    assert.equal(merged.activeTabIndex, 2)
  })

  it("gives unresolved old occurrence zero a distinct occurrence from renumbered current old occurrence one", () => {
    const saved: RestorableSessionState = {
      activeTabIndex: 1,
      tabs: [
        workspace("/same", 0, { drafts: { failed: "retry me" } }),
        workspace("/same", 1, { drafts: { restored: "saved" } }),
      ],
    }
    let preservation = createRestorableSessionPreservation(saved)
    preservation = markRestoredTab(preservation, 1, new Set(), "instance:second")
    const current: RestorableSessionState = {
      activeTabIndex: 0,
      tabs: [workspace("/same", 0, { drafts: { current: "captured" } })],
    }

    const merged = mergeRestorableSessionState(current, preservation, {
      currentTabIds: ["instance:second"],
    })
    assert.equal(merged.tabs.length, 2)
    assert.equal(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts.failed : undefined, "retry me")
    assert.equal(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].occurrence : undefined, 1)
    assert.equal(merged.tabs[1]?.kind === "workspace" ? merged.tabs[1].occurrence : undefined, 0)
    assert.equal(merged.tabs[1]?.kind === "workspace" ? merged.tabs[1].drafts.current : undefined, "captured")
    const nextLaunch = reconcileWorkspaceTabs(
      merged.tabs.map((tab) => tab.kind === "workspace"
        ? { kind: tab.kind, folderPath: tab.folder, occurrence: tab.occurrence }
        : { kind: tab.kind }),
      [{ id: "second", folderPath: "/same" }],
    )
    assert.deepEqual(nextLaunch.map((match) => match.existingWorkspaceId), [null, "second"])
    assert.equal(nextLaunch.filter((match) => !match.existingWorkspaceId).length, 1)
  })
})
