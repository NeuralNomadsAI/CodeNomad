import assert from "node:assert/strict"
import { it } from "node:test"
import { createRoot, createSignal } from "solid-js"
import { useSessionCache } from "./useSessionCache.ts"
import { messageStoreBus } from "../../../stores/message-v2/bus.ts"
import { sessions, setSessions, loading, setLoading } from "../../../stores/session-state.ts"
import { SESSION_TRANSCRIPT_BYTE_BUDGET } from "../../../stores/session-transcript-memory.ts"

it("keeps a visible over-budget transcript pinned across catalogue and loading changes, then releases it on hide", async () => {
  const instanceId = "cache-visible-lifetime", sessionId = "selected"
  const previousSessions = sessions(), previousLoading = loading()
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
    await new Promise(resolve => setTimeout(resolve, 250))
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
    setSessions(previousSessions)
    setLoading(previousLoading)
  }
})
