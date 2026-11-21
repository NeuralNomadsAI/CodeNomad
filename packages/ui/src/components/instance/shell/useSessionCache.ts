import { createEffect, createMemo, onCleanup, untrack, type Accessor } from "solid-js"
import { captureBackendOperation } from "../../../lib/backend-operation"
import { instances } from "../../../stores/instances"
import {
  reconcileSessionTranscriptBudget,
  setSessionTranscriptVisible,
  sessionTranscriptBinding,
} from "../../../stores/session-transcript-memory"

type SessionCacheOptions = {
  instanceId: Accessor<string>
  instanceSessions: Accessor<Map<string, unknown>>
  activeSessionId: Accessor<string | null>
  isActiveInstance: Accessor<boolean>
}

type SessionCacheState = {
  cachedSessionIds: Accessor<string[]>
}

export function useSessionCache(options: SessionCacheOptions): SessionCacheState {
  const visibleSessionId = createMemo(() => {
    const instanceSessions = options.instanceSessions()
    const activeId = options.activeSessionId()
    if (!options.isActiveInstance() || !activeId || activeId === "info" || !instanceSessions.has(activeId)) return null
    return activeId
  })
  const cachedSessionIds = createMemo(() => {
    const sessionId = visibleSessionId()
    return sessionId ? [sessionId] : []
  })

  // Enforcement reads session/loading state. Those reads must not become
  // visibility dependencies and briefly unpin an unchanged visible identity.
  const binding = createMemo(() => {
    const sessionId = visibleSessionId()
    return sessionId ? sessionTranscriptBinding(options.instanceId(), sessionId) : undefined
  })
  const owner = createMemo(() => instances().get(options.instanceId())?.client)
  createEffect(() => {
    const instanceId = options.instanceId(), sessionId = visibleSessionId()
    const client = owner()
    if (!sessionId || !client || !binding()) return
    const operation = captureBackendOperation(instanceId, undefined, () => instances().get(instanceId)?.client === client)
    onCleanup(untrack(() => setSessionTranscriptVisible(instanceId, sessionId, operation)))
  })

  onCleanup(() => {
    reconcileSessionTranscriptBudget()
  })

  return {
    cachedSessionIds,
  }
}
