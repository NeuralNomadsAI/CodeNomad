import {
  deleteSessionMessageCache,
  createSessionMessageCacheKey,
  type SessionMessageCachePage,
  isSessionMessageCacheEnabled,
  onSessionMessageCacheReset,
  openSessionMessageCache,
  readSessionMessageCachePage,
  writeSessionMessageCache,
  MAX_SESSION_MESSAGE_CACHE_BYTES,
} from "../lib/session-message-cache"
import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import { instances } from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { estimateRetainedBytes } from "../lib/session-memory-budget"

const log = getLogger("session")
const WRITE_DEBOUNCE_MS = 500
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()
const cacheGenerations = new Map<string, number>()
const pendingInvalidations = new Map<string, Promise<void>>()
const invalidatedEntries = new Set<string>()
const invalidationVersions = new Map<string, number>()
const pendingEntryInvalidations = new Map<string, number>()
const activeRestores = new Map<string, symbol>()
type CacheWriteRequest = {
  instanceId: string
  sessionId: string
  expectedRevision?: number
  allowEmpty: boolean
  generation: number
  reset: number
  instanceToken: unknown
  workspace: string
  entryKey: string
  invalidationVersion: number
  done: Array<() => void>
}
const queuedWrites = new Map<string, CacheWriteRequest>()
let writeWorkerRunning = false
const [restoringSessions, setRestoringSessions] = createSignal<ReadonlySet<string>>(new Set())
let resetGeneration = 0

function pendingKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function cacheGeneration(key: string): number {
  return cacheGenerations.get(key) ?? 0
}

function setRestoreActive(key: string, active: boolean): void {
  setRestoringSessions((current) => {
    const next = new Set(current)
    if (active) next.add(key)
    else next.delete(key)
    return next
  })
}

export function isRestoringCachedSessionMessages(instanceId: string, sessionId: string): boolean {
  return restoringSessions().has(pendingKey(instanceId, sessionId))
}

export function cancelCachedSessionMessageRestore(
  instanceId: string,
  sessionId: string,
  options?: { preserveShift?: boolean },
): void {
  const key = pendingKey(instanceId, sessionId)
  activeRestores.delete(key)
  if (!options?.preserveShift) setRestoreActive(key, false)
}

export function clearCachedSessionMessageShift(instanceId: string, sessionId: string): void {
  setRestoreActive(pendingKey(instanceId, sessionId), false)
}

function workspaceForInstance(instanceId: string): string | null {
  return instances().get(instanceId)?.folder ?? null
}

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 2_000 })
    } else {
      setTimeout(resolve, 0)
    }
  })
}

function snapshotSession(instanceId: string, sessionId: string, allowEmpty = false): unknown[] | null {
  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return null
  const messageIds = store.getSessionMessageIds(sessionId)
  if (messageIds.length === 0 && (!allowEmpty || !store.state.sessions[sessionId])) return null

  const result: unknown[] = []
  let bytes = 0
  for (let index = messageIds.length - 1; index >= 0; index -= 1) {
    const messageId = messageIds[index]
    const record = store.getMessage(messageId)
    const info = store.getMessageInfo(messageId)
    if (!record || !info || record.isEphemeral || record.status === "sending" || record.status === "streaming") return null
    const remaining = MAX_SESSION_MESSAGE_CACHE_BYTES / 2 - bytes
    const recordBytes = estimateRetainedBytes(record, remaining)
    if (recordBytes > remaining) break
    const infoBytes = estimateRetainedBytes(info, remaining - recordBytes)
    const messageBytes = recordBytes + infoBytes
    if (messageBytes > MAX_SESSION_MESSAGE_CACHE_BYTES / 2 || bytes + messageBytes > MAX_SESSION_MESSAGE_CACHE_BYTES / 2) break

    const parts = record.partIds.map((partId) => record.parts[partId]?.data).filter(Boolean).map((part) => {
      const { renderCache: _renderCache, pendingPermission: _pendingPermission, ...cacheable } = part as any
      return cacheable
    })
    result.unshift({ info, parts })
    bytes += messageBytes
  }
  return result.length > 0 || messageIds.length === 0 ? result : null
}

