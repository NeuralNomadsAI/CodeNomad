import { PRUNING_EVENT, prunedEventSchema } from "./contract"

interface SessionCache {
  list(): Array<{ id: string }>
  get(id: string): { location: { directory: string } } | undefined
  message: Partial<Pagination> & {
    list(id: string): unknown[]
    invalidate(id: string): void
    sync(id: string): Promise<void>
  }
}

interface Pagination {
  loading(id: string): boolean
  loadMore(id: string, options?: { signal?: AbortSignal }): Promise<void>
}

function hasPagination(message: SessionCache["message"]): message is SessionCache["message"] & Pagination {
  return "loading" in message && typeof message.loading === "function"
    && "loadMore" in message && typeof message.loadMore === "function"
}

export function createPruningReload(cache: SessionCache) {
  // These are public @opencode/client/solid APIs. beta-19419's plugin Data
  // declaration omits them, but its audited TUI host passes the original cache
  // directly (f91c6d8b25, packages/tui/src/plugin/api.tsx: data: host.data).
  // Fail explicitly if that capability changes; invalidate/sync alone is unsafe.
  const messages = cache.message
  if (!hasPagination(messages)) throw new Error("Unsupported TUI cache: pagination publication API is unavailable")
  const pending = new Map<string, { dirty: boolean }>()
  const lifetime = new AbortController()
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
          // beta-19419 tracks pagination independently of invalidate/sync. Join
          // the public loadMore publication before the authoritative read; an
          // older page could otherwise reinsert deleted blocks after sync.
          // With no `all` option, loadMore joins an active successful page rather
          // than fetching another. A failed page must not prevent the reread.
          if (messages.loading(sessionID)) {
            await messages.loadMore(sessionID, { signal: lifetime.signal }).catch(() => undefined)
          }
          if (disposed) return
          // Invalidate again after the join: another UI owner may have synced
          // while we waited, and each coalesced prune needs a fresh read.
          cache.message.invalidate(sessionID)
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
    dispose() { disposed = true; lifetime.abort() },
  }
}
