import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createFileAttachment, createTextAttachment } from "../types/attachment.ts"
import {
  addAttachment, clearInstanceAttachments, getAttachments, hydrateSessionAttachments, removeAttachment,
  getAuthoritativeAttachmentSessionIdsForInstance,
} from "./attachments.ts"
import { addInstance, clearReloadableInstanceState, removeInstance } from "./instances.ts"
import {
  activeParentSessionId, activeSessionId, clearActiveParentSession, clearInstanceDraftPromptValues,
  clearInstanceDraftPrompts, clearInstanceDeletedSessionAuthority, clearInstanceSessionSelection,
  clearSessionDraftPrompt, getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance, getSessionDraftPromptsForInstance,
  hasAuthoritativeSessionSelection, hydrateActiveSessionSelection, hydrateSessionDraftPrompt,
  setActiveParentSession, setActiveSession, setSessions, setSessionDraftPrompt,
} from "./session-state.ts"
import { removeSessionRuntimeState } from "./session-api.ts"
import { handleSessionDeleted } from "./session-events.ts"
import {
  createRestorableSessionPreservation, markPreservedWorkspaceRemoved, markPreservedWorkspaceReopened,
  mergeRestorableSessionState, recordRestoredTab,
} from "./app-session-snapshot-merge.ts"
import type { RestorableWorkspaceTabState } from "./client-state-codec.ts"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority.ts"

const absent = { tabs: [], activeTabIndex: -1 }
function workspace(state: Partial<RestorableWorkspaceTabState> = {}): RestorableWorkspaceTabState {
  return { kind: "workspace", folder: "/work", occurrence: 0, drafts: {}, attachments: {},
    scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {}, ...state }
}
function instance(id: string, folder = "/work", status: "ready" | "error" = "ready") {
  return { id, folder, port: 0, pid: 0, proxyPath: "", status, client: null }
}
function clearSessionState(instanceId: string) {
  clearInstanceAttachments(instanceId)
  clearInstanceDraftPrompts(instanceId)
  clearInstanceDeletedSessionAuthority(instanceId)
  clearInstanceSessionSelection(instanceId)
  setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
}
function selectParentAndChild(instanceId: string) {
  const parent = { id: "parent", instanceId, parentId: null, title: "Parent", status: "idle" }
  const child = { id: "child", instanceId, parentId: "parent", title: "Child", status: "idle" }
  setSessions((previous) => new Map(previous).set(instanceId, new Map<string, any>([["parent", parent], ["child", child]])))
  setActiveParentSession(instanceId, "parent")
  setActiveSession(instanceId, "child")
}
function preservationHarness(tabs: RestorableWorkspaceTabState[]) {
  let value = createRestorableSessionPreservation({ tabs, activeTabIndex: 0 })
  const stop = onInstanceLifecycleAuthority((event) => {
    const descriptor = { runtimeTabId: `instance:${event.instanceId}`, folder: event.folder, occurrence: event.occurrence }
    value = event.type === "removed"
      ? markPreservedWorkspaceRemoved(value, descriptor)
      : markPreservedWorkspaceReopened(value, descriptor)
  })
  return {
    get value() { return value },
    map(sourceIndex: number, instanceId: string, unavailable?: ReadonlySet<string>) {
      recordRestoredTab(value, sourceIndex, `instance:${instanceId}`, unavailable)
    },
    close() { stop() },
  }
}

