import { PRUNING_EVENT, prunedEventSchema } from "./contract"

interface SessionCache {
  list(): Array<{ id: string }>
  get(id: string): { location: { directory: string } } | undefined
  message: { list(id: string): unknown[]; invalidate(id: string): void; sync(id: string): Promise<void> }
}

export function createPruningReload(cache: SessionCache) {
  const pending = new Map<string, { dirty: boolean }>()
  let disposed = false
  const refresh = (sessionID: string) => {
    if (disposed) return
    cache.message.invalidate(sessionID)
    const current = pending.get(sessionID)
    if (current) { current.dirty = true; return }
    const state = { dirty: false }
    pending.set(sessionID, state)
    void (async () => {
      try {
        do {
          state.dirty = false
          await cache.message.sync(sessionID)
        } while (state.dirty && !disposed)
      } catch {
        // Leave stale data invalidated. Reopening or reconnecting retries it.
        if (!disposed) cache.message.invalidate(sessionID)
      } finally { pending.delete(sessionID) }
    })()
  }
  return {
    event(event: { type: string; data?: unknown; location?: { directory: string } }) {
      if (disposed) return
      if (event.type === "server.connected") {
        for (const session of cache.list()) {
          if (cache.message.list(session.id).length) refresh(session.id)
          else cache.message.invalidate(session.id)
        }
        return
      }
      if (event.type !== PRUNING_EVENT) return
      const parsed = prunedEventSchema.safeParse(event.data)
      if (!parsed.success) return
      const session = cache.get(parsed.data.sessionID)
      if (!session || session.location.directory !== event.location?.directory) return
      refresh(parsed.data.sessionID)
    },
    dispose() { disposed = true },
  }
}
