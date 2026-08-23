import assert from "node:assert/strict"
import { it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { hydrateRestoredWorkspaceState } from "./app-session-workspace-hydration.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import {
  clearInstanceDraftPrompts,
  clearInstanceSessionSelection,
  getSessionDraftPrompt,
  setSessions,
} from "./session-state.ts"

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
    }, controller.signal, () => true).then((value) => { settled = true; return value })

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(getSessionDraftPrompt(instanceId, "active"), "active draft")
    assert.equal(getSessionDraftPrompt(instanceId, "inactive"), "")

    inactive.resolve(apiSession("inactive"))
    assert.deepEqual(await hydration, new Set(["stale"]))
    assert.equal(getSessionDraftPrompt(instanceId, "inactive"), "inactive draft")
    assert.equal(signals.length, 2)
    assert.equal(signals.every((signal) => signal === controller.signal), true)
  } finally {
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    clearInstanceDraftPrompts(instanceId)
    clearInstanceSessionSelection(instanceId)
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
