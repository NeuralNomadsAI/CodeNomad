import {
  deleteSessionMessageCache,
  createSessionMessageCacheKey,
  type SessionMessageCachePage,
  isSessionMessageCacheEnabled,
  onSessionMessageCacheReset,
  openSessionMessageCache,
  readSessionMessageCachePage,
  writeSessionMessageCache,
} from "../lib/session-message-cache"
import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import { instances } from "./instances"
import { messageStoreBus } from "./message-v2/bus"

const log = getLogger("session")
const WRITE_DEBOUNCE_MS = 500
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()
const cacheGenerations = new Map<string, number>()
const pendingInvalidations = new Map<string, Promise<void>>()
const invalidatedEntries = new Set<string>()
const activeRestores = new Map<string, symbol>()
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

function snapshotSession(instanceId: string, sessionId: string): unknown[] | null {
  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return null

  const result: unknown[] = []
  for (const messageId of store.getSessionMessageIds(sessionId)) {
    const record = store.getMessage(messageId)
    const info = store.getMessageInfo(messageId)
    if (!record || !info || record.isEphemeral || record.status === "sending" || record.status === "streaming") return null

    const parts = record.partIds.map((partId) => record.parts[partId]?.data).filter(Boolean).map((part) => {
      const { renderCache: _renderCache, pendingPermission: _pendingPermission, ...cacheable } = part as any
      return cacheable
    })
    result.push({ info, parts })
  }
  return result
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
    if (buffered.length > 0) {
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
  messages: unknown[],
  expectedRevision: number,
): Promise<void> {
  if (!isSessionMessageCacheEnabled()) return
  const store = messageStoreBus.getInstance(instanceId)
  if (!store) return
  const workspace = workspaceForInstance(instanceId)
  if (!workspace) return
  const key = pendingKey(instanceId, sessionId)
  const entryKey = createSessionMessageCacheKey(workspace, sessionId)
  const generation = cacheGeneration(key)
  const reset = resetGeneration
  await waitForIdle()
  if (
    cacheGeneration(key) !== generation ||
    resetGeneration !== reset ||
    messageStoreBus.getInstance(instanceId) !== store ||
    store.getSessionRevision(sessionId) !== expectedRevision
  ) return
  const written = await writeSessionMessageCache(workspace, sessionId, messages)
  if (written && cacheGeneration(key) === generation && resetGeneration === reset) {
    invalidatedEntries.delete(entryKey)
  }
}

export function scheduleSessionMessageCacheWrite(instanceId: string, sessionId: string): void {
  if (!isSessionMessageCacheEnabled()) return
  const key = pendingKey(instanceId, sessionId)
  const existing = pendingWrites.get(key)
  if (existing) clearTimeout(existing)
  pendingWrites.set(key, setTimeout(() => {
    pendingWrites.delete(key)
    const workspace = workspaceForInstance(instanceId)
    const messages = snapshotSession(instanceId, sessionId)
    if (!workspace || !messages) return
    const generation = cacheGeneration(key)
    const reset = resetGeneration
    const entryKey = createSessionMessageCacheKey(workspace, sessionId)
    void writeSessionMessageCache(workspace, sessionId, messages)
      .then((written) => {
        if (written && cacheGeneration(key) === generation && resetGeneration === reset) {
          invalidatedEntries.delete(entryKey)
        }
      })
      .catch((error) => log.warn("Failed to cache completed session messages", { instanceId, sessionId, error }))
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
  const workspace = workspaceForInstance(instanceId)
  if (!workspace) return
  const entryKey = createSessionMessageCacheKey(workspace, sessionId)
  invalidatedEntries.add(entryKey)
  const invalidation = deleteSessionMessageCache(workspace, sessionId)
    .then(() => { invalidatedEntries.delete(entryKey) })
    .catch((error) => log.warn("Failed to invalidate cached session messages", { instanceId, sessionId, error }))
    .finally(() => {
      if (pendingInvalidations.get(key) === invalidation) pendingInvalidations.delete(key)
    })
  pendingInvalidations.set(key, invalidation)
}

function resetPendingSessionMessageCacheWork(): void {
  resetGeneration += 1
  activeRestores.clear()
  setRestoringSessions(new Set<string>())
  for (const timer of pendingWrites.values()) clearTimeout(timer)
  pendingWrites.clear()
}

onSessionMessageCacheReset(resetPendingSessionMessageCacheWork)

messageStoreBus.onInstanceDestroyed((instanceId) => {
  const prefix = `${instanceId}:`
  for (const [key, timer] of pendingWrites) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(timer)
    pendingWrites.delete(key)
  }
  for (const key of cacheGenerations.keys()) {
    if (key.startsWith(prefix)) cacheGenerations.set(key, cacheGeneration(key) + 1)
  }
  for (const key of activeRestores.keys()) {
    if (key.startsWith(prefix)) activeRestores.delete(key)
  }
  setRestoringSessions((current) => new Set([...current].filter((key) => !key.startsWith(prefix))))
  for (const key of pendingInvalidations.keys()) {
    if (key.startsWith(prefix)) pendingInvalidations.delete(key)
  }
})
