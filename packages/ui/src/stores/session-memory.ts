import { getLogger } from "../lib/logger"
import { MAX_HOT_SESSION_MESSAGE_BYTES, selectSessionMemoryEvictions, type SessionMemoryEntry } from "../lib/session-memory-budget"
import { messageStoreBus } from "./message-v2/bus"
import { isSessionMessagesLoading, sessions } from "./session-state"

const log = getLogger("session")
const SWEEP_DELAY_MS = 1_000
const touched = new Map<string, number>()
const visibleLeases = new Map<string, number>()
const measuredBytes = new Map<string, number>()
const pendingMeasurements = new Map<string, { idle: boolean; handle: number | ReturnType<typeof setTimeout> }>()
let sequence = 0
let sweepTimer: ReturnType<typeof setTimeout> | undefined

function cancelSessionMeasurement(key: string): void {
  const pending = pendingMeasurements.get(key)
  if (!pending) return
  if (pending.idle) (globalThis as any).cancelIdleCallback?.(pending.handle)
  else clearTimeout(pending.handle)
  pendingMeasurements.delete(key)
}

function scheduleSessionMeasurement(instanceId: string, sessionId: string): void {
  const key = sessionKey(instanceId, sessionId)
  if (pendingMeasurements.has(key)) return
  const measure = () => {
    pendingMeasurements.delete(key)
    const store = messageStoreBus.getInstance(instanceId)
    if (!store?.getResidentSessionIds().includes(sessionId)) return
    measuredBytes.set(key, store.getSessionApproximateByteSize(sessionId))
    scheduleSessionMemorySweep()
  }
  if (typeof (globalThis as any).requestIdleCallback === "function") {
    const handle = (globalThis as any).requestIdleCallback(measure, { timeout: 2_000 }) as number
    pendingMeasurements.set(key, { idle: true, handle })
  } else {
    const handle = setTimeout(measure, 50)
    pendingMeasurements.set(key, { idle: false, handle })
  }
}

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
): boolean {
  return store.hasSessionActiveWork(sessionId)
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
    isSessionMessagesLoading(instanceId, sessionId) ||
    hasProtectedSessionWork(store, sessionId)
  ) return false
  store.clearSession(sessionId, { preserveScroll: true, preservePromptDisplay: true })
  log.info("Evicted resident session messages", { instanceId, sessionId })
  return true
}

export function runSessionMemorySweep(byteLimit = MAX_HOT_SESSION_MESSAGE_BYTES): string[] {
  const entries: SessionMemoryEntry[] = []
  for (const [instanceId, store] of messageStoreBus.entries()) {
    for (const sessionId of store.getResidentSessionIds()) {
      const key = sessionKey(instanceId, sessionId)
      const status = sessions().get(instanceId)?.get(sessionId)?.status
      const protectedSession = visibleLeases.has(key) || status === "working" || status === "compacting" || hasProtectedSessionWork(store, sessionId) ||
        isSessionMessagesLoading(instanceId, sessionId)
      let byteSize = measuredBytes.get(key)
      if (!protectedSession) {
        byteSize = store.getSessionApproximateByteSize(sessionId)
        measuredBytes.set(key, byteSize)
      }
      byteSize ??= byteLimit
      entries.push({
        key,
        // ponytail: reuse the last full measurement while a protected session is changing rapidly.
        byteSize,
        lastTouched: touched.get(key) ?? 0,
        protected: protectedSession,
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
  scheduleSessionMeasurement(instanceId, sessionId)
  scheduleSessionMemorySweep()
})

messageStoreBus.onSessionCleared((instanceId, sessionId) => {
  const key = sessionKey(instanceId, sessionId)
  touched.delete(key)
  visibleLeases.delete(key)
  measuredBytes.delete(key)
  cancelSessionMeasurement(key)
})

messageStoreBus.onInstanceDestroyed((instanceId) => {
  const prefix = `${instanceId}\u0000`
  for (const key of touched.keys()) if (key.startsWith(prefix)) touched.delete(key)
  for (const key of visibleLeases.keys()) if (key.startsWith(prefix)) visibleLeases.delete(key)
  for (const key of measuredBytes.keys()) if (key.startsWith(prefix)) measuredBytes.delete(key)
  for (const key of pendingMeasurements.keys()) if (key.startsWith(prefix)) cancelSessionMeasurement(key)
})
