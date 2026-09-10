import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import {
  reconcileSessionTranscriptBudget,
  setSessionTranscriptVisible,
  touchSessionTranscript,
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
  const cachedSessionIds = createMemo(() => {
    const instanceSessions = options.instanceSessions()
    const activeId = options.activeSessionId()
    if (!options.isActiveInstance() || !activeId || activeId === "info" || !instanceSessions.has(activeId)) return []
    return [activeId]
  })

  createEffect(() => {
    const instanceId = options.instanceId()
    const [sessionId] = cachedSessionIds()
    if (!sessionId) return
    setSessionTranscriptVisible(instanceId, sessionId, true)
    touchSessionTranscript(instanceId, sessionId)
    reconcileSessionTranscriptBudget()
    onCleanup(() => setSessionTranscriptVisible(instanceId, sessionId, false))
  })

  onCleanup(() => {
    reconcileSessionTranscriptBudget()
  })

  return {
    cachedSessionIds,
  }
}
