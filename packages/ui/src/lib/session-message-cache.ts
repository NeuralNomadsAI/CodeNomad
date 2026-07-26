const DATABASE_NAME = "codenomad-session-messages"
const DATABASE_VERSION = 2
const MANIFEST_STORE = "session-manifests"
const MESSAGE_STORE = "session-messages"
const SESSION_INDEX = "by-session"

export const DEFAULT_SESSION_MESSAGE_CACHE_PAGE_SIZE = 50
export const MAX_SESSION_MESSAGE_CACHE_BYTES = 16 * 1024 * 1024
export const MAX_TOTAL_MESSAGE_CACHE_BYTES = 64 * 1024 * 1024
export const MAX_SESSION_MESSAGE_CACHE_ENTRIES = 64

export interface SessionMessageCacheManifest {
  key: string
  snapshotId: string
  messageIds: string[]
  startIndex: number
  totalCount: number
  complete: boolean
  byteSize: number
  savedAt: number
}

interface SessionMessageCacheRecord {
  sessionKey: string
  snapshotId: string
  messageId: string
  ordinal: number
  payload: string
}

export interface SessionMessageCacheCursor {
  key: string
  snapshotId: string
  messageIds: readonly string[]
  beforeIndex: number
  startIndex: number
  totalCount: number
  complete: boolean
}

export interface SessionMessageCachePage {
  messages: unknown[]
  startIndex: number
  totalCount: number
  done: boolean
  complete: boolean
}

interface PreparedSessionMessageCache {
  manifest: SessionMessageCacheManifest
  records: SessionMessageCacheRecord[]
}

let databasePromise: Promise<IDBDatabase | null> | null = null
let clearGeneration = 0
let cacheEnabled = false
const resetListeners = new Set<() => void>()
let mutationQueue: Promise<void> = Promise.resolve()

export function isSessionMessageCacheEnabled(): boolean {
  return cacheEnabled
}

export function setSessionMessageCacheEnabled(enabled: boolean): void {
  cacheEnabled = enabled
  if (!enabled) resetListeners.forEach((listener) => listener())
}

export function onSessionMessageCacheReset(listener: () => void): () => void {
  resetListeners.add(listener)
  return () => resetListeners.delete(listener)
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
  })
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  if (databasePromise) return databasePromise

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const legacy of ["payloads", "metadata"]) {
        if (database.objectStoreNames.contains(legacy)) database.deleteObjectStore(legacy)
      }
      if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
        database.createObjectStore(MANIFEST_STORE, { keyPath: "key" })
      }
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        const store = database.createObjectStore(MESSAGE_STORE, {
          keyPath: ["sessionKey", "snapshotId", "messageId"],
        })
        store.createIndex(SESSION_INDEX, "sessionKey")
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error("Failed to open session message cache"))
  })
  databasePromise = opening.catch((error) => {
    databasePromise = null
    throw error
  })
  return databasePromise
}

function createSnapshotId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createSessionMessageCacheKey(workspace: string, sessionId: string): string {
  return `${workspace.replace(/\\/g, "/").replace(/\/+$/, "")}\u0000${sessionId}`
}

function messageIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { info?: { id?: unknown }; id?: unknown }
  const id = candidate.info?.id ?? candidate.id
  return typeof id === "string" && id.length > 0 ? id : null
}

function messageSessionIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { info?: { sessionID?: unknown }; sessionId?: unknown }
  const id = candidate.info?.sessionID ?? candidate.sessionId
  return typeof id === "string" && id.length > 0 ? id : null
}

function sessionIdFromKey(key: string): string {
  return key.slice(key.lastIndexOf("\u0000") + 1)
}

