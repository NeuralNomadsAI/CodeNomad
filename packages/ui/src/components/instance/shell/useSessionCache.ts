import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { messageStoreBus } from "../../../stores/message-v2/bus"
import { evictResidentSessionMessages, setVisibleSessionMemory } from "../../../stores/session-memory"

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
  const [pendingEvictions, setPendingEvictions] = createSignal<string[]>([])

  const evictSession = (sessionId: string) => {
    if (!sessionId) return false
    return evictResidentSessionMessages(options.instanceId(), sessionId)
  }

  const scheduleEvictions = (ids: string[]) => {
    if (!ids.length) return
    setPendingEvictions((current) => {
      const existing = new Set(current)
      const next = [...current]
      ids.forEach((id) => {
        if (!existing.has(id)) {
          next.push(id)
          existing.add(id)
        }
      })
      return next
    })
  }

  createEffect(() => {
    const pending = pendingEvictions()
    if (!pending.length) return
    const store = messageStoreBus.getInstance(options.instanceId())
    const cached = new Set(cachedSessionIds())
    const remaining: string[] = []
    pending.forEach((id) => {
      store?.getSessionRevision(id)
      if (cached.has(id)) {
        remaining.push(id)
      } else if (!evictSession(id)) {
        remaining.push(id)
      }
    })
    if (remaining.length !== pending.length) {
      setPendingEvictions(remaining)
    }
  })

  createEffect(() => {
    const instanceId = options.instanceId()
    const sessionId = options.activeSessionId()
    if (!sessionId || sessionId === "info") return
    const isVisible = options.visible()
    if (!isVisible) return
    setVisibleSessionMemory(instanceId, sessionId, true)
    onCleanup(() => setVisibleSessionMemory(instanceId, sessionId, false))
  })

  createEffect(() => {
    const instanceSessions = options.instanceSessions()
    const activeId = options.activeSessionId()

    setCachedSessionIds((current) => {
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

      const trimmed = next.length > SESSION_CACHE_LIMIT ? next.slice(0, SESSION_CACHE_LIMIT) : next

      const trimmedSet = new Set(trimmed)
      const removed = current.filter((id) => !trimmedSet.has(id))
      if (removed.length) {
        scheduleEvictions(removed)
      }
      return trimmed
    })
  })

  return {
    cachedSessionIds,
  }
}
