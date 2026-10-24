import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import toast from "solid-toast"
import { HttpResponseError } from "../lib/retryable-file-search"

import { serverApi } from "../lib/api-client.ts"
import type { Instance } from "../types/instance.ts"
import {
  activeAppTabId,
  appTabs,
  attachInstanceTab,
  closeInstanceTab,
  detachInstanceTab,
  setAppTabOrder,
  selectInstanceTab,
} from "./app-tabs.ts"
import {
  createRestorableSessionPreservation,
  markPreservedWorkspaceRemoved,
  markPreservedWorkspaceReopened,
  mergeRestorableSessionState,
  recordRestoredTab,
} from "./app-session-snapshot-merge.ts"
import type { RestorableSessionState, RestorableWorkspaceTabState } from "./client-state-codec.ts"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority.ts"
import { releaseAppSessionRestoreGate } from "./app-session-restore-gate"
import { acknowledgeDisconnectedInstance, addInstance, disconnectedInstance, getExistingInstanceForFolder, instances, removeInstance, updateInstance } from "./instances.ts"
import { sseManager } from "../lib/sse-manager"
import { clearToastHistory, getToastHistory } from "../lib/notifications.tsx"
import { tGlobal } from "../lib/i18n"
import { serverEvents } from "../lib/server-events.ts"
import { createTextAttachment } from "../types/attachment.ts"
import { getAttachments, hydrateSessionAttachments } from "./attachments.ts"
import {
  activeSessionId,
  getSessionDraftPrompt,
  setActiveSession,
  setSessionDraftPrompt,
  setSessions,
} from "./session-state.ts"

function instance(id: string): Instance {
  return {
    id,
    folder: `/${id}`,
    port: 0,
    pid: 0,
    proxyPath: `/workspaces/${id}`,
    status: "starting",
    client: null,
    environmentVariables: {},
  }
}

function workspace(folder: string): RestorableWorkspaceTabState {
  return {
    kind: "workspace", folder, occurrence: 0, drafts: {}, attachments: {}, scrollSnapshots: {},
    unseenIdleSince: {}, generationRecovery: {},
  }
}

function captureTabs(): RestorableSessionState {
  const tabs = appTabs().map((tab) => tab.kind === "instance"
    ? workspace(tab.instance.folder)
    : { kind: "sidecar" as const, sidecarId: tab.sidecarTab.sidecarId })
  return { tabs, activeTabIndex: appTabs().findIndex((tab) => tab.id === activeAppTabId()) }
}

