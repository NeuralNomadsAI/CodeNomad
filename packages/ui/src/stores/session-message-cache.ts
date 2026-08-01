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
  markSessionMessageCacheUnsafe,
  setSessionMessageCacheEnabled,
} from "../lib/session-message-cache"
import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import { instances } from "./instances"
import { isInstanceRuntimeCurrent } from "./instances"
import type { Instance } from "../types/instance"
import { messageStoreBus } from "./message-v2/bus"
import { estimateRetainedBytes } from "../lib/session-memory-budget"

const log = getLogger("session")
const WRITE_DEBOUNCE_MS = 500

function disablePersistentCacheAfterInvalidationFailure(context: Record<string, unknown>): void {
  markSessionMessageCacheUnsafe(true)
  setSessionMessageCacheEnabled(false)
  log.warn("Disabled persistent session message cache after invalidation failure", context)
}
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()
const cacheGenerations = new Map<string, number>()
const pendingInvalidations = new Map<string, Promise<void>>()
const invalidatedEntries = new Set<string>()
const invalidationVersions = new Map<string, number>()
const pendingEntryInvalidations = new Map<string, number>()
const activeEntryInvalidations = new Map<string, Promise<void>>()
const entryInvalidationKeys = new Map<string, Set<string>>()
const trailingEntryInvalidations = new Map<string, { instanceId: string; sessionId: string; workspace: string }>()
const activeRestores = new Map<string, symbol>()
type CacheWriteRequest = {
  instanceId: string
  sessionId: string
  expectedRevision?: number
  allowEmpty: boolean
  generation: number
  reset: number
  instanceToken: Instance
  workspace: string
  entryKey: string
  invalidationVersion: number
  done: Array<() => void>
}
const queuedWrites = new Map<string, CacheWriteRequest>()
const activeWriteKeys = new Map<string, string>()
let writeWorkerRunning = false
const [restoringSessions, setRestoringSessions] = createSignal<ReadonlySet<string>>(new Set())
let resetGeneration = 0
let writeSettledCallback: (() => void) | undefined

function pendingKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function cacheGeneration(key: string): number {
  return cacheGenerations.get(key) ?? 0
}

function normalizedWorkspace(workspace: string): string {
  const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized
}

function hasSingleWorkspaceOwner(instanceId: string, workspace: string): boolean {
  const expected = normalizedWorkspace(workspace)
  let owners = 0
  for (const instance of instances().values()) {
    if (normalizedWorkspace(instance.folder) !== expected) continue
    owners += 1
    if (owners > 1) return false
  }
  return owners === 1 && normalizedWorkspace(instances().get(instanceId)?.folder ?? "") === expected
}

function cleanupCacheFenceState(key: string, entryKey: string): void {
  if (!pendingWrites.has(key) && !queuedWrites.has(key) && !activeWriteKeys.has(key) && !activeRestores.has(key) && !pendingInvalidations.has(key)) {
    cacheGenerations.delete(key)
  }
  if (
    !pendingEntryInvalidations.has(entryKey) &&
    ![...queuedWrites.values()].some((request) => request.entryKey === entryKey) &&
    ![...activeWriteKeys.values()].includes(entryKey)
  ) invalidationVersions.delete(entryKey)
}

