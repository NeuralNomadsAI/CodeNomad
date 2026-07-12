import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createFileAttachment, createTextAttachment } from "../types/attachment.ts"
import {
  addAttachment,
  clearInstanceAttachments,
  getAuthoritativeAttachmentSessionIdsForInstance,
  getAttachments,
  hydrateSessionAttachments,
  removeAttachment,
} from "./attachments.ts"
import { addInstance, clearReloadableInstanceState, removeInstance } from "./instances.ts"
import {
  activeParentSessionId,
  activeSessionId,
  clearActiveParentSession,
  clearInstanceDraftPromptValues,
  clearInstanceDraftPrompts,
  clearInstanceDeletedSessionAuthority,
  clearInstanceSessionSelection,
  clearSessionDraftPrompt,
  getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance,
  getSessionDraftPromptsForInstance,
  hasAuthoritativeSessionSelection,
  hydrateActiveSessionSelection,
  hydrateSessionDraftPrompt,
  setActiveParentSession,
  setActiveSession,
  setSessionDraftPrompt,
} from "./session-state.ts"
import { removeSessionRuntimeState } from "./session-api.ts"
import { handleSessionDeleted } from "./session-events.ts"
import {
  createRestorableSessionPreservation,
  mapRestoredWorkspace,
  mapRestoredWorkspaces,
  markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened,
  markRestoredTab,
  mergeRestorableSessionState,
} from "./app-session-snapshot-merge.ts"
import type { RestorableWorkspaceTabState } from "./client-state-codec.ts"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority.ts"

function workspace(state: Partial<RestorableWorkspaceTabState> = {}): RestorableWorkspaceTabState {
  return {
    kind: "workspace",
    folder: "/work",
    occurrence: 0,
    drafts: {},
    attachments: {},
    scrollSnapshots: {},
    unseenIdleSince: {},
    generationRecovery: {},
    sessionStatuses: {},
    expandedSessionIds: [],
    ...state,
  }
}

