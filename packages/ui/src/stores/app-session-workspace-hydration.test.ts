import assert from "node:assert/strict"
import { it } from "node:test"
import toast from "solid-toast"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { hydrateRestoredWorkspaceState } from "./app-session-workspace-hydration.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { getTabViewState, updateTabViewState, clearTabViewState } from "./tab-view-state.ts"
import { activeSessionId as selectedSessionId } from "./session-selection-state.ts"
import { beginGesture } from "./session-surface.ts"
import { createFileAttachment } from "../types/attachment"
import { getAttachments, clearAttachments } from "./attachments"
import { serializeDraftAttachments } from "./client-state-attachments-codec"
import { createRestorableSessionPreservation, mergeRestorableSessionState, recordRestoredTab } from "./app-session-snapshot-merge"
import { removeSessionRuntimeState } from "./session-api"
import { recoveredDraftIds, switchRecoveredDraft } from "./session-draft-recovery"
import {
  clearInstanceDraftPrompts,
  clearInstanceSessionSelection,
  activeParentSessionId,
  activeSessionId,
  hasAuthoritativeSessionSelection,
  getSessionDraftPrompt,
  setSessions,
  clearSessionDraftPrompt,
  getSessionDraftPromptsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance,
  getSessionRoot,
  sessions,
} from "./session-state.ts"

it("rechecks each absent draft after a sibling read: a newly listed session survives", async () => {
  const id = "restored-absence-race"
  const originalToast = toast.custom
  toast.custom = () => "recovered"
  const held = deferred<unknown>(), observed = deferred<void>()
  const client = { session: { get: async ({ sessionID }: { sessionID: string }) => {
    if (sessionID === "hold") { observed.resolve(); return held.promise }
    throw { _tag: "SessionNotFoundError", sessionID }
  } } } as any
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  try {
    const restored = hydrateRestoredWorkspaceState(id, {
      kind: "workspace", folder: "/work", scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      ...serializeDraftAttachments({ revived: "still on the session", gone: "recover only this", hold: "held draft" }, {
        revived: [createFileAttachment("revived.bin", "revived.bin", "application/octet-stream", new Uint8Array([77]))],
      }),
    }, new AbortController().signal, () => true)
    await observed.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    setSessions(previous => new Map(previous).set(id, new Map(previous.get(id)).set("revived", {
      ...apiSession("revived"), parentId: null, instanceId: id,
    } as any)))
    held.resolve(apiSession("hold"))
    await restored
    assert.equal(getSessionRoot(id, "revived")?.id, "revived")
    assert.ok(sessions().get(id)?.has("revived"))
    assert.equal(getAuthoritativelyDeletedSessionIdsForInstance(id).has("revived"), false)
    assert.equal(getSessionDraftPrompt(id, "revived"), "still on the session")
    const [file] = getAttachments(id, "revived")
    assert.deepEqual(file.source.type === "file" && Array.from(file.source.data ?? []), [77])
    assert.equal(getSessionDraftPrompt(id, "__no_session_draft__"), "recover only this")
    assert.equal(getAuthoritativelyDeletedSessionIdsForInstance(id).has("gone"), true)
  } finally {
    held.resolve(null)
    removeInstance(id, { drafts: "skip" })
    sdkManager.destroyClientsForInstance(id)
    toast.custom = originalToast
  }
})

