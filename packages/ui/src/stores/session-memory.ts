import { getLogger } from "../lib/logger"
import { MAX_HOT_SESSION_MESSAGE_BYTES, selectSessionMemoryEvictions, type SessionMemoryEntry } from "../lib/session-memory-budget"
import { messageStoreBus } from "./message-v2/bus"
import { cancelCachedSessionMessageRestore, isRestoringCachedSessionMessages } from "./session-message-cache"
import { isSessionMessagesLoading, sessions } from "./session-state"

const log = getLogger("session")
const SWEEP_DELAY_MS = 1_000
const touched = new Map<string, number>()
const visibleLeases = new Map<string, number>()
let sequence = 0
let sweepTimer: ReturnType<typeof setTimeout> | undefined

function sessionKey(instanceId: string, sessionId: string): string {
  return `${instanceId}\u0000${sessionId}`
}

function splitSessionKey(key: string): [string, string] {
  const separator = key.indexOf("\u0000")
  return [key.slice(0, separator), key.slice(separator + 1)]
}

function hasProtectedSessionWork(
  store: ReturnType<typeof messageStoreBus.getOrCreate>,
  sessionId: string,
  status: string | undefined,
): boolean {
  return status === "idle" ? store.hasSessionPendingInput(sessionId) : store.hasSessionActiveWork(sessionId)
}

export function scheduleSessionMemorySweep(): void {
  if (sweepTimer) return
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined
    runSessionMemorySweep()
  }, SWEEP_DELAY_MS)
}

export function setVisibleSessionMemory(instanceId: string, sessionId: string, isVisible: boolean): void {
  const key = sessionKey(instanceId, sessionId)
  if (isVisible) {
    visibleLeases.set(key, (visibleLeases.get(key) ?? 0) + 1)
    touched.set(key, ++sequence)
  } else {
    const leases = visibleLeases.get(key) ?? 0
    if (leases <= 1) visibleLeases.delete(key)
    else visibleLeases.set(key, leases - 1)
  }
  scheduleSessionMemorySweep()
}

export function evictResidentSessionMessages(instanceId: string, sessionId: string): boolean {
  const store = messageStoreBus.getInstance(instanceId)
  const status = sessions().get(instanceId)?.get(sessionId)?.status
  if (
    !store ||
    visibleLeases.has(sessionKey(instanceId, sessionId)) ||
    status === "working" ||
    status === "compacting" ||
    hasProtectedSessionWork(store, sessionId, status)
  ) return false
  cancelCachedSessionMessageRestore(instanceId, sessionId)
  store.clearSession(sessionId, { preserveScroll: true })
  log.info("Evicted resident session messages", { instanceId, sessionId })
  return true
}

export function runSessionMemorySweep(byteLimit = MAX_HOT_SESSION_MESSAGE_BYTES): string[] {
  const entries: SessionMemoryEntry[] = []
  for (const [instanceId, store] of messageStoreBus.entries()) {
    for (const sessionId of store.getResidentSessionIds()) {
      const key = sessionKey(instanceId, sessionId)
      const status = sessions().get(instanceId)?.get(sessionId)?.status
      entries.push({
        key,
        byteSize: store.getSessionApproximateByteSize(sessionId),
        lastTouched: touched.get(key) ?? 0,
        protected: visibleLeases.has(key) || status === "working" || status === "compacting" || hasProtectedSessionWork(store, sessionId, status) ||
          isSessionMessagesLoading(instanceId, sessionId) || isRestoringCachedSessionMessages(instanceId, sessionId),
      })
    }
  }

  const evicted: string[] = []
  for (const key of selectSessionMemoryEvictions(entries, byteLimit)) {
    const [instanceId, sessionId] = splitSessionKey(key)
    if (evictResidentSessionMessages(instanceId, sessionId)) evicted.push(key)
  }
  return evicted
}

messageStoreBus.onSessionChanged((instanceId, sessionId) => {
  touched.set(sessionKey(instanceId, sessionId), ++sequence)
  scheduleSessionMemorySweep()
})

messageStoreBus.onSessionCleared((instanceId, sessionId) => {
  const key = sessionKey(instanceId, sessionId)
  touched.delete(key)
  visibleLeases.delete(key)
})

messageStoreBus.onInstanceDestroyed((instanceId) => {
  const prefix = `${instanceId}\u0000`
  for (const key of touched.keys()) if (key.startsWith(prefix)) touched.delete(key)
  for (const key of visibleLeases.keys()) if (key.startsWith(prefix)) visibleLeases.delete(key)
})
