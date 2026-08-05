import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { setVisibleSessionMemory } from "../../../stores/session-memory"

const SESSION_CACHE_LIMIT = 5

type SessionCacheOptions = {
  instanceId: Accessor<string>
  instanceSessions: Accessor<Map<string, unknown>>
  activeSessionId: Accessor<string | null>
  visible: Accessor<boolean>
}

type SessionCacheState = {
  cachedSessionIds: Accessor<string[]>
}

export function useSessionCache(options: SessionCacheOptions): SessionCacheState {
  const [cachedSessionIds, setCachedSessionIds] = createSignal<string[]>([])

  createEffect(() => {
    const instanceSessions = options.instanceSessions()
    const activeId = options.activeSessionId()
    const visible = options.visible()

    setCachedSessionIds((current) => {
      if (!visible) return []
      const next = current.filter((id) => id !== "info" && instanceSessions.has(id))

      const touch = (id: string | null) => {
        if (!id || id === "info") return
        if (!instanceSessions.has(id)) return

        const index = next.indexOf(id)
        if (index !== -1) {
          next.splice(index, 1)
        }
        next.unshift(id)
      }

      touch(activeId)

      return next.length > SESSION_CACHE_LIMIT ? next.slice(0, SESSION_CACHE_LIMIT) : next
    })
  })

  createEffect(() => {
    const instanceId = options.instanceId()
    const mountedSessionIds = cachedSessionIds()
    for (let index = mountedSessionIds.length - 1; index >= 0; index -= 1) {
      setVisibleSessionMemory(instanceId, mountedSessionIds[index]!, true)
    }
    onCleanup(() => mountedSessionIds.forEach((sessionId) => setVisibleSessionMemory(instanceId, sessionId, false)))
  })

  return {
    cachedSessionIds,
  }
}
