import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RestorableAttachment } from "./client-state-attachments-codec.ts"
import type { RestorableSessionState, RestorableWorkspaceTabState } from "./client-state-codec.ts"
import {
  createRestorableSessionPreservation,
  createRestoredTabCommitGuard,
  getPreservedWorkspaceState,
  getPreservedWorkspaceReopenTarget,
  hasRestoredTabBinding,
  markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened,
  markPreservedWorkspaceUnavailable,
  mergeRestorableSessionState,
  recordRestoredTab,
  settleRestoredTab,
  type RestorableSessionPreservation,
  type RestorableWorkspaceRuntimeAuthority,
} from "./app-session-snapshot-merge.ts"
import { reconcileWorkspaceTabs } from "./app-session-reconciliation.ts"

const empty = (): RestorableSessionState => ({ tabs: [], activeTabIndex: -1 })
const session = (
  tabs: RestorableSessionState["tabs"],
  activeTabIndex = tabs.length ? 0 : -1,
): RestorableSessionState => ({ tabs, activeTabIndex })
const workspace = (
  folder: string,
  occurrence = 0,
  state: Partial<RestorableWorkspaceTabState> = {},
): RestorableWorkspaceTabState => ({
  kind: "workspace", folder, occurrence, drafts: {}, attachments: {}, scrollSnapshots: {},
  unseenIdleSince: {}, generationRecovery: {}, ...state,
})
const sidecar = (sidecarId: string) => ({ kind: "sidecar" as const, sidecarId })
const attachment = (id = "paste", path?: string): RestorableAttachment => ({
  id, type: path ? "file" : "text", display: id, url: "", filename: `${id}.txt`, mediaType: "text/plain",
  source: path ? { type: "file", path, mime: "text/plain" } : { type: "text", value: `${id} content` },
})
const scroll = (scrollTop: number, updatedAt = 1) => ({ scrollTop, atBottom: false, updatedAt })

function restored(
  saved: RestorableSessionState,
  mappings: readonly { source: number; runtime?: string | null; unavailable?: readonly string[]; pending?: boolean }[] = [],
): RestorableSessionPreservation {
  const preservation = createRestorableSessionPreservation(saved)
  for (const mapping of mappings) {
    recordRestoredTab(
      preservation,
      mapping.source,
      mapping.runtime ?? null,
      mapping.pending ? undefined : new Set(mapping.unavailable),
    )
  }
  return preservation
}

function workspaceAt(state: RestorableSessionState, index = 0): RestorableWorkspaceTabState {
  const tab = state.tabs[index]
  assert.equal(tab?.kind, "workspace", `tab ${index} should be a workspace`)
  if (tab?.kind !== "workspace") throw new Error(`tab ${index} is not a workspace`)
  return tab
}

const labels = (state: RestorableSessionState) => state.tabs.map((tab) =>
  tab.kind === "workspace" ? `${tab.folder}:${tab.occurrence}` : tab.sidecarId)
const mergeOne = (
  savedTab: RestorableWorkspaceTabState,
  currentTab = workspace(savedTab.folder, savedTab.occurrence),
  authority?: RestorableWorkspaceRuntimeAuthority,
) => workspaceAt(mergeRestorableSessionState(
  session([currentTab]),
  createRestorableSessionPreservation(session([savedTab])),
  { currentTabIds: ["instance:work"], currentTabAuthorities: [authority] },
))

