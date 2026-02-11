import { createEffect, createSignal, type Accessor } from "solid-js"
import { messageStoreBus } from "../../../stores/message-v2/bus"
import { clearSessionRenderCache } from "../../message-block"
import { getLogger } from "../../../lib/logger"

const log = getLogger("session")

const SESSION_CACHE_LIMIT = 5

type SessionCacheOptions = {
  instanceId: Accessor<string>
  instanceSessions: Accessor<Map<string, unknown>>
  activeSessionId: Accessor<string | null>
}

type SessionCacheState = {
  cachedSessionIds: Accessor<string[]>
}

export function useSessionCache(options: SessionCacheOptions): SessionCacheState {
  const [cachedSessionIds, setCachedSessionIds] = createSignal<string[]>([])
  const [pendingEvictions, setPendingEvictions] = createSignal<string[]>([])

  const evictSession = (sessionId: string) => {
    if (!sessionId) return
    const instanceId = options.instanceId()
    log.info("Evicting cached session", { instanceId, sessionId })
    const store = messageStoreBus.getInstance(instanceId)
    store?.clearSession(sessionId)
    clearSessionRenderCache(instanceId, sessionId)
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
    const cached = new Set(cachedSessionIds())
    const remaining: string[] = []
    pending.forEach((id) => {
      if (cached.has(id)) {
        remaining.push(id)
      } else {
        evictSession(id)
      }
    })
    if (remaining.length !== pending.length) {
      setPendingEvictions(remaining)
    }
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
