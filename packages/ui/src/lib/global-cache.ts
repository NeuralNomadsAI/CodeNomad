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
}

type CacheValueMap = Map<string, VersionedCacheEntry>
type CacheScopeMap = Map<string, CacheValueMap>
type CacheSessionMap = Map<string, CacheScopeMap>

const GLOBAL_KEY = "GLOBAL"
const cacheStore = new Map<string, CacheSessionMap>()

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
    existingMap?.delete(params.cacheId)
    cleanupHierarchy(instanceKey, sessionKey, params.scope)
    return
  }

  const scopeEntries = getScopeValueMap(params, true)
  scopeEntries?.set(params.cacheId, { version: params.version, value })
}

export function getCacheEntry<T>(params: CacheEntryParams): T | undefined {
  const scopeEntries = getScopeValueMap(params, false)
  const entry = scopeEntries?.get(params.cacheId)
  if (!entry || entry.version !== params.version) {
    return undefined
  }
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
}

export function clearCacheForInstance(instanceId?: string): void {
  const instanceKey = resolveKey(instanceId)
  cacheStore.delete(instanceKey)
}