describe("app session snapshot merge", () => {
  it("retains the latest restored tab state after a non-authoritative stop", () => {
    const saved = session([workspace("/work", 0, { drafts: { missing: "saved", current: "old" } })])
    const preservation = restored(saved, [{ source: 0, runtime: "instance:work" }])
    markPreservedWorkspaceUnavailable(
      preservation,
      { runtimeTabId: "instance:work", folder: "/work", occurrence: 0 },
      workspace("/work", 0, { drafts: { current: "latest unsent draft" } }),
    )
    const merged = mergeRestorableSessionState(empty(), preservation, { currentTabIds: [] })
    assert.deepEqual(workspaceAt(merged).drafts, { missing: "saved", current: "latest unsent draft" })
    assert.equal(getPreservedWorkspaceState(
      preservation,
      { runtimeTabId: "instance:other", folder: "/work", occurrence: 0 },
    ), null, "a different runtime cannot claim prompts by folder occurrence alone")
  })

  it("retains missing sessions, transient tabs, and new runtime tabs", () => {
    const savedFile = attachment("path-file", "/work/a/notes.txt")
    const saved = session([
      workspace("/work/a", 0, {
        activeParentSessionId: "missing", activeSessionId: "missing",
        drafts: { missing: "saved draft" }, attachments: { missing: [savedFile] },
        scrollSnapshots: { missing: scroll(42) },
      }),
      sidecar("transient"), sidecar("deleted"), workspace("/work/b"),
    ], 1)
    const preservation = restored(saved, [
      { source: 0, unavailable: ["missing"] }, { source: 2 }, { source: 3 },
    ])
    const merged = mergeRestorableSessionState(session([
      workspace("/work/a", 0, { drafts: { visible: "current draft" } }),
      workspace("/work/b"), sidecar("new-runtime-tab"),
    ], 2), preservation)

    assert.deepEqual(labels(merged), ["/work/a:0", "transient", "/work/b:0", "new-runtime-tab"])
    assert.equal(merged.activeTabIndex, 3)
    const tab = workspaceAt(merged)
    assert.deepEqual(tab.drafts, { missing: "saved draft", visible: "current draft" })
    assert.deepEqual(tab.attachments.missing, [savedFile], "path-backed payload survives")
    assert.deepEqual(tab.scrollSnapshots.missing, scroll(42), "missing-session scroll is seeded")
    assert.deepEqual([tab.activeParentSessionId, tab.activeSessionId], ["missing", "missing"])
  })

  it("backfills failed hydration without replacing current metadata or user mutations", () => {
    const savedFile = attachment("paste")
    const saved = session([
      workspace("/failed", 0, {
        projectName: "saved metadata", activeParentSessionId: "unsaved", activeSessionId: "unsaved",
        drafts: { unsaved: "[paste]", live: "stale" }, attachments: { unsaved: [savedFile] },
        scrollSnapshots: { unsaved: scroll(37) },
      }),
      workspace("/restored"),
    ])
    const merged = mergeRestorableSessionState(
      session([workspace("/restored"), workspace("/failed", 0, {
        projectName: "current metadata", drafts: { live: "current draft" },
      })]),
      restored(saved, [{ source: 1, runtime: "instance:restored" }]),
      { currentTabIds: ["instance:restored", "instance:failed"] },
    )

    assert.deepEqual(labels(merged), ["/restored:0", "/failed:0"])
    const tab = workspaceAt(merged, 1)
    assert.equal(tab.projectName, "current metadata")
    assert.deepEqual(tab.drafts, { unsaved: "[paste]", live: "current draft" })
    assert.deepEqual(tab.attachments.unsaved, [savedFile])
    assert.equal(tab.scrollSnapshots.unsaved?.scrollTop, 37)
    assert.deepEqual([tab.activeParentSessionId, tab.activeSessionId], ["unsaved", "unsaved"])
  })

  it("retains payload records at persistence budget boundaries", () => {
    const drafts = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`draft-${index}`, `value-${index}`]))
    const scrollSnapshots = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [`scroll-${index}`, scroll(index)]))
    const tab = mergeOne(workspace("/budget", 0, {
      drafts, scrollSnapshots, attachments: { path: [attachment("large-path", "/budget/large.bin")] },
    }))
    assert.equal(Object.keys(tab.drafts).length, 24, "draft limit remains intact")
    assert.equal(Object.keys(tab.scrollSnapshots).length, 96, "per-tab scroll limit remains intact")
    assert.equal(tab.attachments.path?.[0]?.source.type, "file", "path payload remains intact")
  })

  for (const testCase of [
    { label: "draft cleared by user", field: "drafts" as const, saved: { missing: "saved" }, owned: "missing" },
    { label: "last attachment removed", field: "attachments" as const, saved: { missing: [attachment()] }, owned: "missing" },
    { label: "idle marker seen", field: "unseenIdleSince" as const, saved: { seen: 1_000 }, authority: "idleMarkers" as const, owned: "seen" },
    { label: "generation recovery cleared", field: "generationRecovery" as const, saved: { resumed: "working" as const }, owned: "resumed" },
  ]) {
    it(`does not resurrect preserved state after authoritative ${testCase.label}`, () => {
      const authorityField = testCase.authority ?? testCase.field
      const tab = mergeOne(
        workspace("/work", 0, { [testCase.field]: testCase.saved }),
        workspace("/work"),
        { [authorityField]: new Set([testCase.owned]) },
      )
      assert.deepEqual(tab[testCase.field], {}, `${testCase.field} should remain cleared`)
    })
  }

  it("removes every record and selection for a remotely deleted session", () => {
    const tab = mergeOne(workspace("/work", 0, {
      activeParentSessionId: "deleted", activeSessionId: "deleted", drafts: { deleted: "draft" },
      attachments: { deleted: [attachment()] }, scrollSnapshots: { deleted: scroll(42) },
      unseenIdleSince: { deleted: 1_000 }, generationRecovery: { deleted: "working" },
    }), workspace("/work"), { deletedSessions: new Set(["deleted"]) })
    assert.deepEqual({
      drafts: tab.drafts, attachments: tab.attachments, scrolls: tab.scrollSnapshots,
      idle: tab.unseenIdleSince, recovery: tab.generationRecovery,
    }, { drafts: {}, attachments: {}, scrolls: {}, idle: {}, recovery: {} })
    assert.deepEqual([tab.activeParentSessionId, tab.activeSessionId], [undefined, undefined])
  })

  it("preserves only unavailable idle and recovery records after partial restore", () => {
    const saved = session([workspace("/work", 0, {
      unseenIdleSince: { missing: 1_000, loaded: 2_000 },
      generationRecovery: { missing: "working", loaded: "interrupted" },
    })])
    const merged = mergeRestorableSessionState(
      session([workspace("/work")]),
      restored(saved, [{ source: 0, runtime: "instance:work", unavailable: ["missing"] }]),
      { currentTabIds: ["instance:work"], currentTabAuthorities: [{
        idleMarkers: new Set(["loaded"]), generationRecovery: new Set(["loaded"]),
      }] },
    )
    const tab = workspaceAt(merged)
    assert.deepEqual(tab.unseenIdleSince, { missing: 1_000 })
    assert.deepEqual(tab.generationRecovery, { missing: "working" })
  })

  it("keeps all authoritative current nested values over preserved values", () => {
    const tab = mergeOne(
      workspace("/work", 0, {
        drafts: { id: "saved" }, attachments: { id: [attachment("saved")] },
        scrollSnapshots: { id: scroll(10) }, generationRecovery: { id: "working" },
      }),
      workspace("/work", 0, {
        drafts: { id: "current" }, attachments: { id: [attachment("current")] },
        scrollSnapshots: { id: scroll(90, 2) }, generationRecovery: { id: "interrupted" },
      }),
      { drafts: new Set(["id"]), attachments: new Set(["id"]), scrollSnapshots: new Set(["id"]),
        generationRecovery: new Set(["id"]) },
    )
    assert.equal(tab.drafts.id, "current")
    assert.equal(tab.attachments.id?.[0]?.id, "current")
    assert.equal(tab.scrollSnapshots.id?.scrollTop, 90)
    assert.equal(tab.generationRecovery.id, "interrupted")
  })

  for (const testCase of [
    { label: "later parent/child selection", current: { activeParentSessionId: "current-parent", activeSessionId: "current-child" },
      expected: ["current-parent", "current-child"] },
    { label: "current info selection", current: { activeSessionId: "info" }, expected: [undefined, "info"] },
    { label: "untouched runtime selection", current: {}, expected: ["missing-parent", "missing-child"] },
  ]) {
    it(`handles user selection during restore: ${testCase.label}`, () => {
      const saved = session([workspace("/work", 0, {
        activeParentSessionId: "missing-parent", activeSessionId: "missing-child",
      })])
      const merged = mergeRestorableSessionState(
        session([workspace("/work", 0, testCase.current)]),
        restored(saved, [{ source: 0, runtime: "instance:work", unavailable: ["missing-parent", "missing-child"] }]),
        { currentTabIds: ["instance:work"] },
      )
      const tab = workspaceAt(merged)
      assert.deepEqual([tab.activeParentSessionId, tab.activeSessionId], testCase.expected)
    })
  }

  it("keeps unresolved and partial payloads until a reopened workspace is actually restored", () => {
    const saved = session([workspace("/failed", 0, { drafts: { missing: "retry", loaded: "discard" } })])
    let preservation = createRestorableSessionPreservation(saved)
    assert.equal(mergeRestorableSessionState(empty(), preservation).tabs.length, 1, "transient absence retained")
    preservation = markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:failed", folder: "/failed", occurrence: 0,
    })
    assert.deepEqual(mergeRestorableSessionState(empty(), preservation), empty(), "explicit close tombstones")
    preservation = markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:reopened", folder: "/failed", occurrence: 0,
    })
    assert.equal(mergeRestorableSessionState(empty(), preservation).tabs.length, 1, "reopen clears tombstone")
    assert.equal(preservation.results[0]?.runtimeTabId, "instance:reopened", "reopen binds the new runtime")
    recordRestoredTab(preservation, 0, "instance:partial", new Set(["missing"]))
    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:partial", folder: "/failed", occurrence: 0,
    })
    const partial = workspaceAt(mergeRestorableSessionState(session([workspace("/failed")]), preservation, {
      currentTabIds: ["instance:reopened"],
    }))
    assert.deepEqual(partial.drafts, { missing: "retry" }, "reopen retains unavailable payload")
  })

  it("rebinds preserved state when a workspace runtime is reopened", () => {
    const preservation = restored(session([workspace("/work")]), [{ source: 0, runtime: "instance:reused" }])
    assert.equal(preservation.results[0]?.runtimeTabId, "instance:reused")
    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:reused", folder: "/work", occurrence: 0,
    })
    assert.equal(preservation.results[0]?.runtimeTabId, "instance:reused")
  })

  it("hydrates only a genuine unavailable or removed workspace reopen", () => {
    const preservation = createRestorableSessionPreservation(session([workspace("/work")]))
    const opened = { runtimeTabId: "instance:new", folder: "/work", occurrence: 0 }
    assert.equal(getPreservedWorkspaceReopenTarget(preservation, opened), null, "initial restore create owns hydration")
    recordRestoredTab(preservation, 0, "instance:old")
    assert.equal(getPreservedWorkspaceReopenTarget(preservation, opened)?.sourceIndex, 0)
  })

  it("does not seed or settle after an explicit close during hydration", async () => {
    const preservation = createRestorableSessionPreservation(session([workspace("/work")]))
    recordRestoredTab(preservation, 0, "instance:hydrating")
    let resume!: () => void
    const hydration = new Promise<void>((resolve) => { resume = resolve })
    const effects: string[] = []
    const completion = (async () => {
      await hydration
      if (!hasRestoredTabBinding(preservation, 0, "instance:hydrating")) return
      effects.push("seed", "release", "select")
      settleRestoredTab(preservation, 0, "instance:hydrating", "instance:hydrating", new Set())
    })()

    markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:hydrating", folder: "/work", occurrence: 0,
    })
    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:reopened", folder: "/work", occurrence: 0,
    })
    resume()
    await completion

    assert.deepEqual(effects, [])
    assert.deepEqual(preservation.results[0], { status: "pending", runtimeTabId: "instance:reopened" })
  })

  it("invalidates a pending create commit after close even when the workspace reopens", () => {
    const preservation = createRestorableSessionPreservation(session([workspace("/work")]))
    const canCommit = createRestoredTabCommitGuard(preservation, 0)

    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:restore-event", folder: "/work", occurrence: 0,
    })
    assert.equal(canCommit(), true, "restore creation events do not invalidate their own response")

    markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:restore-event", folder: "/work", occurrence: 0,
    })
    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:user-reopened", folder: "/work", occurrence: 0,
    })
    assert.equal(canCommit(), false, "a late response cannot overwrite the close authority")
  })

  it("compare-and-set settlement cannot overwrite removed or rebound authority", () => {
    const preservation = createRestorableSessionPreservation(session([workspace("/work")]))
    recordRestoredTab(preservation, 0, "instance:old")
    markPreservedWorkspaceRemoved(preservation, {
      runtimeTabId: "instance:old", folder: "/work", occurrence: 0,
    })
    assert.equal(settleRestoredTab(preservation, 0, "instance:old", "instance:old", new Set()), false)
    assert.equal(settleRestoredTab(preservation, 0, "instance:old", null), false)
    assert.deepEqual(preservation.results[0], { status: "removed" })

    markPreservedWorkspaceReopened(preservation, {
      runtimeTabId: "instance:new", folder: "/work", occurrence: 0,
    })
    recordRestoredTab(preservation, 0, "instance:new")
    assert.equal(settleRestoredTab(preservation, 0, "instance:old", null), false)
    assert.deepEqual(preservation.results[0], { status: "pending", runtimeTabId: "instance:new" })
    assert.equal(settleRestoredTab(preservation, 0, "instance:new", "instance:new", new Set()), true)
    assert.equal(preservation.results[0]?.status, "restored")
  })

  it("does not duplicate recovered or authoritatively deleted sidecars", () => {
    const recovered = session([sidecar("preview"), sidecar("new")])
    assert.deepEqual(
      mergeRestorableSessionState(recovered, createRestorableSessionPreservation(session([sidecar("preview")]))),
      recovered,
    )
    const deleted = restored(session([sidecar("deleted")]), [{ source: 0 }])
    assert.deepEqual(mergeRestorableSessionState(empty(), deleted), empty())
  })

  for (const testCase of [
    { label: "restored tabs reordered", current: [workspace("/b"), workspace("/a")], ids: ["instance:b", "instance:a"], active: 0 },
    { label: "new tab interleaved", current: [workspace("/a"), sidecar("new"), workspace("/b")],
      ids: ["instance:a", "sidecar:new", "instance:b"], active: 1 },
  ]) {
    it(`keeps current layout: ${testCase.label}`, () => {
      const saved = session([workspace("/a"), workspace("/b")])
      const preservation = restored(saved, [
        { source: 0, runtime: "instance:a" }, { source: 1, runtime: "instance:b" },
      ])
      const current = session(testCase.current, testCase.active)
      assert.deepEqual(mergeRestorableSessionState(current, preservation, { currentTabIds: testCase.ids }), current)
    })
  }

  it("keeps current active tabs while shifting around unresolved source tabs", () => {
    const currentTabs = [workspace("/a"), workspace("/b")]
    const mapped = restored(session(currentTabs), [
      { source: 0, runtime: "instance:a", unavailable: ["missing"] },
      { source: 1, runtime: "instance:b" },
    ])
    const options = { currentTabIds: ["instance:a", "instance:b"] }
    assert.equal(mergeRestorableSessionState(session(currentTabs, 0), mapped, options).activeTabIndex, 0)
    assert.equal(mergeRestorableSessionState(session(currentTabs, 1), mapped, options).activeTabIndex, 1)

    const unresolved = restored(session([sidecar("unresolved"), ...currentTabs]), [
      { source: 1, runtime: "instance:a" }, { source: 2, runtime: "instance:b" },
    ])
    assert.equal(mergeRestorableSessionState(session(currentTabs, 0), unresolved, options).activeTabIndex, 1)
    assert.equal(mergeRestorableSessionState(session(currentTabs, 1), unresolved, options).activeTabIndex, 2)
  })

  it("maps the saved active source tab while startup capture has no active tab", () => {
    const saved = session([workspace("/a"), workspace("/b"), workspace("/c")], 2)
    const preservation = restored(saved, [
      { source: 0, runtime: "instance:a", pending: true },
      { source: 1, runtime: "instance:b", pending: true },
      { source: 2, runtime: "instance:c", pending: true },
    ])
    const merged = mergeRestorableSessionState(session(saved.tabs, -1), preservation, {
      currentTabIds: ["instance:a", "instance:b", "instance:c"],
    })
    assert.equal(merged.activeTabIndex, 2)
  })

  it("retains saved session IDs during a sub-debounce startup flush unless selection is authoritative", () => {
    const saved = session([workspace("/work", 0, {
      activeParentSessionId: "saved-parent", activeSessionId: "saved-child",
    })])
    const preservation = restored(saved, [{ source: 0, runtime: "instance:work", pending: true }])
    const startup = session([workspace("/work")])
    const beforeDebounce = mergeRestorableSessionState(startup, preservation, {
      currentTabIds: ["instance:work"], currentTabAuthorities: [{ sessionSelection: false }],
    })
    assert.deepEqual(
      [workspaceAt(beforeDebounce).activeParentSessionId, workspaceAt(beforeDebounce).activeSessionId],
      ["saved-parent", "saved-child"],
    )
    const cleared = mergeRestorableSessionState(startup, preservation, {
      currentTabIds: ["instance:work"], currentTabAuthorities: [{ sessionSelection: true }],
    })
    assert.deepEqual([workspaceAt(cleared).activeParentSessionId, workspaceAt(cleared).activeSessionId], [undefined, undefined])
  })

  it("inserts an unresolved tab beside its nearest restored source neighbor", () => {
    const saved = session([workspace("/a"), sidecar("unresolved"), workspace("/b")], 1)
    const preservation = restored(saved, [
      { source: 0, runtime: "instance:a" }, { source: 2, runtime: "instance:b" },
    ])
    const merged = mergeRestorableSessionState(session([workspace("/a"), workspace("/b")], 1), preservation, {
      currentTabIds: ["instance:a", "instance:b"],
    })
    assert.deepEqual(labels(merged), ["/a:0", "unresolved", "/b:0"])
    assert.equal(merged.activeTabIndex, 2)
  })

  it("maps duplicate folders atomically and follows runtime reorder", () => {
    const saved = session([
      workspace("/same", 0, { drafts: { first: "source first" } }),
      workspace("/same", 1, { drafts: { second: "source second" } }),
      workspace("/same", 2),
    ])
    const preservation = restored(saved, [
      { source: 0, runtime: "instance:first", pending: true },
      { source: 1, runtime: "instance:second", pending: true },
      { source: 2, runtime: "instance:last", pending: true },
    ])
    assert.deepEqual(preservation.results.map((result) => result.runtimeTabId), [
      "instance:first", "instance:second", "instance:last",
    ], "all duplicate bindings are recorded before close events")
    const reordered = mergeRestorableSessionState(
      session([workspace("/same", 1), workspace("/same", 0), workspace("/same", 2)]),
      preservation,
      { currentTabIds: ["instance:second", "instance:first", "instance:last"] },
    )
    assert.equal(workspaceAt(reordered, 0).drafts.second, "source second")
    assert.equal(workspaceAt(reordered, 1).drafts.first, "source first")
  })

  it("tombstones duplicate folders independently in either close order", () => {
    for (const order of [[0, 1], [1, 0]]) {
      const saved = session([
        workspace("/same", 0, { drafts: { first: "first" } }),
        workspace("/same", 1, { drafts: { second: "second" } }),
      ])
      const preservation = restored(saved, [
        { source: 0, runtime: "instance:first", pending: true },
        { source: 1, runtime: "instance:second", pending: true },
      ])
      for (const source of order) markPreservedWorkspaceRemoved(preservation, {
        runtimeTabId: `instance:${source ? "second" : "first"}`, folder: "/same", occurrence: source,
      })
      assert.equal(mergeRestorableSessionState(empty(), preservation).tabs.length, 0, `close order ${order.join(",")}`)
    }
  })

  it("retains mapped duplicates during transient absence and only the uncertain remaining source", () => {
    const saved = session([
      workspace("/same", 0, { drafts: { first: "first source" } }),
      workspace("/same", 1, { drafts: { second: "uncertain source" } }),
    ])
    const absent = restored(saved, [
      { source: 0, runtime: "instance:first", pending: true },
      { source: 1, runtime: "instance:second", pending: true },
    ])
    assert.equal(mergeRestorableSessionState(empty(), absent).tabs.length, 2)

    const uncertain = createRestorableSessionPreservation(saved)
    markPreservedWorkspaceRemoved(uncertain, { runtimeTabId: "unknown:first", folder: "/same", occurrence: 0 })
    markPreservedWorkspaceRemoved(uncertain, { runtimeTabId: "unknown:second", folder: "/same", occurrence: 0 })
    const merged = mergeRestorableSessionState(empty(), uncertain)
    assert.equal(merged.tabs.length, 1)
    assert.equal(workspaceAt(merged).drafts.second, "uncertain source")
  })

  it("does not relaunch a closed duplicate after occurrences renumber", () => {
    const saved = session([
      workspace("/same", 0), workspace("/same", 1, { drafts: { missing: "preserve" } }),
    ], 1)
    const preservation = restored(saved, [
      { source: 0, runtime: "instance:first" },
      { source: 1, runtime: "instance:second", unavailable: ["missing"] },
    ])
    const merged = mergeRestorableSessionState(
      session([workspace("/same", 0, { drafts: { current: "captured" } })]),
      preservation,
      { currentTabIds: ["instance:second"] },
    )
    assert.equal(merged.tabs.length, 1)
    assert.deepEqual(workspaceAt(merged).drafts, { missing: "preserve", current: "captured" })
    assert.deepEqual(reconcileWorkspaceTabs(
      [{ kind: "workspace", folderPath: "/same", occurrence: 0 }],
      [{ id: "second", folderPath: "/same" }],
    ).map((match) => match.existingWorkspaceId), ["second"])
  })

  it("assigns unresolved duplicate a distinct occurrence and reconciliation slot", () => {
    const saved = session([
      workspace("/same", 0, { drafts: { failed: "retry" } }),
      workspace("/same", 1, { drafts: { restored: "saved" } }),
    ], 1)
    const merged = mergeRestorableSessionState(
      session([workspace("/same", 0, { drafts: { current: "captured" } })]),
      restored(saved, [{ source: 1, runtime: "instance:second" }]),
      { currentTabIds: ["instance:second"] },
    )
    assert.deepEqual(labels(merged), ["/same:1", "/same:0"])
    assert.equal(workspaceAt(merged, 0).drafts.failed, "retry")
    const matches = reconcileWorkspaceTabs(
      merged.tabs.map((tab) => tab.kind === "workspace"
        ? { kind: "workspace", folderPath: tab.folder, occurrence: tab.occurrence }
        : { kind: "sidecar" }),
      [{ id: "second", folderPath: "/same" }],
    )
    assert.deepEqual(matches.map((match) => match.existingWorkspaceId), [null, "second"])
    assert.equal(matches.filter((match) => !match.existingWorkspaceId).length, 1)
  })
})