function isValidManifest(value: unknown, expectedKey: string): value is SessionMessageCacheManifest {
  if (!value || typeof value !== "object") return false
  const manifest = value as SessionMessageCacheManifest
  return manifest.key === expectedKey &&
    typeof manifest.snapshotId === "string" && manifest.snapshotId.length > 0 &&
    Array.isArray(manifest.messageIds) && manifest.messageIds.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(manifest.messageIds).size === manifest.messageIds.length &&
    Number.isSafeInteger(manifest.startIndex) && manifest.startIndex >= 0 &&
    Number.isSafeInteger(manifest.totalCount) && manifest.totalCount === manifest.startIndex + manifest.messageIds.length &&
    manifest.complete === (manifest.startIndex === 0) &&
    Number.isFinite(manifest.byteSize) && manifest.byteSize >= 0 &&
    Number.isFinite(manifest.savedAt)
}

export function prepareSessionMessageCache(
  key: string,
  messages: readonly unknown[],
  snapshotId = createSnapshotId(),
  byteLimit = MAX_SESSION_MESSAGE_CACHE_BYTES,
  savedAt = Date.now(),
): PreparedSessionMessageCache | null {
  const serialized = messages.map((message, ordinal) => {
    const messageId = messageIdOf(message)
    if (!messageId) return null
    const payload = JSON.stringify(message)
    return { messageId, ordinal, payload, byteSize: payload.length * 2 }
  })
  if (serialized.some((entry) => entry === null)) return null

  const seen = new Set<string>()
  for (const entry of serialized) {
    if (!entry || seen.has(entry.messageId)) return null
    seen.add(entry.messageId)
  }

  let byteSize = 0
  let startIndex = serialized.length
  for (let index = serialized.length - 1; index >= 0; index -= 1) {
    const entry = serialized[index]!
    if (entry.byteSize > byteLimit || byteSize + entry.byteSize > byteLimit) break
    byteSize += entry.byteSize
    startIndex = index
  }
  if (messages.length > 0 && startIndex === serialized.length) return null

  const selected = serialized.slice(startIndex) as Array<NonNullable<(typeof serialized)[number]>>
  const records = selected.map((entry) => ({
    sessionKey: key,
    snapshotId,
    messageId: entry.messageId,
    ordinal: entry.ordinal,
    payload: entry.payload,
  }))
  return {
    manifest: {
      key,
      snapshotId,
      messageIds: selected.map((entry) => entry.messageId),
      startIndex,
      totalCount: messages.length,
      complete: startIndex === 0,
      byteSize,
      savedAt,
    },
    records,
  }
}

