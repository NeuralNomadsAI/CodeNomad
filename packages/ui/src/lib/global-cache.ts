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

type VersionedCacheEntry = {
  version: string
  value: unknown
  byteSize: number
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
let retainedBytes = 0
let retainedEntries = 0

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

export function setCacheEntry<T>(params: CacheEntryParams, value: T | undefined): void {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)

  if (value === undefined) {
    const existingMap = getScopeValueMap(params, false)
    const existing = existingMap?.get(params.cacheId)
    retainedBytes -= existing?.byteSize ?? 0
    if (existing) retainedEntries -= 1
    existingMap?.delete(params.cacheId)
    cleanupHierarchy(instanceKey, sessionKey, params.scope)
    return
  }

  const scopeEntries = getScopeValueMap(params, false)
  const existing = scopeEntries?.get(params.cacheId)
  retainedBytes -= existing?.byteSize ?? 0
  if (existing) retainedEntries -= 1
  const keyBytes = [params.instanceId, params.sessionId, params.scope, params.cacheId, params.version]
    .reduce((total, part) => total + (part?.length ?? 0) * 2 + 16, 0)
  const byteSize = estimateRetainedBytes(value, MAX_CACHE_ENTRY_BYTES) + keyBytes
  if (byteSize > MAX_CACHE_ENTRY_BYTES) {
    scopeEntries?.delete(params.cacheId)
    cleanupHierarchy(instanceKey, sessionKey, params.scope)
    return
  }
  if (retainedBytes + byteSize > MAX_GLOBAL_CACHE_BYTES || retainedEntries >= MAX_GLOBAL_CACHE_ENTRIES) {
    cacheStore.clear()
    retainedBytes = 0
    retainedEntries = 0
  }
  const target = getScopeValueMap(params, true)
  if (!target) return
  target.delete(params.cacheId)
  target.set(params.cacheId, { version: params.version, value, byteSize })
  retainedBytes += byteSize
  retainedEntries += 1
  while (target.size > MAX_SCOPE_CACHE_ENTRIES) {
    const oldest = target.keys().next().value
    if (oldest === undefined) break
    retainedBytes -= target.get(oldest)?.byteSize ?? 0
    target.delete(oldest)
    retainedEntries -= 1
  }
}

export function getCacheEntry<T>(params: CacheEntryParams): T | undefined {
  const scopeEntries = getScopeValueMap(params, false)
  const entry = scopeEntries?.get(params.cacheId)
  if (!entry || entry.version !== params.version) {
    return undefined
  }
  scopeEntries!.delete(params.cacheId)
  scopeEntries!.set(params.cacheId, entry)
  return entry.value as T
}

export function clearCacheScope(params: CacheEntryBaseParams): void {
  const instanceKey = resolveKey(params.instanceId)
  const sessionKey = resolveKey(params.sessionId)
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
  cacheStore.delete(instanceKey)
  recalculateRetainedSize()
}