it("recovers a not-yet-hydrated draft when deletion arrives before the first checkpoint", async () => {
  const id = "early-deleted-draft"
  const originalToast = toast.custom
  toast.custom = () => "recovered"
  const client = { session: { get: async () => assert.fail("known deletion needs no native lookup") } } as any
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  const snapshot = { kind: "workspace" as const, folder: "/work", scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
    ...serializeDraftAttachments({ __no_session_draft__: "keep the composer", gone: "recover this", cleared: "already cleared" }, {
      gone: [createFileAttachment("proof.bin", "proof.bin", "application/octet-stream", new Uint8Array([3, 0, 253]))],
      cleared: [createFileAttachment("discard.bin", "discard.bin", "application/octet-stream", new Uint8Array([9]))],
    }),
  }
  try {
    clearSessionDraftPrompt(id, "cleared")
    clearAttachments(id, "cleared")
    removeSessionRuntimeState(id, "gone", "observation")
    removeSessionRuntimeState(id, "cleared", "observation")
    const restore = () => hydrateRestoredWorkspaceState(id, snapshot, new AbortController().signal, () => true)
    await restore()
    const preservation = createRestorableSessionPreservation({ tabs: [snapshot], activeTabIndex: 0 })
    recordRestoredTab(preservation, 0, id)
    const captured = { ...snapshot,
      ...serializeDraftAttachments(getSessionDraftPromptsForInstance(id), Object.fromEntries(
        recoveredDraftIds(id).map(key => [key, getAttachments(id, key)]))) }
    const saved = mergeRestorableSessionState({ tabs: [captured], activeTabIndex: 0 }, preservation, {
      currentTabIds: [id], currentTabAuthorities: [{ deletedSessions: getAuthoritativelyDeletedSessionIdsForInstance(id) }],
    }).tabs[0]
    assert.equal(saved.kind, "workspace")
    assert.equal(saved.drafts.gone, undefined)
    assert.equal(saved.drafts.cleared, undefined)
    assert.equal(getSessionDraftPrompt(id, "__no_session_draft__"), "keep the composer")
    const slots = recoveredDraftIds(id)
    assert.equal(slots.length, 1)
    assert.equal(saved.drafts[slots[0]], "recover this")
    assert.equal(saved.attachments[slots[0]][0].source.type, "file")
    await restore()
    assert.deepEqual(recoveredDraftIds(id), slots)
    switchRecoveredDraft(id, slots[0])
    const [file] = getAttachments(id, "__no_session_draft__")
    assert.deepEqual(file.source.type === "file" && Array.from(file.source.data ?? []), [3, 0, 253])
  } finally {
    removeInstance(id, { drafts: "skip" })
    sdkManager.destroyClientsForInstance(id)
    toast.custom = originalToast
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function apiSession(id: string) {
  return {
    id, title: id, projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

it("restores the selected draft before inactive session hydration settles", async () => {
  const instanceId = "selected-draft-first"
  const inactive = deferred<any>()
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  const client = { session: { get: (input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
    if (options?.signal) signals.push(options.signal)
    return input.sessionID === "active" ? Promise.resolve(apiSession("active")) : inactive.promise
  } } } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })

  try {
    let settled = false
    const hydration = hydrateRestoredWorkspaceState(instanceId, {
      kind: "workspace",
      folder: "/work",
      activeParentSessionId: "active",
      activeSessionId: "active",
      drafts: { active: "active draft", inactive: "inactive draft" },
      attachments: {},
      scrollSnapshots: { stale: { scrollTop: 10, maxScrollTop: 50, atBottom: false, updatedAt: 1 } },
      unseenIdleSince: { stale: 1 },
      generationRecovery: { stale: "interrupted" },
      expandedSessionIds: ["stale"],
      viewState: { version: 1, previews: { active: { mode: "preview", targetUrl: "https://example.com/" } },
        rightPanelTab: "files", filesMode: "workspace" },
    }, controller.signal, () => true).then((value) => { settled = true; return value })

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(getSessionDraftPrompt(instanceId, "active"), "active draft")
    assert.equal(getSessionDraftPrompt(instanceId, "inactive"), "")
    assert.equal(getTabViewState(instanceId).previews?.active.targetUrl, "https://example.com/")
    updateTabViewState(instanceId, { previews: { active: { mode: "chat", targetUrl: "https://example.com/" } } })

    inactive.resolve(apiSession("inactive"))
    assert.deepEqual(await hydration, new Set(["stale"]))
    assert.equal(getSessionDraftPrompt(instanceId, "inactive"), "inactive draft")
    assert.equal(signals.length, 2)
    assert.equal(signals.every((signal) => signal === controller.signal), true)
    assert.equal(getTabViewState(instanceId).previews?.active.mode, "chat")
  } finally {
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    clearInstanceDraftPrompts(instanceId)
    clearInstanceSessionSelection(instanceId)
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
    clearTabViewState(instanceId)
  }
})

it("waits for a saved Info selection's parent without claiming user-selection authority", async () => {
  const instanceId = "saved-info-parent"
  const parent = deferred<any>()
  const client = { session: { get: ({ sessionID }: { sessionID: string }) => {
    assert.equal(sessionID, "parent")
    return parent.promise
  } } } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  try {
    const hydration = hydrateRestoredWorkspaceState(instanceId, {
      kind: "workspace", folder: "/work", activeParentSessionId: "parent", activeSessionId: "info",
      drafts: { parent: "saved draft" }, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
    }, new AbortController().signal, () => true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(activeParentSessionId().get(instanceId), "parent")
    assert.equal(activeSessionId().get(instanceId), "info")
    assert.equal(selectedSessionId, activeSessionId, "view stores and session actions share one selection signal")
    assert.equal(selectedSessionId().get(instanceId), "info")
    assert.equal(hasAuthoritativeSessionSelection(instanceId), false)
    const intent = beginGesture({ instanceId, sessionId: "info" })
    assert.equal(intent.current(), true)
    parent.resolve(apiSession("parent"))
    await hydration
    assert.equal(activeSessionId().get(instanceId), "parent")
    assert.equal(selectedSessionId().get(instanceId), "parent")
    assert.equal(intent.current(), true, "passive restoration applies immediately and preserves the gesture generation")
    assert.equal(getSessionDraftPrompt(instanceId, "parent"), "saved draft")
    assert.equal(hasAuthoritativeSessionSelection(instanceId), false)
  } finally {
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    clearInstanceDraftPrompts(instanceId)
    clearInstanceSessionSelection(instanceId)
    setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