export function selectSessionMessageCacheEvictions(
  entries: readonly SessionMessageCacheManifest[],
  byteLimit = MAX_TOTAL_MESSAGE_CACHE_BYTES,
  entryLimit = MAX_SESSION_MESSAGE_CACHE_ENTRIES,
): string[] {
  const oldestFirst = [...entries].sort((left, right) => left.savedAt - right.savedAt || left.key.localeCompare(right.key))
  let bytes = oldestFirst.reduce((total, entry) => total + entry.byteSize, 0)
  let count = oldestFirst.length
  const evictions: string[] = []
  for (const entry of oldestFirst) {
    if (bytes <= byteLimit && count <= entryLimit) break
    evictions.push(entry.key)
    bytes -= entry.byteSize
    count -= 1
  }
  return evictions
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

async function readSessionRecordKeys(database: IDBDatabase, sessionKeys: readonly string[]): Promise<Map<string, IDBValidKey[]>> {
  if (sessionKeys.length === 0) return new Map()
  const transaction = database.transaction(MESSAGE_STORE, "readonly")
  const completion = transactionDone(transaction)
  const index = transaction.objectStore(MESSAGE_STORE).index(SESSION_INDEX)
  const requests = sessionKeys.map(async (sessionKey) => [
    sessionKey,
    await requestResult(index.getAllKeys(IDBKeyRange.only(sessionKey))),
  ] as const)
  const entries = await Promise.all(requests)
  await completion
  return new Map(entries)
}

export async function openSessionMessageCache(
  workspace: string,
  sessionId: string,
): Promise<SessionMessageCacheCursor | null> {
  const generation = clearGeneration
  const database = await openDatabase()
  if (!database || generation !== clearGeneration) return null
  const transaction = database.transaction(MANIFEST_STORE, "readonly")
  const completion = transactionDone(transaction)
  const key = createSessionMessageCacheKey(workspace, sessionId)
  const manifest = await requestResult(transaction.objectStore(MANIFEST_STORE).get(key)) as unknown
  await completion
  if (generation !== clearGeneration) return null
  if (!manifest) return null
  if (!isValidManifest(manifest, key)) {
    await deleteCorruptSessionMessageCacheKey(key, manifest)
    return null
  }
  return {
    key: manifest.key,
    snapshotId: manifest.snapshotId,
    messageIds: manifest.messageIds,
    beforeIndex: manifest.messageIds.length,
    startIndex: manifest.startIndex,
    totalCount: manifest.totalCount,
    complete: manifest.complete,
  }
}

export async function readSessionMessageCachePage(
  cursor: SessionMessageCacheCursor,
  limit = DEFAULT_SESSION_MESSAGE_CACHE_PAGE_SIZE,
): Promise<{ page: SessionMessageCachePage; cursor: SessionMessageCacheCursor } | null> {
  if (cursor.beforeIndex <= 0) return null
  const generation = clearGeneration
  const database = await openDatabase()
  if (!database || generation !== clearGeneration) return null
  const transaction = database.transaction([MANIFEST_STORE, MESSAGE_STORE], "readonly")
  const completion = transactionDone(transaction)
  const manifestRequest = transaction.objectStore(MANIFEST_STORE).get(cursor.key)
  const start = Math.max(0, cursor.beforeIndex - Math.max(1, limit))
  const ids = cursor.messageIds.slice(start, cursor.beforeIndex)
  const messageStore = transaction.objectStore(MESSAGE_STORE)
  const requests = ids.map((messageId) => requestResult(messageStore.get([cursor.key, cursor.snapshotId, messageId])))
  const manifest = await requestResult(manifestRequest) as unknown
  const records = await Promise.all(requests) as Array<SessionMessageCacheRecord | undefined>
  await completion
  if (generation !== clearGeneration) return null
  if (!isValidManifest(manifest, cursor.key) || manifest.snapshotId !== cursor.snapshotId) return null
  if (records.some((record) => !record)) {
    await deleteCorruptSessionMessageCacheKey(cursor.key, manifest)
    return null
  }

  try {
    const messages = records.map((record) => JSON.parse(record!.payload))
    const sessionId = sessionIdFromKey(cursor.key)
    if (messages.some((message, index) => messageIdOf(message) !== ids[index] || messageSessionIdOf(message) !== sessionId)) {
      await deleteCorruptSessionMessageCacheKey(cursor.key, manifest)
      return null
    }
    const nextCursor = { ...cursor, beforeIndex: start }
    return {
      page: {
        messages,
        startIndex: cursor.startIndex + start,
        totalCount: cursor.totalCount,
        done: start === 0,
        complete: cursor.complete,
      },
      cursor: nextCursor,
    }
  } catch {
    await deleteCorruptSessionMessageCacheKey(cursor.key, manifest)
    return null
  }
}

export async function writeSessionMessageCache(workspace: string, sessionId: string, messages: unknown[]): Promise<boolean> {
  const generation = clearGeneration
  const key = createSessionMessageCacheKey(workspace, sessionId)
  const prepared = prepareSessionMessageCache(key, messages)
  if (!prepared) {
    await deleteSessionMessageCache(workspace, sessionId)
    return false
  }
  return enqueueMutation(async () => {
    const database = await openDatabase()
    if (!database || generation !== clearGeneration) return false
    const manifestRead = database.transaction(MANIFEST_STORE, "readonly")
    const manifestReadDone = transactionDone(manifestRead)
    const existing = await requestResult(manifestRead.objectStore(MANIFEST_STORE).getAll()) as unknown[]
    await manifestReadDone
    const validExisting = existing.filter((manifest): manifest is SessionMessageCacheManifest => {
      const manifestKey = (manifest as { key?: unknown })?.key
      return typeof manifestKey === "string" && isValidManifest(manifest, manifestKey)
    })
    const invalidKeys = existing
      .filter((manifest) => !validExisting.includes(manifest as SessionMessageCacheManifest))
      .map((manifest) => (manifest as { key?: unknown })?.key)
      .filter((manifestKey): manifestKey is string => typeof manifestKey === "string" && manifestKey !== key)
    prepared.manifest.savedAt = Math.max(prepared.manifest.savedAt, ...validExisting.map((manifest) => manifest.savedAt + 1))
    const projected = [...validExisting.filter((manifest) => manifest.key !== key), prepared.manifest]
    const evictions = selectSessionMessageCacheEvictions(projected)
    const recordKeys = await readSessionRecordKeys(database, [key, ...evictions, ...invalidKeys])
    if (generation !== clearGeneration) return false

    const transaction = database.transaction([MANIFEST_STORE, MESSAGE_STORE], "readwrite")
    const completion = transactionDone(transaction)
    const manifestStore = transaction.objectStore(MANIFEST_STORE)
    const messageStore = transaction.objectStore(MESSAGE_STORE)
    for (const recordKey of recordKeys.get(key) ?? []) messageStore.delete(recordKey)
    for (const record of prepared.records) messageStore.put(record)
    manifestStore.put(prepared.manifest)
    for (const evictedKey of evictions) {
      for (const recordKey of recordKeys.get(evictedKey) ?? []) messageStore.delete(recordKey)
      manifestStore.delete(evictedKey)
    }
    for (const invalidKey of invalidKeys) {
      for (const recordKey of recordKeys.get(invalidKey) ?? []) messageStore.delete(recordKey)
      manifestStore.delete(invalidKey)
    }
    await completion
    return true
  })
}

export async function deleteSessionMessageCache(workspace: string, sessionId: string): Promise<void> {
  const key = createSessionMessageCacheKey(workspace, sessionId)
  await deleteSessionMessageCacheKey(key)
}

async function deleteSessionMessageCacheKey(key: string): Promise<void> {
  await enqueueMutation(async () => {
    const database = await openDatabase()
    if (!database) return
    const recordKeys = await readSessionRecordKeys(database, [key])
    const transaction = database.transaction([MANIFEST_STORE, MESSAGE_STORE], "readwrite")
    const completion = transactionDone(transaction)
    const messageStore = transaction.objectStore(MESSAGE_STORE)
    for (const recordKey of recordKeys.get(key) ?? []) messageStore.delete(recordKey)
    transaction.objectStore(MANIFEST_STORE).delete(key)
    await completion
  })
}

async function deleteCorruptSessionMessageCacheKey(key: string, observed: unknown): Promise<void> {
  const observedSnapshotId = (observed as { snapshotId?: unknown })?.snapshotId
  await enqueueMutation(async () => {
    const database = await openDatabase()
    if (!database) return
    const manifestRead = database.transaction(MANIFEST_STORE, "readonly")
    const manifestReadDone = transactionDone(manifestRead)
    const current = await requestResult(manifestRead.objectStore(MANIFEST_STORE).get(key)) as unknown
    await manifestReadDone
    if (!current) return
    if (typeof observedSnapshotId === "string") {
      if ((current as { snapshotId?: unknown }).snapshotId !== observedSnapshotId) return
    } else if (isValidManifest(current, key)) {
      return
    }
    const recordKeys = await readSessionRecordKeys(database, [key])
    const transaction = database.transaction([MANIFEST_STORE, MESSAGE_STORE], "readwrite")
    const completion = transactionDone(transaction)
    const messageStore = transaction.objectStore(MESSAGE_STORE)
    for (const recordKey of recordKeys.get(key) ?? []) messageStore.delete(recordKey)
    transaction.objectStore(MANIFEST_STORE).delete(key)
    await completion
  })
}

export async function clearSessionMessageCache(): Promise<void> {
  clearGeneration += 1
  await enqueueMutation(async () => {
    const database = await openDatabase()
    if (!database) return
    const transaction = database.transaction([MANIFEST_STORE, MESSAGE_STORE], "readwrite")
    const completion = transactionDone(transaction)
    transaction.objectStore(MANIFEST_STORE).clear()
    transaction.objectStore(MESSAGE_STORE).clear()
    await completion
  })
}
