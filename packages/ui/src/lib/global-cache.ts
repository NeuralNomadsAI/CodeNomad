import { estimateRetainedBytes } from "./retained-size"

export interface CacheEntryBaseParams {
  instanceId?: string
  sessionId?: string
  scope: string
}

export interface CacheEntryParams extends CacheEntryBaseParams {
  cacheId: string
  version: string
}

export interface CacheAuthority {
  instanceKey: string
  sessionKey: string
  scope: string
  cacheId: string
  version: string
  generation: number
  writeToken: number
}

type VersionedCacheEntry = {
  version: string
  value: unknown
  byteSize: number
  keyBytes: number
  accessedAt: number
}

type CacheValueMap = Map<string, VersionedCacheEntry>
type CacheScopeMap = Map<string, CacheValueMap>
type CacheSessionMap = Map<string, CacheScopeMap>

const GLOBAL_KEY = "GLOBAL"
const MAX_SCOPE_CACHE_ENTRIES = 64
const MAX_CACHE_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_GLOBAL_CACHE_BYTES = 32 * 1024 * 1024
const MAX_GLOBAL_CACHE_ENTRIES = 4_096
const cacheStore = new Map<string, CacheSessionMap>()
let cacheGeneration = 0
let writeSequence = 0
const pendingWrites = new Map<string, number>()
const pendingAuthorityByParams = new WeakMap<CacheEntryParams, CacheAuthority>()
const cacheSessionChangeHandlers = new Set<(instanceId: string, sessionId: string) => void>()
let retainedBytes = 0
let retainedEntries = 0
let accessSequence = 0

function recalculateRetainedSize(): void {
  retainedBytes = 0
  retainedEntries = 0
  for (const sessionMap of cacheStore.values()) {
    for (const scopeMap of sessionMap.values()) {
      for (const valueMap of scopeMap.values()) {
        for (const entry of valueMap.values()) {
          retainedBytes += entry.byteSize
          retainedEntries += 1
        }
      }
    }
  }
}

function resolveKey(value?: string) {
  return value && value.length > 0 ? value : GLOBAL_KEY
}

function writeKey(instanceKey: string, sessionKey: string, scope: string, cacheId: string): string {
  return `${instanceKey}\u0000${sessionKey}\u0000${scope}\u0000${cacheId}`
}

function invalidateAllPendingWrites(): void {
  cacheGeneration += 1
  pendingWrites.clear()
}

function invalidatePendingWrite(instanceKey: string, sessionKey: string, scope: string, cacheId: string): void {
  pendingWrites.delete(writeKey(instanceKey, sessionKey, scope, cacheId))
}

function notifyCacheSessionChanged(params: CacheEntryBaseParams): void {
  if (!params.instanceId || !params.sessionId) return
  for (const handler of cacheSessionChangeHandlers) handler(params.instanceId, params.sessionId)
}

export function onCacheSessionChanged(handler: (instanceId: string, sessionId: string) => void): () => void {
  cacheSessionChangeHandlers.add(handler)
  return () => cacheSessionChangeHandlers.delete(handler)
}

export function* getCacheRetainedEntriesForSession(instanceId: string, sessionId: string): Generator<{ value: unknown; keyBytes: number }> {
  const scopeMap = cacheStore.get(resolveKey(instanceId))?.get(resolveKey(sessionId))
  if (!scopeMap) return
  for (const valueMap of scopeMap.values()) {
    for (const entry of valueMap.values()) yield { value: entry.value, keyBytes: entry.keyBytes }
  }
}