describe("renderer-local workspace tabs", () => {
  const originalDelete = serverApi.deleteWorkspace
  const originalToast = toast.custom
  beforeEach(() => {
    releaseAppSessionRestoreGate()
    serverApi.deleteWorkspace = async () => {}
    clearToastHistory()
    toast.custom = () => "test-toast"
  })
  afterEach(() => { serverApi.deleteWorkspace = originalDelete; toast.custom = originalToast })
  it("keeps catalog additions and updates closed until explicitly attached", () => {
    const first = instance("catalog-first")
    const second = instance("catalog-second")
    addInstance(first)
    addInstance(second)
    try {
      updateInstance(first.id, { projectName: "Updated" })
      assert.deepEqual(appTabs().filter((tab) => tab.kind === "instance"), [])

      attachInstanceTab(first.id)
      assert.deepEqual(appTabs().map((tab) => tab.id), [`instance:${first.id}`])

      selectInstanceTab(second.id)
      assert.deepEqual(new Set(appTabs().map((tab) => tab.id)), new Set([`instance:${first.id}`, `instance:${second.id}`]))
    } finally {
      removeInstance(first.id, { authoritative: false })
      removeInstance(second.id, { authoritative: false })
    }
  })

  it("closes immediately, deletes once and leaves another occurrence of the folder alone", async () => {
    const workspace = instance("local-close")
    const originalDelete = serverApi.deleteWorkspace
    let deletes = 0
    serverApi.deleteWorkspace = async () => { deletes += 1 }
    addInstance(workspace)
    const other = { ...instance("other-occurrence"), folder: workspace.folder }
    addInstance(other)
    attachInstanceTab(other.id)
    try {
      selectInstanceTab(workspace.id)
      closeInstanceTab(workspace.id)
      closeInstanceTab(workspace.id)
      assert.equal(instances().has(workspace.id), true)
      assert.equal(appTabs().some((tab) => tab.id === `instance:${workspace.id}`), false)
      await Promise.resolve()
      assert.equal(deletes, 1)
      assert.ok(instances().has(other.id))
      assert.ok(appTabs().some((tab) => tab.id === `instance:${other.id}`))
      assert.equal(activeAppTabId(), `instance:${other.id}`)

      removeInstance(workspace.id)
      selectInstanceTab(workspace.id)
      addInstance(instance(workspace.id))
      assert.equal(appTabs().some((tab) => tab.id === `instance:${workspace.id}`), false)
    } finally {
      serverApi.deleteWorkspace = originalDelete
      removeInstance(workspace.id, { authoritative: false })
      removeInstance(other.id, { authoritative: false })
    }
  })

  it("restores only explicitly attached window membership", () => {
    const first = instance("restore-first")
    const second = instance("restore-second")
    addInstance(first)
    addInstance(second)
    try {
      attachInstanceTab(second.id)
      assert.deepEqual(appTabs().filter((tab) => tab.kind === "instance").map((tab) => tab.instance.id), [second.id])

      removeInstance(second.id)
      assert.equal(appTabs().some((tab) => tab.id === `instance:${second.id}`), false)
    } finally {
      removeInstance(first.id, { authoritative: false })
      removeInstance(second.id, { authoritative: false })
    }
  })

  it("publishes unavailable while the tab and unsaved session state are still capturable", () => {
    const workspace = instance("unavailable-capture-order")
    const sessionId = "draft-session"
    const attachment = createTextAttachment("latest attachment", "pasted #1", "paste.txt")
    let captured: unknown
    addInstance(workspace)
    selectInstanceTab(workspace.id)
    setSessions((previous) => new Map(previous).set(workspace.id, new Map([[sessionId, {
      id: sessionId, instanceId: workspace.id, parentId: null, title: "Draft", status: "idle",
    } as any]])))
    setActiveSession(workspace.id, sessionId)
    setSessionDraftPrompt(workspace.id, sessionId, "latest draft")
    hydrateSessionAttachments(workspace.id, sessionId, [attachment])
    const stopListening = onInstanceLifecycleAuthority((event) => {
      if (event.type !== "unavailable" || event.instanceId !== workspace.id) return
      captured = {
        tabPresent: appTabs().some((tab) => tab.id === `instance:${workspace.id}`),
        draft: getSessionDraftPrompt(workspace.id, sessionId),
        attachments: getAttachments(workspace.id, sessionId),
        selection: activeSessionId().get(workspace.id),
      }
    })

    try {
      removeInstance(workspace.id, { authoritative: false })
      assert.deepEqual(captured, {
        tabPresent: true,
        draft: "latest draft",
        attachments: [attachment],
        selection: sessionId,
      })
    } finally {
      stopListening()
      removeInstance(workspace.id, { authoritative: false })
    }
  })

  it("keeps a locally closed restored binding out of capture until explicit reopen", () => {
    const restored = instance("restored-local-close")
    const saved: RestorableSessionState = { tabs: [workspace(restored.folder)], activeTabIndex: 0 }
    const preservation = createRestorableSessionPreservation(saved)
    recordRestoredTab(preservation, 0, `instance:${restored.id}`, new Set())
    const stopListening = onInstanceLifecycleAuthority((event) => {
      if (event.instanceId !== restored.id) return
      const binding = { runtimeTabId: `instance:${event.instanceId}`, folder: event.folder, occurrence: event.occurrence }
      if (event.type === "removed") markPreservedWorkspaceRemoved(preservation, binding)
      if (event.type === "opened") markPreservedWorkspaceReopened(preservation, binding)
    })
    addInstance(restored)
    attachInstanceTab(restored.id, { source: "restore" })
    try {
      closeInstanceTab(restored.id)
      assert.equal(mergeRestorableSessionState(captureTabs(), preservation, { currentTabIds: [] }).tabs.length, 0)

      selectInstanceTab(restored.id)
      assert.equal(mergeRestorableSessionState(captureTabs(), preservation, {
        currentTabIds: [`instance:${restored.id}`],
      }).tabs.length, 1)
    } finally {
      stopListening()
      removeInstance(restored.id, { authoritative: false })
    }
  })

  it("selects the adjacent reordered local tab before an authoritative stop removes the catalog member", async () => {
    const closed = instance("stopped-closed-catalog")
    const stopped = instance("stopped-active")
    const left = instance("stopped-left")
    const right = instance("stopped-right")
    for (const candidate of [closed, stopped, left, right]) addInstance(candidate)
    try {
      for (const candidate of [left, stopped, right]) attachInstanceTab(candidate.id)
      setAppTabOrder([`instance:${right.id}`, `instance:${stopped.id}`, `instance:${left.id}`])
      selectInstanceTab(stopped.id)

      const dispatch = serverEvents as unknown as { dispatch(event: { type: "workspace.stopped"; workspaceId: string; reason: "deleted" }): void }
      dispatch.dispatch({ type: "workspace.stopped", workspaceId: stopped.id, reason: "deleted" })

      assert.equal(activeAppTabId(), `instance:${right.id}`)
      assert.deepEqual(appTabs().map((tab) => tab.id), [`instance:${right.id}`, `instance:${left.id}`])
      assert.equal(instances().has(closed.id), true)
      // Its state clears only after the event batch has unmounted the tab.
      assert.equal(instances().has(stopped.id), true)
      await Promise.resolve()
      assert.equal(instances().has(stopped.id), false)
      assert.equal(getToastHistory()[0]?.message, tGlobal("app.closeInstance.toast.otherWindow", { project: "stopped-active" }))
    } finally {
      for (const candidate of [closed, stopped, left, right]) removeInstance(candidate.id, { authoritative: false })
    }
  })

  it("reports a failed close, keeps its record reachable and never retries automatically", async () => {
    const workspace = instance("failed-stop")
    const originalDelete = serverApi.deleteWorkspace
    let deletes = 0
    serverApi.deleteWorkspace = async () => {
      deletes += 1
      throw new Error("stop failed")
    }
    addInstance(workspace)
    selectInstanceTab(workspace.id)
    try {
      closeInstanceTab(workspace.id)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(deletes, 1)
      assert.equal(instances().has(workspace.id), true)
      assert.equal(appTabs().some((tab) => tab.id === `instance:${workspace.id}`), false)
      assert.equal(getExistingInstanceForFolder(workspace.folder)?.id, workspace.id)
      assert.equal(getToastHistory()[0]?.message, tGlobal("app.closeInstance.toast.error"))

      serverApi.deleteWorkspace = async () => { deletes += 1 }
      selectInstanceTab(workspace.id)
      closeInstanceTab(workspace.id)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(deletes, 2)
    } finally {
      serverApi.deleteWorkspace = originalDelete
      removeInstance(workspace.id, { authoritative: false })
    }
  })

  it("does not notify the initiating window or delete again on its stop event", async () => {
    const workspace = instance("initiated-close")
    addInstance(workspace)
    selectInstanceTab(workspace.id)
    let deletes = 0
    serverApi.deleteWorkspace = async () => {
      deletes += 1
      ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: workspace.id, reason: "deleted" })
    }
    try {
      closeInstanceTab(workspace.id)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(deletes, 1)
      assert.deepEqual(getToastHistory(), [])
      assert.equal(instances().has(workspace.id), false)
    } finally { removeInstance(workspace.id, { authoritative: false }) }
  })

  for (const outcome of ["success", "failure", "timeout", "5xx"] as const) {
    it(`remembers a local close after DELETE ${outcome}, reattachment and a delayed stop`, async () => {
      const workspace = instance(`delayed-close-${outcome}`)
      let deletes = 0
      serverApi.deleteWorkspace = async () => {
        deletes += 1
        if (outcome === "5xx") throw new HttpResponseError("cleanup failed", 503, null)
        if (outcome !== "success") throw new Error(outcome === "timeout" ? "cleanup did not finish" : "delete failed")
      }
      addInstance(workspace)
      selectInstanceTab(workspace.id)
      try {
        closeInstanceTab(workspace.id)
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(deletes, 1)
        assert.equal(getExistingInstanceForFolder(workspace.folder)?.id, workspace.id)
        assert.equal(getToastHistory().length, outcome === "success" ? 0 : 1)
        clearToastHistory()
        selectInstanceTab(workspace.id)
        ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: workspace.id, reason: "deleted" })
        await Promise.resolve()
        assert.equal(instances().has(workspace.id), false)
        assert.equal(appTabs().some(tab => tab.id === `instance:${workspace.id}`), false)
        assert.equal(deletes, 1)
        assert.deepEqual(getToastHistory(), [])
      } finally { removeInstance(workspace.id, { authoritative: false }) }
    })
  }

  it("clears local close origin on instance removal so a later foreign close notifies", async () => {
    const workspace = instance("removed-close-origin")
    addInstance(workspace)
    selectInstanceTab(workspace.id)
    try {
      closeInstanceTab(workspace.id)
      await new Promise((resolve) => setImmediate(resolve))
      removeInstance(workspace.id, { authoritative: false })
      addInstance(workspace)
      selectInstanceTab(workspace.id)
      ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: workspace.id, reason: "deleted" })
      await Promise.resolve()
      assert.equal(getToastHistory()[0]?.message,
        tGlobal("app.closeInstance.toast.otherWindow", { project: "removed-close-origin" }))
    } finally { removeInstance(workspace.id, { authoritative: false }) }
  })

  for (const priorUncertainClose of [false, true]) {
    it(`reconciles a 401 refusal on the same record (prior uncertain close: ${priorUncertainClose})`, async () => {
      const workspace = instance(`refused-close-${priorUncertainClose}`)
      addInstance(workspace)
      selectInstanceTab(workspace.id)
      try {
        if (priorUncertainClose) {
          serverApi.deleteWorkspace = async () => { throw new TypeError("network unavailable") }
          closeInstanceTab(workspace.id)
          await new Promise((resolve) => setImmediate(resolve))
          selectInstanceTab(workspace.id)
        }
        serverApi.deleteWorkspace = async () => { throw new HttpResponseError("Unauthorized", 401, null) }
        closeInstanceTab(workspace.id)
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(instances().get(workspace.id), workspace)
        selectInstanceTab(workspace.id)
        clearToastHistory()
        ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: workspace.id, reason: "deleted" })
        await Promise.resolve()
        assert.equal(getToastHistory().length, priorUncertainClose ? 0 : 1)
        if (!priorUncertainClose) assert.equal(getToastHistory()[0]?.message,
          tGlobal("app.closeInstance.toast.otherWindow", { project: `refused-close-${priorUncertainClose}` }))
      } finally { removeInstance(workspace.id, { authoritative: false }) }
    })
  }

  it("does not notify for shutdown or for records not displayed in this window", async () => {
    for (const [id, reason, attached] of [["shutdown", "stopped", true], ["hidden", "deleted", false]] as const) {
      addInstance(instance(id))
      if (attached) attachInstanceTab(id)
      ;(serverEvents as any).dispatch({ type: "workspace.stopped", workspaceId: id, reason })
      await Promise.resolve()
      assert.deepEqual(getToastHistory(), [])
      removeInstance(id, { authoritative: false })
    }
  })

  it("keeps disconnected-dialog dismissal local without issuing another delete", async () => {
    const workspace = instance("disconnected")
    let deletes = 0
    serverApi.deleteWorkspace = async () => { deletes += 1 }
    addInstance(workspace)
    selectInstanceTab(workspace.id)
    try {
      sseManager.onConnectionLost?.(workspace.id, "unavailable")
      assert.equal(disconnectedInstance()?.id, workspace.id)
      await acknowledgeDisconnectedInstance()
      detachInstanceTab(workspace.id)
      assert.equal(disconnectedInstance(), null)
      assert.equal(appTabs().length, 0)
      assert.equal(deletes, 0)
    } finally { removeInstance(workspace.id, { authoritative: false }) }
  })
})