async function drainQueuedWrites(): Promise<void> {
  if (writeWorkerRunning) return
  writeWorkerRunning = true
  try {
    while (queuedWrites.size > 0) {
      const [key, request] = queuedWrites.entries().next().value as [string, CacheWriteRequest]
      queuedWrites.delete(key)
      try {
        await waitForIdle()
        if (cacheGeneration(key) !== request.generation || resetGeneration !== request.reset) continue
        if (instances().get(request.instanceId) !== request.instanceToken) continue
        if ((invalidationVersions.get(request.entryKey) ?? 0) !== request.invalidationVersion) continue
        const store = messageStoreBus.getInstance(request.instanceId)
        if (!store) continue
        if (request.expectedRevision !== undefined && store.getSessionRevision(request.sessionId) !== request.expectedRevision) continue
        const messages = snapshotSession(request.instanceId, request.sessionId, request.allowEmpty)
        if (!messages) continue
        const written = await writeSessionMessageCache(request.workspace, request.sessionId, messages)
        if (
          written &&
          cacheGeneration(key) === request.generation &&
          resetGeneration === request.reset &&
          instances().get(request.instanceId) === request.instanceToken &&
          (invalidationVersions.get(request.entryKey) ?? 0) === request.invalidationVersion &&
          pendingEntryInvalidations.get(request.entryKey) !== request.invalidationVersion
        ) invalidatedEntries.delete(request.entryKey)
      } catch (error) {
        log.warn("Failed to cache completed session messages", { instanceId: request.instanceId, sessionId: request.sessionId, error })
      } finally {
        request.done.forEach((resolve) => resolve())
      }
    }
  } finally {
    writeWorkerRunning = false
    if (queuedWrites.size > 0) void drainQueuedWrites()
  }
}

function enqueueSessionMessageCacheWrite(
  instanceId: string,
  sessionId: string,
  options?: { expectedRevision?: number; allowEmpty?: boolean },
): Promise<void> {
  const key = pendingKey(instanceId, sessionId)
  const instanceToken = instances().get(instanceId)
  const workspace = instanceToken?.folder
  if (!instanceToken || !workspace) return Promise.resolve()
  const entryKey = createSessionMessageCacheKey(workspace, sessionId)
  const invalidationVersion = invalidationVersions.get(entryKey) ?? 0
  return new Promise((resolve) => {
    const current = queuedWrites.get(key)
    if (current) {
      current.expectedRevision = options?.expectedRevision
      current.allowEmpty ||= Boolean(options?.allowEmpty)
      current.generation = cacheGeneration(key)
      current.reset = resetGeneration
      current.instanceToken = instanceToken
      current.workspace = workspace
      current.entryKey = entryKey
      current.invalidationVersion = invalidationVersion
      current.done.push(resolve)
    } else {
      queuedWrites.set(key, {
        instanceId,
        sessionId,
        expectedRevision: options?.expectedRevision,
        allowEmpty: Boolean(options?.allowEmpty),
        generation: cacheGeneration(key),
        reset: resetGeneration,
        instanceToken,
        workspace,
        entryKey,
        invalidationVersion,
        done: [resolve],
      })
    }
    void drainQueuedWrites()
  })
}

export async function* restoreCachedSessionMessagePages(
  instanceId: string,
  sessionId: string,
): AsyncGenerator<SessionMessageCachePage> {
  if (!isSessionMessageCacheEnabled()) return
  const workspace = workspaceForInstance(instanceId)
  if (!workspace) return
  const entryKey = createSessionMessageCacheKey(workspace, sessionId)
  if (invalidatedEntries.has(entryKey)) return
  const key = pendingKey(instanceId, sessionId)
  const generation = cacheGeneration(key)
  const reset = resetGeneration
  const token = Symbol(key)
  let restoredPage = false
  activeRestores.set(key, token)
  setRestoreActive(key, true)
  try {
    await pendingInvalidations.get(key)
    let cursor = await openSessionMessageCache(workspace, sessionId)
    const scroll = messageStoreBus.getInstance(instanceId)?.getScrollSnapshot(sessionId, "message-stream")
    const deferredAnchor = scroll && !scroll.atBottom ? scroll.anchorKey : undefined
    let buffered: unknown[] = []
    while (
      cursor &&
      cursor.beforeIndex > 0 &&
      activeRestores.get(key) === token &&
      cacheGeneration(key) === generation &&
      resetGeneration === reset &&
      !invalidatedEntries.has(entryKey)
    ) {
      const result = await readSessionMessageCachePage(cursor)
      if (!result) return
      if (
        activeRestores.get(key) !== token ||
        cacheGeneration(key) !== generation ||
        resetGeneration !== reset ||
        invalidatedEntries.has(entryKey)
      ) return
      cursor = result.cursor
      const page = result.page
      if (deferredAnchor && !page.messages.some((message) => (message as any)?.info?.id === deferredAnchor) && cursor.beforeIndex > 0) {
        buffered = [...page.messages, ...buffered]
        continue
      }
      if (buffered.length > 0) {
        restoredPage = true
        yield { ...page, messages: [...page.messages, ...buffered] }
        buffered = []
      } else {
        restoredPage = true
        yield page
      }
    }
    if (buffered.length > 0 && (!deferredAnchor || cursor?.complete)) {
      restoredPage = true
      yield { messages: buffered, startIndex: cursor?.startIndex ?? 0, totalCount: cursor?.totalCount ?? buffered.length, done: true, complete: cursor?.complete ?? true }
    }
  } finally {
    if (activeRestores.get(key) === token) {
      activeRestores.delete(key)
      if (!restoredPage) setRestoreActive(key, false)
    }
  }
}