describe("instance runtime authority", () => {
  it("preserves pasted and file attachments with prompt content during rehydration cleanup", () => {
    const id = "rehydrate-unsent-attachments", sessionId = "draft-session"
    const pasted = createTextAttachment("pasted body", "pasted #1 (4 lines)", "paste-1.txt")
    const file = createFileAttachment("/work/notes.txt", "notes.txt", "text/plain", new TextEncoder().encode("notes"))
    addAttachment(id, sessionId, pasted); addAttachment(id, sessionId, file)
    setSessionDraftPrompt(id, sessionId, "Review [pasted #1] and @notes.txt")
    clearReloadableInstanceState(id)
    assert.equal(getSessionDraftPromptsForInstance(id)[sessionId], "Review [pasted #1] and @notes.txt")
    assert.deepEqual(getAttachments(id, sessionId), [pasted, file])
    clearSessionState(id)
  })

  for (const test of [
    { label: "direct definitive session removal", remove: removeSessionRuntimeState },
    { label: "session.deleted event", remove: (id: string, sessionId: string) => handleSessionDeleted(id,
      { type: "session.deleted", properties: { info: { id: sessionId } } }) },
  ]) it(`removes attachment authority on ${test.label}`, () => {
    const id = `authority-${test.label}`, sessionId = "deleted-session"
    addAttachment(id, sessionId, createTextAttachment("pasted", "pasted #1", "paste.txt"))
    setSessionDraftPrompt(id, sessionId, "[pasted #1]")
    test.remove(id, sessionId)
    assert.deepEqual(getAttachments(id, sessionId), [])
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(id).has(sessionId), false)
    assert.equal(getSessionDraftPromptsForInstance(id)[sessionId], undefined)
    assert.equal(getAuthoritativelyDeletedSessionIdsForInstance(id).has(sessionId), true)
    clearSessionState(id)
  })

  for (const test of [
    { label: "retained parent when active child is deleted", deleted: "child", parent: "parent", active: "parent" },
    { label: "no selection when selected parent is deleted", deleted: "parent", parent: undefined, active: undefined },
  ] as const) it(`selects ${test.label}`, () => {
    const id = `selection-${test.deleted}`
    selectParentAndChild(id)
    removeSessionRuntimeState(id, test.deleted)
    assert.equal(activeParentSessionId().get(id), test.parent)
    assert.equal(activeSessionId().get(id), test.active)
    clearSessionState(id)
  })

  it("tombstones failed hydration only after removal and reopens it as pending", () => {
    const id = "failed-hydration-removal"
    const harness = preservationHarness([workspace({ folder: "/failed", drafts: { missing: "retry me" } })])
    addInstance(instance(id, "/failed", "error")); harness.map(0, id)
    try {
      assert.equal(mergeRestorableSessionState(absent, harness.value).tabs.length, 1)
      removeInstance(id)
      assert.equal(mergeRestorableSessionState(absent, harness.value).tabs.length, 0)
      assert.equal(harness.value.results[0]?.status, "removed")
      addInstance(instance(`${id}-reopened`, "/failed"))
      assert.equal(mergeRestorableSessionState(absent, harness.value).tabs.length, 1)
      assert.equal(harness.value.results[0]?.status, "pending")
    } finally {
      harness.close(); removeInstance(id, { authoritative: false }); removeInstance(`${id}-reopened`, { authoritative: false })
    }
  })

  it("tombstones each mapped failed-hydration duplicate after sequential closes", () => {
    const ids = ["duplicate-first", "duplicate-second"]
    const harness = preservationHarness(ids.map((id, occurrence) =>
      workspace({ folder: "/duplicate", occurrence, drafts: { [id]: `retry ${id}` } })))
    ids.forEach((id, index) => { addInstance(instance(id, "/duplicate", "error")); harness.map(index, id) })
    try {
      ids.forEach((id) => removeInstance(id))
      assert.deepEqual(mergeRestorableSessionState(absent, harness.value), absent)
      assert.deepEqual(harness.value.results.map(({ status }) => status), ["removed", "removed"])
    } finally { harness.close(); ids.forEach((id) => removeInstance(id, { authoritative: false })) }
  })

  for (const closeOrder of [["middle", "last"], ["last", "middle"]] as const) {
    it(`keeps source zero across occurrence renumbering when closing ${closeOrder.join(" then ")}`, () => {
      const ids = { first: `three-first-${closeOrder[0]}`, middle: `three-middle-${closeOrder[0]}`, last: `three-last-${closeOrder[0]}` }
      const harness = preservationHarness([
        workspace({ folder: "/three", occurrence: 0, drafts: { first: "keep open" } }),
        workspace({ folder: "/three", occurrence: 1, drafts: { middle: "close middle" } }),
        workspace({ folder: "/three", occurrence: 2, drafts: { last: "close last" } }),
      ])
      Object.values(ids).forEach((id, index) => { addInstance(instance(id, "/three", "error")); harness.map(index, id) })
      try {
        closeOrder.forEach((position) => removeInstance(ids[position]))
        assert.deepEqual(harness.value.results.flatMap((result, index) => result.status === "removed" ? [index] : []), [1, 2])
        const merged = mergeRestorableSessionState(
          { tabs: [workspace({ folder: "/three" })], activeTabIndex: 0 }, harness.value,
          { currentTabIds: [`instance:${ids.first}`] },
        )
        const drafts = merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts : {}
        assert.deepEqual(drafts, { first: "keep open" })
      } finally { harness.close(); Object.values(ids).forEach((id) => removeInstance(id, { authoritative: false })) }
    })
  }

  it("retains an explicit draft-clear tombstone through rehydrate value cleanup", () => {
    const id = "draft-rehydrate-authority", sessionId = "missing-session"
    const preserved = createRestorableSessionPreservation({
      tabs: [workspace({ drafts: { [sessionId]: "preserved draft" } })], activeTabIndex: 0,
    })
    hydrateSessionDraftPrompt(id, sessionId, "restored draft"); clearSessionDraftPrompt(id, sessionId); clearInstanceDraftPromptValues(id)
    const authority = getAuthoritativeDraftSessionIdsForInstance(id)
    assert.equal(authority.has(sessionId), true)
    assert.deepEqual(getSessionDraftPromptsForInstance(id), {})
    const merged = mergeRestorableSessionState({ tabs: [workspace()], activeTabIndex: 0 }, preserved,
      { currentTabIds: [`instance:${id}`], currentTabAuthorities: [{ drafts: authority }] })
    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts : undefined, {})
    clearInstanceDraftPrompts(id)
    assert.equal(getAuthoritativeDraftSessionIdsForInstance(id).has(sessionId), false)
  })

  it("keeps an explicitly closed selection at none and clears authority on final removal", () => {
    const id = "selection-close-authority"
    addInstance(instance(id))
    const preserved = createRestorableSessionPreservation({ tabs: [workspace({
      activeParentSessionId: "missing-parent", activeSessionId: "missing-child",
    })], activeTabIndex: 0 })
    recordRestoredTab(preserved, 0, `instance:${id}`, new Set(["missing-parent", "missing-child"]))
    hydrateActiveSessionSelection(id, null, null)
    assert.equal(hasAuthoritativeSessionSelection(id), false)
    setActiveParentSession(id, "current-session"); clearActiveParentSession(id)
    hydrateActiveSessionSelection(id, "missing-parent", "missing-child")
    assert.equal(activeParentSessionId().has(id), false); assert.equal(activeSessionId().has(id), false)
    assert.equal(hasAuthoritativeSessionSelection(id), true)
    const merged = mergeRestorableSessionState({ tabs: [workspace()], activeTabIndex: 0 }, preserved,
      { currentTabIds: [`instance:${id}`], currentTabAuthorities: [{ sessionSelection: true }] })
    const tab = merged.tabs[0]
    assert.equal(tab?.kind === "workspace" ? tab.activeParentSessionId : undefined, undefined)
    assert.equal(tab?.kind === "workspace" ? tab.activeSessionId : undefined, undefined)
    clearSessionDraftPrompt(id, "removed-session")
    const attachment = createTextAttachment("removed", "pasted #1", "removed.txt")
    hydrateSessionAttachments(id, "removed-session", [attachment]); removeAttachment(id, "removed-session", attachment.id)
    removeInstance(id)
    assert.equal(hasAuthoritativeSessionSelection(id), false)
    assert.equal(getAuthoritativeDraftSessionIdsForInstance(id).size, 0)
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(id).size, 0)
  })

  it("marks info selection as authoritative without restore hydration doing so", () => {
    const id = "info-selection-authority"
    hydrateActiveSessionSelection(id, null, "info")
    assert.equal(hasAuthoritativeSessionSelection(id), false)
    setActiveSession(id, "info")
    assert.equal(hasAuthoritativeSessionSelection(id), true)
    clearInstanceSessionSelection(id)
  })
})