export function setSessionMessageCacheWriteSettledCallback(callback: () => void): void {
  writeSettledCallback = callback
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

function snapshotSession(
  instanceId: string,
  sessionId: string,
  allowEmpty = false,
): { messages: unknown[]; startIndex: number; totalCount: number } | null {
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
  return result.length > 0 || messageIds.length === 0
    ? { messages: result, startIndex: messageIds.length - result.length, totalCount: messageIds.length }
    : null
}

async function drainQueuedWrites(): Promise<void> {
  if (writeWorkerRunning) return
  writeWorkerRunning = true
  try {
    while (queuedWrites.size > 0) {
      const [key, request] = queuedWrites.entries().next().value as [string, CacheWriteRequest]
      queuedWrites.delete(key)
      activeWriteKeys.set(key, request.entryKey)
      try {
        await waitForIdle()
        if (cacheGeneration(key) !== request.generation || resetGeneration !== request.reset) continue
        if (!isInstanceRuntimeCurrent(request.instanceId, request.instanceToken)) continue
        if ((invalidationVersions.get(request.entryKey) ?? 0) !== request.invalidationVersion) continue
        if (!hasSingleWorkspaceOwner(request.instanceId, request.workspace)) {
          await deleteSessionMessageCache(request.workspace, request.sessionId)
          continue
        }
        const store = messageStoreBus.getInstance(request.instanceId)
        if (!store) continue
        if (request.expectedRevision !== undefined && store.getSessionRevision(request.sessionId) !== request.expectedRevision) {
          await deleteSessionMessageCache(request.workspace, request.sessionId)
          continue
        }
        const snapshot = snapshotSession(request.instanceId, request.sessionId, request.allowEmpty)
        if (!snapshot) {
          await deleteSessionMessageCache(request.workspace, request.sessionId)
          continue
        }
        const written = await writeSessionMessageCache(
          request.workspace,
          request.sessionId,
          snapshot.messages,
          { startIndex: snapshot.startIndex, totalCount: snapshot.totalCount },
        )
        if (
          written &&
          cacheGeneration(key) === request.generation &&
          resetGeneration === request.reset &&
          isInstanceRuntimeCurrent(request.instanceId, request.instanceToken) &&
          (invalidationVersions.get(request.entryKey) ?? 0) === request.invalidationVersion &&
          pendingEntryInvalidations.get(request.entryKey) !== request.invalidationVersion
        ) invalidatedEntries.delete(request.entryKey)
      } catch (error) {
        log.warn("Failed to cache completed session messages", { instanceId: request.instanceId, sessionId: request.sessionId, error })
      } finally {
        activeWriteKeys.delete(key)
        cleanupCacheFenceState(key, request.entryKey)
        writeSettledCallback?.()
        request.done.forEach((resolve) => resolve())
      }
    }
  } finally {
    writeWorkerRunning = false
    if (queuedWrites.size > 0) void drainQueuedWrites()
  }
}

export function isSessionMessageCacheWritePending(instanceId: string, sessionId: string): boolean {
  const key = pendingKey(instanceId, sessionId)
  return pendingWrites.has(key) || queuedWrites.has(key) || activeWriteKeys.has(key)
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
  if (!hasSingleWorkspaceOwner(instanceId, workspace)) {
    invalidateSessionMessageCache(instanceId, sessionId)
    return Promise.resolve()
  }
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
  const instanceToken = instances().get(instanceId)
  const workspace = instanceToken?.folder
  if (!workspace) return
  if (!hasSingleWorkspaceOwner(instanceId, workspace)) return
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
      isInstanceRuntimeCurrent(instanceId, instanceToken) &&
      activeRestores.get(key) === token &&
      cacheGeneration(key) === generation &&
      resetGeneration === reset &&
      !invalidatedEntries.has(entryKey)
    ) {
      const result = await readSessionMessageCachePage(cursor)
      if (!result) return
      if (
        !isInstanceRuntimeCurrent(instanceId, instanceToken) ||
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
  if (!hasSingleWorkspaceOwner(instanceId, workspace)) {
    invalidateSessionMessageCache(instanceId, sessionId)
    return
  }
  const entryKey = createSessionMessageCacheKey(workspace, sessionId)
  const invalidationVersion = invalidationVersions.get(entryKey) ?? 0
  const existing = pendingWrites.get(key)
  if (existing) clearTimeout(existing)
  pendingWrites.set(key, setTimeout(() => {
    pendingWrites.delete(key)
    if (!isInstanceRuntimeCurrent(instanceId, instanceToken)) return
    if ((invalidationVersions.get(entryKey) ?? 0) !== invalidationVersion) return
    void enqueueSessionMessageCacheWrite(instanceId, sessionId)
  }, WRITE_DEBOUNCE_MS))
}

export function invalidateSessionMessageCache(instanceId: string, sessionId: string): void {
  if (!isSessionMessageCacheEnabled()) return
  const key = pendingKey(instanceId, sessionId)
  cancelCachedSessionMessageRestore(instanceId, sessionId)
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
  const generation = cacheGeneration(key) + 1
  cacheGenerations.set(key, generation)
  const activeInvalidation = activeEntryInvalidations.get(entryKey)
  if (activeInvalidation) {
    invalidatedEntries.add(entryKey)
    trailingEntryInvalidations.set(entryKey, { instanceId, sessionId, workspace })
    const keys = entryInvalidationKeys.get(entryKey) ?? new Set<string>()
    keys.add(key)
    entryInvalidationKeys.set(entryKey, keys)
    pendingInvalidations.set(key, activeInvalidation)
    return
  }
  const invalidationVersion = (invalidationVersions.get(entryKey) ?? 0) + 1
  invalidationVersions.set(entryKey, invalidationVersion)
  pendingEntryInvalidations.set(entryKey, invalidationVersion)
  invalidatedEntries.add(entryKey)
  const invalidation = deleteSessionMessageCache(workspace, sessionId)
    .catch((error) => {
      log.warn("Failed to invalidate cached session messages; disabling persistent cache", { instanceId, sessionId, error })
      disablePersistentCacheAfterInvalidationFailure({ instanceId, sessionId })
    })
    .finally(() => {
      if (activeEntryInvalidations.get(entryKey) === invalidation) activeEntryInvalidations.delete(entryKey)
      if (pendingEntryInvalidations.get(entryKey) === invalidationVersion) pendingEntryInvalidations.delete(entryKey)
      const keys = entryInvalidationKeys.get(entryKey) ?? new Set([key])
      entryInvalidationKeys.delete(entryKey)
      for (const pendingKey of keys) {
        if (pendingInvalidations.get(pendingKey) === invalidation) pendingInvalidations.delete(pendingKey)
        cleanupCacheFenceState(pendingKey, entryKey)
      }
      const trailing = trailingEntryInvalidations.get(entryKey)
      trailingEntryInvalidations.delete(entryKey)
      if (trailing && isSessionMessageCacheEnabled()) {
        queueMicrotask(() => {
          if (workspaceForInstance(trailing.instanceId)) {
            invalidateSessionMessageCache(trailing.instanceId, trailing.sessionId)
            return
          }
          void deleteSessionMessageCache(trailing.workspace, trailing.sessionId)
            .then(() => invalidatedEntries.delete(entryKey))
            .catch((error) => {
              log.warn("Failed trailing cached session invalidation; disabling persistent cache", { sessionId: trailing.sessionId, error })
              disablePersistentCacheAfterInvalidationFailure({ sessionId: trailing.sessionId })
            })
        })
      } else if ((invalidationVersions.get(entryKey) ?? 0) === invalidationVersion) {
        invalidatedEntries.delete(entryKey)
      }
    })
  activeEntryInvalidations.set(entryKey, invalidation)
  entryInvalidationKeys.set(entryKey, new Set([key]))
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
  activeWriteKeys.clear()
  pendingInvalidations.clear()
  invalidatedEntries.clear()
  invalidationVersions.clear()
  pendingEntryInvalidations.clear()
  activeEntryInvalidations.clear()
  entryInvalidationKeys.clear()
  trailingEntryInvalidations.clear()
  cacheGenerations.clear()
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
  for (const key of cacheGenerations.keys()) if (key.startsWith(prefix)) cacheGenerations.delete(key)
  for (const key of activeRestores.keys()) {
    if (key.startsWith(prefix)) activeRestores.delete(key)
  }
  setRestoringSessions((current) => new Set([...current].filter((key) => !key.startsWith(prefix))))
})