export async function cacheAuthoritativeSessionMessages(
  instanceId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<void> {
  if (!isSessionMessageCacheEnabled()) return
  await enqueueSessionMessageCacheWrite(instanceId, sessionId, { expectedRevision, allowEmpty: true })
}

export function scheduleSessionMessageCacheWrite(instanceId: string, sessionId: string): void {
  if (!isSessionMessageCacheEnabled()) return
  const key = pendingKey(instanceId, sessionId)
  const instanceToken = instances().get(instanceId)
  const workspace = instanceToken?.folder
  if (!instanceToken || !workspace) return
  const entryKey = createSessionMessageCacheKey(workspace, sessionId)
  const invalidationVersion = invalidationVersions.get(entryKey) ?? 0
  const existing = pendingWrites.get(key)
  if (existing) clearTimeout(existing)
  pendingWrites.set(key, setTimeout(() => {
    pendingWrites.delete(key)
    if (instances().get(instanceId) !== instanceToken) return
    if ((invalidationVersions.get(entryKey) ?? 0) !== invalidationVersion) return
    void enqueueSessionMessageCacheWrite(instanceId, sessionId)
  }, WRITE_DEBOUNCE_MS))
}

export function invalidateSessionMessageCache(instanceId: string, sessionId: string): void {
  const key = pendingKey(instanceId, sessionId)
  cancelCachedSessionMessageRestore(instanceId, sessionId)
  cacheGenerations.set(key, cacheGeneration(key) + 1)
  const pending = pendingWrites.get(key)
  if (pending) {
    clearTimeout(pending)
    pendingWrites.delete(key)
  }
  const queued = queuedWrites.get(key)
  if (queued) {
    queuedWrites.delete(key)
    queued.done.forEach((resolve) => resolve())
  }
  const workspace = workspaceForInstance(instanceId)
  if (!workspace) return
  const entryKey = createSessionMessageCacheKey(workspace, sessionId)
  const invalidationVersion = (invalidationVersions.get(entryKey) ?? 0) + 1
  invalidationVersions.set(entryKey, invalidationVersion)
  pendingEntryInvalidations.set(entryKey, invalidationVersion)
  invalidatedEntries.add(entryKey)
  const invalidation = deleteSessionMessageCache(workspace, sessionId)
    .then(() => {
      if ((invalidationVersions.get(entryKey) ?? 0) === invalidationVersion) invalidatedEntries.delete(entryKey)
    })
    .catch((error) => log.warn("Failed to invalidate cached session messages", { instanceId, sessionId, error }))
    .finally(() => {
      if (pendingInvalidations.get(key) === invalidation) pendingInvalidations.delete(key)
      if (pendingEntryInvalidations.get(entryKey) === invalidationVersion) pendingEntryInvalidations.delete(entryKey)
    })
  pendingInvalidations.set(key, invalidation)
}

function resetPendingSessionMessageCacheWork(): void {
  resetGeneration += 1
  activeRestores.clear()
  setRestoringSessions(new Set<string>())
  for (const timer of pendingWrites.values()) clearTimeout(timer)
  pendingWrites.clear()
  for (const request of queuedWrites.values()) request.done.forEach((resolve) => resolve())
  queuedWrites.clear()
  pendingInvalidations.clear()
  invalidatedEntries.clear()
  invalidationVersions.clear()
  pendingEntryInvalidations.clear()
}

onSessionMessageCacheReset(resetPendingSessionMessageCacheWork)

messageStoreBus.onInstanceDestroyed((instanceId) => {
  const prefix = `${instanceId}:`
  for (const [key, timer] of pendingWrites) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(timer)
    pendingWrites.delete(key)
  }
  for (const [key, request] of queuedWrites) {
    if (!key.startsWith(prefix)) continue
    queuedWrites.delete(key)
    request.done.forEach((resolve) => resolve())
  }
  for (const key of cacheGenerations.keys()) {
    if (key.startsWith(prefix)) cacheGenerations.set(key, cacheGeneration(key) + 1)
  }
  for (const key of activeRestores.keys()) {
    if (key.startsWith(prefix)) activeRestores.delete(key)
  }
  setRestoringSessions((current) => new Set([...current].filter((key) => !key.startsWith(prefix))))
})
