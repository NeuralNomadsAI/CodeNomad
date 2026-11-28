import assert from "node:assert/strict"
import { it } from "node:test"
import { setImmediate } from "node:timers/promises"
import { createRoot, createSignal } from "solid-js"
import { useSessionCache } from "./useSessionCache.ts"
import { messageStoreBus } from "../../../stores/message-v2/bus.ts"
import { sessions, setSessions, loading, setLoading } from "../../../stores/session-state.ts"
import { SESSION_TRANSCRIPT_BYTE_BUDGET } from "../../../stores/session-transcript-memory.ts"
import { reconcileSessionTranscriptBudget } from "../../../stores/session-transcript-memory.ts"
import { createBackendClient, registerBackendClient } from "../../../lib/backend-client.ts"
import { backendEvents } from "../../../lib/backend-events.ts"
import { isSessionTranscriptVisible } from "../../../stores/session-transcript-visibility.ts"
import { addInstance, removeInstance } from "../../../stores/instances.ts"

it("keeps a visible over-budget transcript pinned across catalogue and loading changes, then releases it on hide", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const instanceId = "cache-visible-lifetime", sessionId = "selected"
  const previousSessions = sessions(), previousLoading = loading()
  addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: {} as any })
  const session = { id: sessionId, instanceId, title: "Selected", parentId: null, status: "idle" } as any
  setSessions(prev => new Map(prev).set(instanceId, new Map([[sessionId, session]])))
  const store = messageStoreBus.getOrCreate(instanceId)
  // Exercise the real queue/coordinator without allocating a large payload.
  store.estimateSessionRetainedBytes = async () => SESSION_TRANSCRIPT_BYTE_BUDGET + 1
  store.upsertMessage({ id: "message", sessionId, role: "assistant", status: "complete" })
  const [active, setActive] = createSignal(true)
  let dispose = () => {}
  try {
    createRoot(done => {
      dispose = done
      useSessionCache({ instanceId: () => instanceId, activeSessionId: () => sessionId,
        isActiveInstance: active, instanceSessions: () => sessions().get(instanceId)! })
    })
    // Advance the measurement quiet window, then drain its async accounting.
    t.mock.timers.tick(500)
    await setImmediate()
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["message"])
    setSessions(prev => new Map(prev).set(instanceId, new Map([[sessionId, { ...session, title: "Renamed" }]])))
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["message"])
    setLoading(prev => ({ ...prev, loadingMessages: new Map(prev.loadingMessages).set(instanceId, new Set(["other"])) }))
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["message"])
    setActive(false)
    assert.equal(store.getMessage("message"), undefined)
    assert.deepEqual(store.getSessionMessageIds(sessionId), [])
  } finally {
    dispose()
    messageStoreBus.unregisterInstance(instanceId)
    removeInstance(instanceId, { authoritative: false })
    setSessions(previousSessions)
    setLoading(previousLoading)
  }
})

it("releases memory protection on revoke and reacquires a retained view on the new attachment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const backend = createBackendClient({ id: "cache_owner", baseUrl: "http://cache.invalid", fetcher: async () => { throw new Error("unexpected IO") } })
  const unregister = registerBackendClient(backend)
  let detach = backendEvents.attach(backend.id, backend.events)
  const instanceId = "cache_owner~ws", sessionId = "selected", previous = sessions()
  addInstance({ id: instanceId, backendId: backend.id, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: {} as any })
  const session = { id: sessionId, instanceId, title: "Selected", parentId: null, status: "idle" } as any
  setSessions(prev => new Map(prev).set(instanceId, new Map([[sessionId, session]])))
  const store = messageStoreBus.getOrCreate(instanceId)
  store.estimateSessionRetainedBytes = async () => SESSION_TRANSCRIPT_BYTE_BUDGET + 1
  store.upsertMessage({ id: "message", sessionId, role: "assistant", status: "complete" })
  let dispose = () => {}
  try {
    createRoot(done => {
      dispose = done
      useSessionCache({ instanceId: () => instanceId, activeSessionId: () => sessionId,
        isActiveInstance: () => true, instanceSessions: () => sessions().get(instanceId)! })
    })
    t.mock.timers.tick(500)
    await setImmediate()
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["message"])
    detach()
    assert.equal(isSessionTranscriptVisible(instanceId, sessionId), false)
    reconcileSessionTranscriptBudget()
    assert.deepEqual(store.getSessionMessageIds(sessionId), [], "a revoked lease cannot protect the LRU")
    detach = backendEvents.attach(backend.id, backend.events)
    assert.equal(isSessionTranscriptVisible(instanceId, sessionId), true, "a retained view reacquires only the new attachment")
    store.upsertMessage({ id: "new-message", sessionId, role: "assistant", status: "complete" })
    t.mock.timers.tick(500)
    await setImmediate()
    assert.deepEqual(store.getSessionMessageIds(sessionId), ["new-message"])
    dispose(); dispose()
    assert.equal(isSessionTranscriptVisible(instanceId, sessionId), false)
  } finally {
    dispose(); detach(); backend.events.dispose(); unregister()
    messageStoreBus.unregisterInstance(instanceId); removeInstance(instanceId, { authoritative: false }); setSessions(previous)
  }
})
