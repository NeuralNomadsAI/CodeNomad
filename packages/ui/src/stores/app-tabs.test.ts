import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import type { Instance } from "../types/instance.ts"
import {
  activeAppTabId,
  appTabs,
  attachInstanceTab,
  closeInstanceTab,
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
import { addInstance, instances, removeInstance, stopInstance, updateInstance } from "./instances.ts"
import { serverEvents } from "../lib/server-events.ts"

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

  it("closes locally without deleting and does not resurrect a reused id", () => {
    const workspace = instance("local-close")
    const originalDelete = serverApi.deleteWorkspace
    let deletes = 0
    serverApi.deleteWorkspace = async () => { deletes += 1 }
    addInstance(workspace)
    try {
      selectInstanceTab(workspace.id)
      closeInstanceTab(workspace.id)
      assert.equal(instances().has(workspace.id), true)
      assert.equal(appTabs().some((tab) => tab.id === `instance:${workspace.id}`), false)
      assert.equal(deletes, 0)

      removeInstance(workspace.id)
      selectInstanceTab(workspace.id)
      addInstance(instance(workspace.id))
      assert.equal(appTabs().some((tab) => tab.id === `instance:${workspace.id}`), false)
    } finally {
      serverApi.deleteWorkspace = originalDelete
      removeInstance(workspace.id, { authoritative: false })
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

  it("selects the adjacent reordered local tab before an authoritative stop removes the catalog member", () => {
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
    } finally {
      for (const candidate of [closed, stopped, left, right]) removeInstance(candidate.id, { authoritative: false })
    }
  })

  it("uses explicit stop as the delete path and retains state when delete fails", async () => {
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
      const first = stopInstance(workspace.id)
      const second = stopInstance(workspace.id)
      assert.equal(first, second)
      await assert.rejects(first, /stop failed/)
      assert.equal(deletes, 1)
      assert.equal(instances().has(workspace.id), true)
      assert.equal(appTabs().some((tab) => tab.id === `instance:${workspace.id}`), true)

      serverApi.deleteWorkspace = async () => { deletes += 1 }
      await stopInstance(workspace.id)
      assert.equal(deletes, 2)
    } finally {
      serverApi.deleteWorkspace = originalDelete
      removeInstance(workspace.id, { authoritative: false })
    }
  })
})