export function captureCacheAuthority(params: CacheEntryParams): CacheAuthority {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)
  const scopePrefix = `${instanceKey}\u0000${sessionKey}\u0000${params.scope}\u0000`
  const currentKey = writeKey(instanceKey, sessionKey, params.scope, params.cacheId)
  const scopeWrites = [...pendingWrites.keys()].filter((key) => key.startsWith(scopePrefix) && key !== currentKey)
  if (scopeWrites.length >= MAX_SCOPE_CACHE_ENTRIES) pendingWrites.delete(scopeWrites[0]!)
  if (pendingWrites.size >= MAX_GLOBAL_CACHE_ENTRIES && !pendingWrites.has(currentKey)) invalidateAllPendingWrites()
  const writeToken = ++writeSequence
  pendingWrites.set(currentKey, writeToken)
  const authority = {
    instanceKey,
    sessionKey,
    scope: params.scope,
    cacheId: params.cacheId,
    version: params.version,
    generation: cacheGeneration,
    writeToken,
  }
  pendingAuthorityByParams.set(params, authority)
  return authority
}

function hasCacheAuthority(params: CacheEntryParams, authority: CacheAuthority): boolean {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)
  return instanceKey === authority.instanceKey
    && sessionKey === authority.sessionKey
    && params.scope === authority.scope
    && params.cacheId === authority.cacheId
    && params.version === authority.version
    && cacheGeneration === authority.generation
    && pendingWrites.get(writeKey(instanceKey, sessionKey, params.scope, params.cacheId)) === authority.writeToken
}

function getScopeValueMap(params: CacheEntryParams, create: boolean): CacheValueMap | undefined {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)

  let sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) {
    if (!create) return undefined
    sessionMap = new Map()
    cacheStore.set(instanceKey, sessionMap)
  }

  let scopeMap = sessionMap.get(sessionKey)
  if (!scopeMap) {
    if (!create) return undefined
    scopeMap = new Map()
    sessionMap.set(sessionKey, scopeMap)
  }

  let valueMap = scopeMap.get(params.scope)
  if (!valueMap) {
    if (!create) return undefined
    valueMap = new Map()
    scopeMap.set(params.scope, valueMap)
  }

  return valueMap
}

function cleanupHierarchy(instanceKey: string, sessionKey: string, scopeKey?: string) {
  const sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) {
    return
  }

  const scopeMap = sessionMap.get(sessionKey)
  if (!scopeMap) {
    if (sessionMap.size === 0) {
      cacheStore.delete(instanceKey)
    }
    return
  }

  if (scopeKey) {
    const valueMap = scopeMap.get(scopeKey)
    if (valueMap && valueMap.size === 0) {
      scopeMap.delete(scopeKey)
    }
  }

  if (scopeMap.size === 0) {
    sessionMap.delete(sessionKey)
  }

  if (sessionMap.size === 0) {
    cacheStore.delete(instanceKey)
  }
}

function evictOldestCacheEntry(): boolean {
  let oldest: { instanceKey: string; sessionKey: string; scope: string; cacheId: string; entry: VersionedCacheEntry } | undefined
  for (const [instanceKey, sessionMap] of cacheStore) {
    for (const [sessionKey, scopeMap] of sessionMap) {
      for (const [scope, valueMap] of scopeMap) {
        for (const [cacheId, entry] of valueMap) {
          if (!oldest || entry.accessedAt < oldest.entry.accessedAt) oldest = { instanceKey, sessionKey, scope, cacheId, entry }
        }
      }
    }
  }
  if (!oldest) return false
  cacheStore.get(oldest.instanceKey)?.get(oldest.sessionKey)?.get(oldest.scope)?.delete(oldest.cacheId)
  retainedBytes -= oldest.entry.byteSize
  retainedEntries -= 1
  invalidatePendingWrite(oldest.instanceKey, oldest.sessionKey, oldest.scope, oldest.cacheId)
  cleanupHierarchy(oldest.instanceKey, oldest.sessionKey, oldest.scope)
  if (oldest.instanceKey !== GLOBAL_KEY && oldest.sessionKey !== GLOBAL_KEY) {
    notifyCacheSessionChanged({ instanceId: oldest.instanceKey, sessionId: oldest.sessionKey, scope: oldest.scope })
  }
  return true
}