describe("instance runtime authority", () => {
  it("preserves pasted and file attachments with prompt content during rehydration cleanup", () => {
    const instanceId = "rehydrate-unsent-attachments"
    const sessionId = "draft-session"
    const pasted = createTextAttachment("pasted body", "pasted #1 (4 lines)", "paste-1.txt")
    const file = createFileAttachment("/work/notes.txt", "notes.txt", "text/plain", new TextEncoder().encode("notes"))
    const prompt = "Review [pasted #1] and @notes.txt"

    addAttachment(instanceId, sessionId, pasted)
    addAttachment(instanceId, sessionId, file)
    setSessionDraftPrompt(instanceId, sessionId, prompt)

    clearReloadableInstanceState(instanceId)

    assert.equal(getSessionDraftPromptsForInstance(instanceId)[sessionId], prompt)
    assert.deepEqual(getAttachments(instanceId, sessionId), [pasted, file])

    clearInstanceAttachments(instanceId)
    clearInstanceDraftPrompts(instanceId)
  })

  it("removes attachment payloads and attachment authority on definitive session removal", () => {
    const instanceId = "definitive-session-removal"
    const sessionId = "deleted-session"
    addAttachment(instanceId, sessionId, createTextAttachment("pasted", "pasted #1 (4 lines)", "paste.txt"))
    addAttachment(
      instanceId,
      sessionId,
      createFileAttachment("/work/file.txt", "file.txt", "text/plain", new TextEncoder().encode("file")),
    )
    setSessionDraftPrompt(instanceId, sessionId, "[pasted #1] @file.txt")

    removeSessionRuntimeState(instanceId, sessionId)

    assert.deepEqual(getAttachments(instanceId, sessionId), [])
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(instanceId).has(sessionId), false)
    assert.equal(getSessionDraftPromptsForInstance(instanceId)[sessionId], undefined)
    assert.equal(getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId), true)

    clearInstanceAttachments(instanceId)
    clearInstanceDraftPrompts(instanceId)
    clearInstanceDeletedSessionAuthority(instanceId)
  })

  it("applies definitive session cleanup for session.deleted events", () => {
    const instanceId = "session-deleted-event"
    const sessionId = "event-session"
    addAttachment(instanceId, sessionId, createTextAttachment("event paste", "pasted #1 (4 lines)", "paste.txt"))

    handleSessionDeleted(instanceId, {
      type: "session.deleted",
      properties: { info: { id: sessionId } },
    })

    assert.deepEqual(getAttachments(instanceId, sessionId), [])
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(instanceId).has(sessionId), false)
    assert.equal(getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId), true)

    clearInstanceAttachments(instanceId)
    clearInstanceDraftPrompts(instanceId)
    clearInstanceDeletedSessionAuthority(instanceId)
  })

  it("tombstones failed hydration preservation only after explicit instance removal", () => {
    const instanceId = "failed-hydration-removal"
    let preservation = createRestorableSessionPreservation({
      tabs: [workspace({ folder: "/failed", drafts: { missing: "retry me" } })],
      activeTabIndex: 0,
    })
    const stop = onInstanceLifecycleAuthority((event) => {
      const descriptor = {
        runtimeTabId: `instance:${event.instanceId}`,
        folder: event.folder,
        occurrence: event.occurrence,
      }
      preservation = event.type === "removed"
        ? markPreservedWorkspaceRemoved(preservation, descriptor)
        : markPreservedWorkspaceReopened(preservation, descriptor)
    })

    addInstance({
      id: instanceId,
      folder: "/failed",
      port: 0,
      pid: 0,
      proxyPath: "",
      status: "error",
      client: null,
    })
    preservation = mapRestoredWorkspace(preservation, 0, `instance:${instanceId}`)

    try {
      const absent = { tabs: [], activeTabIndex: -1 }
      assert.equal(mergeRestorableSessionState(absent, preservation).tabs.length, 1)

      removeInstance(instanceId)
      assert.equal(mergeRestorableSessionState(absent, preservation).tabs.length, 0)
      assert.equal(preservation.restoredWorkspaceSourceIndexes.size, 0)

      addInstance({
        id: `${instanceId}-reopened`,
        folder: "/failed",
        port: 0,
        pid: 0,
        proxyPath: "",
        status: "ready",
        client: null,
      })
      assert.equal(mergeRestorableSessionState(absent, preservation).tabs.length, 1)
      assert.equal(preservation.restoredWorkspaceSourceIndexes.size, 0)
    } finally {
      stop()
      removeInstance(instanceId, { authoritative: false })
      removeInstance(`${instanceId}-reopened`, { authoritative: false })
    }
  })

  it("tombstones each mapped failed-hydration duplicate after sequential instance closes", () => {
    const firstId = "failed-hydration-duplicate-first"
    const secondId = "failed-hydration-duplicate-second"
    let preservation = createRestorableSessionPreservation({
      tabs: [
        workspace({ folder: "/duplicate", occurrence: 0, drafts: { first: "retry first" } }),
        workspace({ folder: "/duplicate", occurrence: 1, drafts: { second: "retry second" } }),
      ],
      activeTabIndex: 0,
    })
    const stop = onInstanceLifecycleAuthority((event) => {
      const descriptor = {
        runtimeTabId: `instance:${event.instanceId}`,
        folder: event.folder,
        occurrence: event.occurrence,
      }
      preservation = event.type === "removed"
        ? markPreservedWorkspaceRemoved(preservation, descriptor)
        : markPreservedWorkspaceReopened(preservation, descriptor)
    })

    addInstance({
      id: firstId,
      folder: "/duplicate",
      port: 0,
      pid: 0,
      proxyPath: "",
      status: "error",
      client: null,
    })
    addInstance({
      id: secondId,
      folder: "/duplicate",
      port: 0,
      pid: 0,
      proxyPath: "",
      status: "error",
      client: null,
    })
    preservation = mapRestoredWorkspace(preservation, 0, `instance:${firstId}`)
    preservation = mapRestoredWorkspace(preservation, 1, `instance:${secondId}`)

    try {
      removeInstance(firstId)
      removeInstance(secondId)

      assert.deepEqual(
        mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, preservation),
        { tabs: [], activeTabIndex: -1 },
      )
      assert.equal(preservation.restoredWorkspaceSourceIndexes.size, 0)
    } finally {
      stop()
      removeInstance(firstId, { authoritative: false })
      removeInstance(secondId, { authoritative: false })
    }
  })

  it("keeps source zero when failed-hydration sources one and two close around occurrence renumbering", () => {
    for (const closeOrder of [["middle", "last"], ["last", "middle"]] as const) {
      const suffix = closeOrder.join("-")
      const ids = {
        first: `failed-hydration-three-first-${suffix}`,
        middle: `failed-hydration-three-middle-${suffix}`,
        last: `failed-hydration-three-last-${suffix}`,
      }
      let preservation = createRestorableSessionPreservation({
        tabs: [
          workspace({ folder: "/three", occurrence: 0, drafts: { first: "keep open" } }),
          workspace({ folder: "/three", occurrence: 1, drafts: { middle: "close middle" } }),
          workspace({ folder: "/three", occurrence: 2, drafts: { last: "close last" } }),
        ],
        activeTabIndex: 0,
      })
      const stop = onInstanceLifecycleAuthority((event) => {
        const descriptor = {
          runtimeTabId: `instance:${event.instanceId}`,
          folder: event.folder,
          occurrence: event.occurrence,
        }
        preservation = event.type === "removed"
          ? markPreservedWorkspaceRemoved(preservation, descriptor)
          : markPreservedWorkspaceReopened(preservation, descriptor)
      })

      for (const id of [ids.first, ids.middle, ids.last]) {
        addInstance({
          id,
          folder: "/three",
          port: 0,
          pid: 0,
          proxyPath: "",
          status: "error",
          client: null,
        })
      }
      preservation = mapRestoredWorkspaces(preservation, [
        { sourceIndex: 0, runtimeTabId: `instance:${ids.first}` },
        { sourceIndex: 1, runtimeTabId: `instance:${ids.middle}` },
        { sourceIndex: 2, runtimeTabId: `instance:${ids.last}` },
      ])

      try {
        for (const position of closeOrder) removeInstance(ids[position])

        assert.deepEqual([...preservation.removedWholeTabIndexes].sort(), [1, 2])
        const merged = mergeRestorableSessionState(
          { tabs: [workspace({ folder: "/three", occurrence: 0 })], activeTabIndex: 0 },
          preservation,
          { currentTabIds: [`instance:${ids.first}`] },
        )
        assert.equal(merged.tabs.length, 1)
        assert.equal(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts.first : undefined, "keep open")
        assert.equal(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts.middle : undefined, undefined)
        assert.equal(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts.last : undefined, undefined)
      } finally {
        stop()
        removeInstance(ids.first, { authoritative: false })
        removeInstance(ids.middle, { authoritative: false })
        removeInstance(ids.last, { authoritative: false })
      }
    }
  })

  it("retains an explicit draft-clear tombstone through rehydrate value cleanup", () => {
    const instanceId = "draft-rehydrate-authority"
    const sessionId = "missing-session"
    const preservation = createRestorableSessionPreservation({
      tabs: [workspace({ drafts: { [sessionId]: "preserved draft" } })],
      activeTabIndex: 0,
    })

    hydrateSessionDraftPrompt(instanceId, sessionId, "restored draft")
    clearSessionDraftPrompt(instanceId, sessionId)
    clearInstanceDraftPromptValues(instanceId)

    const authority = getAuthoritativeDraftSessionIdsForInstance(instanceId)
    assert.equal(authority.has(sessionId), true)
    assert.deepEqual(getSessionDraftPromptsForInstance(instanceId), {})

    const merged = mergeRestorableSessionState(
      { tabs: [workspace()], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: [`instance:${instanceId}`],
        currentTabAuthorities: [{ drafts: authority }],
      },
    )
    assert.deepEqual(merged.tabs[0]?.kind === "workspace" ? merged.tabs[0].drafts : undefined, {})

    clearInstanceDraftPrompts(instanceId)
    assert.equal(getAuthoritativeDraftSessionIdsForInstance(instanceId).has(sessionId), false)
  })

  it("keeps an explicitly closed selection at none and clears authority on final removal", () => {
    const instanceId = "selection-close-authority"
    addInstance({
      id: instanceId,
      folder: "/work",
      port: 0,
      pid: 0,
      proxyPath: "",
      status: "ready",
      client: null,
    })
    const preservation = markRestoredTab(
      createRestorableSessionPreservation({
        tabs: [workspace({
          activeParentSessionId: "missing-parent",
          activeSessionId: "missing-child",
        })],
        activeTabIndex: 0,
      }),
      0,
      new Set(["missing-parent", "missing-child"]),
      `instance:${instanceId}`,
    )

    hydrateActiveSessionSelection(instanceId, null, null)
    assert.equal(hasAuthoritativeSessionSelection(instanceId), false)

    setActiveParentSession(instanceId, "current-session")
    clearActiveParentSession(instanceId)
    hydrateActiveSessionSelection(instanceId, "missing-parent", "missing-child")
    assert.equal(activeParentSessionId().has(instanceId), false)
    assert.equal(activeSessionId().has(instanceId), false)
    assert.equal(hasAuthoritativeSessionSelection(instanceId), true)

    const merged = mergeRestorableSessionState(
      { tabs: [workspace()], activeTabIndex: 0 },
      preservation,
      {
        currentTabIds: [`instance:${instanceId}`],
        currentTabAuthorities: [{ sessionSelection: hasAuthoritativeSessionSelection(instanceId) }],
      },
    )
    const tab = merged.tabs[0]
    assert.equal(tab?.kind === "workspace" ? tab.activeParentSessionId : undefined, undefined)
    assert.equal(tab?.kind === "workspace" ? tab.activeSessionId : undefined, undefined)

    clearSessionDraftPrompt(instanceId, "removed-session")
    const attachment = createTextAttachment("removed", "pasted #1 (1 line)", "removed.txt")
    hydrateSessionAttachments(instanceId, "removed-session", [attachment])
    removeAttachment(instanceId, "removed-session", attachment.id)

    removeInstance(instanceId)
    assert.equal(hasAuthoritativeSessionSelection(instanceId), false)
    assert.equal(getAuthoritativeDraftSessionIdsForInstance(instanceId).size, 0)
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(instanceId).size, 0)
  })

  it("marks info selection as authoritative without restore hydration doing so", () => {
    const instanceId = "info-selection-authority"
    hydrateActiveSessionSelection(instanceId, null, "info")
    assert.equal(hasAuthoritativeSessionSelection(instanceId), false)

    setActiveSession(instanceId, "info")
    assert.equal(hasAuthoritativeSessionSelection(instanceId), true)

    clearInstanceSessionSelection(instanceId)
  })
})
