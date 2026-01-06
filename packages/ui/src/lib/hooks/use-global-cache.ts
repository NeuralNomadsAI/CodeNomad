import { type Accessor, createMemo } from "solid-js"
import {
  type CacheEntryParams,
  getCacheEntry,
  setCacheEntry,
  clearCacheScope,
  clearCacheForSession,
  clearCacheForInstance,
} from "../global-cache"

/**
 * `useGlobalCache` exposes a tiny typed facade over the shared cache helpers.
 * Callers can pass raw values or accessors for the cache keys; empty identifiers
 * automatically fall back to the global buckets.
 */
export function useGlobalCache(params: UseGlobalCacheParams): GlobalCacheHandle {
  const resolvedEntry = createMemo<CacheEntryParams>(() => {
    const instanceId = normalizeId(resolveValue(params.instanceId))
    const sessionId = normalizeId(resolveValue(params.sessionId))
    const scope = resolveValue(params.scope)
    const cacheId = resolveValue(params.cacheId)
    const version = String(resolveValue(params.version))
    return { instanceId, sessionId, scope, cacheId, version }
  })

  const scopeParams = createMemo(() => {
    const entry = resolvedEntry()
    return { instanceId: entry.instanceId, sessionId: entry.sessionId, scope: entry.scope }
  })

  const sessionParams = createMemo(() => {
    const entry = resolvedEntry()
    return { instanceId: entry.instanceId, sessionId: entry.sessionId }
  })

  return {
    get<T>() {
      return getCacheEntry<T>(resolvedEntry())
    },
    set<T>(value: T | undefined) {
      setCacheEntry(resolvedEntry(), value)
    },
    clearScope() {
      clearCacheScope(scopeParams())
    },
    clearSession() {
      const params = sessionParams()
      clearCacheForSession(params.instanceId, params.sessionId)
    },
    clearInstance() {
      const params = sessionParams()
      clearCacheForInstance(params.instanceId)
    },
    params() {
      return resolvedEntry()
    },
  }
}

function normalizeId(value?: string): string | undefined {
  return value && value.length > 0 ? value : undefined
}

function resolveValue<T>(value: MaybeAccessor<T> | undefined): T {
  if (typeof value === "function") {
    return (value as Accessor<T>)()
  }
  return value as T
}

type MaybeAccessor<T> = T | Accessor<T>

interface UseGlobalCacheParams {
  instanceId?: MaybeAccessor<string | undefined>
  sessionId?: MaybeAccessor<string | undefined>
  scope: MaybeAccessor<string>
  cacheId: MaybeAccessor<string>
  version: MaybeAccessor<string | number>
}

interface GlobalCacheHandle {
  get<T>(): T | undefined
  set<T>(value: T | undefined): void
  clearScope(): void
  clearSession(): void
  clearInstance(): void
  params(): CacheEntryParams
}
