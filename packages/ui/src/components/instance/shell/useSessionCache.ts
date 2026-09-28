import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import {
  reconcileSessionTranscriptBudget,
  setSessionTranscriptVisible,
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
  createEffect(on([options.instanceId, visibleSessionId], ([instanceId, sessionId]) => {
    if (!sessionId) return
    setSessionTranscriptVisible(instanceId, sessionId, true)
    onCleanup(() => setSessionTranscriptVisible(instanceId, sessionId, false))
  }))

  onCleanup(() => {
    reconcileSessionTranscriptBudget()
  })

  return {
    cachedSessionIds,
  }
}