export function setCacheEntry<T>(params: CacheEntryParams, value: T | undefined, authority?: CacheAuthority): void {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)
  const resolvedAuthority = authority ?? pendingAuthorityByParams.get(params)
  pendingAuthorityByParams.delete(params)
  if (resolvedAuthority && !hasCacheAuthority(params, resolvedAuthority)) return
  invalidatePendingWrite(instanceKey, sessionKey, params.scope, params.cacheId)

  if (value === undefined) {
    const existingMap = getScopeValueMap(params, false)
    const existing = existingMap?.get(params.cacheId)
    retainedBytes -= existing?.byteSize ?? 0
    if (existing) retainedEntries -= 1
    existingMap?.delete(params.cacheId)
    cleanupHierarchy(instanceKey, sessionKey, params.scope)
    if (existing) notifyCacheSessionChanged(params)
    return
  }

  const scopeEntries = getScopeValueMap(params, false)
  const existing = scopeEntries?.get(params.cacheId)
  retainedBytes -= existing?.byteSize ?? 0
  if (existing) retainedEntries -= 1
  scopeEntries?.delete(params.cacheId)
  const keyBytes = [params.instanceId, params.sessionId, params.scope, params.cacheId, params.version]
    .reduce((total, part) => total + (part?.length ?? 0) * 2 + 16, 0)
  const byteSize = estimateRetainedBytes(value, MAX_CACHE_ENTRY_BYTES) + keyBytes
  if (byteSize > MAX_CACHE_ENTRY_BYTES) {
    scopeEntries?.delete(params.cacheId)
    cleanupHierarchy(instanceKey, sessionKey, params.scope)
    if (existing) notifyCacheSessionChanged(params)
    return
  }
  while (retainedBytes + byteSize > MAX_GLOBAL_CACHE_BYTES || retainedEntries >= MAX_GLOBAL_CACHE_ENTRIES) {
    if (!evictOldestCacheEntry()) break
  }
  const target = getScopeValueMap(params, true)
  if (!target) return
  target.delete(params.cacheId)
  target.set(params.cacheId, { version: params.version, value, byteSize, keyBytes, accessedAt: ++accessSequence })
  retainedBytes += byteSize
  retainedEntries += 1
  while (target.size > MAX_SCOPE_CACHE_ENTRIES) {
    const oldest = target.keys().next().value
    if (oldest === undefined) break
    retainedBytes -= target.get(oldest)?.byteSize ?? 0
    target.delete(oldest)
    retainedEntries -= 1
    invalidatePendingWrite(instanceKey, sessionKey, params.scope, oldest)
  }
  notifyCacheSessionChanged(params)
}

export function getCacheEntry<T>(params: CacheEntryParams): T | undefined {
  const scopeEntries = getScopeValueMap(params, false)
  const entry = scopeEntries?.get(params.cacheId)
  if (!entry || entry.version !== params.version) {
    captureCacheAuthority(params)
    return undefined
  }
  invalidatePendingWrite(resolveKey(params.instanceId), resolveKey(params.sessionId), params.scope, params.cacheId)
  scopeEntries!.delete(params.cacheId)
  entry.accessedAt = ++accessSequence
  scopeEntries!.set(params.cacheId, entry)
  captureCacheAuthority(params)
  return entry.value as T
}

export function clearCacheScope(params: CacheEntryBaseParams): void {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)
  invalidateAllPendingWrites()
  const sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) return
  const scopeMap = sessionMap.get(sessionKey)
  if (!scopeMap) return
  scopeMap.delete(params.scope)
  cleanupHierarchy(instanceKey, sessionKey)
  recalculateRetainedSize()
}

export function clearCacheForSession(instanceId?: string, sessionId?: string): void {
  const instanceKey = resolveKey(instanceId)
  const sessionKey = resolveKey(sessionId)
  invalidateAllPendingWrites()
  const sessionMap = cacheStore.get(instanceKey)
  if (!sessionMap) return
  sessionMap.delete(sessionKey)
  if (sessionMap.size === 0) {
    cacheStore.delete(instanceKey)
  }
  recalculateRetainedSize()
}

export function clearCacheForInstance(instanceId?: string): void {
  const instanceKey = resolveKey(instanceId)
  invalidateAllPendingWrites()
  cacheStore.delete(instanceKey)
  recalculateRetainedSize()
}

