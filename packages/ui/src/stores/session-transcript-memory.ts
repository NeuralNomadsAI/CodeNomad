import { createEffect, createRoot } from "solid-js"
import { getLogger } from "../lib/logger"
import { isSessionTranscriptProtected, SessionTranscriptLru } from "../lib/session-transcript-lru"
import { messageStoreBus } from "./message-v2/bus"
import { loading, sessions } from "./session-state"

export const SESSION_TRANSCRIPT_BYTE_BUDGET = 64 * 1024 * 1024

const log = getLogger("session")
const visible = new Map<string, number>()
const pendingMeasurements = new Map<string, { timer: ReturnType<typeof setTimeout>; controller: AbortController }>()
const key = (instanceId: string, sessionId: string) => `${instanceId}\u0000${sessionId}`

const coordinator = new SessionTranscriptLru({
  byteBudget: SESSION_TRANSCRIPT_BYTE_BUDGET,
  isProtected: (instanceId, sessionId) => {
    const session = sessions().get(instanceId)?.get(sessionId)
    return isSessionTranscriptProtected({
      visible: visible.has(key(instanceId, sessionId)),
      loading: loading().loadingMessages.get(instanceId)?.has(sessionId),
      status: session?.status,
      generationPending: session?.generationAdmissionToken !== undefined || session?.generationRecovery === "pending",
      permissionBlocked: session?.pendingPermission,
      questionBlocked: session?.pendingQuestion,
      liveMessages: messageStoreBus.getInstance(instanceId)?.hasLiveSessionMessages(sessionId),
    })
  },
  evict: (instanceId, sessionId) => {
    log.info("Evicting inactive session transcript", { instanceId, sessionId })
    messageStoreBus.getInstance(instanceId)?.clearSession(sessionId, { preserveScroll: true })
  },
})

export function accountSessionTranscript(instanceId: string, sessionId: string): void {
  const entryKey = key(instanceId, sessionId)
  const previous = pendingMeasurements.get(entryKey)
  if (previous) {
    clearTimeout(previous.timer)
    previous.controller.abort()
  }
  const controller = new AbortController()
  const timer = setTimeout(async () => {
    try {
      const bytes = await messageStoreBus.getInstance(instanceId)?.estimateSessionRetainedBytes(sessionId, controller.signal)
      if (!controller.signal.aborted && pendingMeasurements.get(entryKey)?.controller === controller) {
        coordinator.account(instanceId, sessionId, bytes ?? 0)
      }
    } catch (error) {
      if (!controller.signal.aborted) log.warn("Failed to measure session transcript", { instanceId, sessionId, error })
    } finally {
      if (pendingMeasurements.get(entryKey)?.controller === controller) pendingMeasurements.delete(entryKey)
    }
  }, 100)
  pendingMeasurements.set(entryKey, { timer, controller })
}

export function touchSessionTranscript(instanceId: string, sessionId: string): void {
  coordinator.touch(instanceId, sessionId)
}

export function setSessionTranscriptVisible(instanceId: string, sessionId: string, value: boolean): void {
  const entryKey = key(instanceId, sessionId)
  if (value) {
    visible.set(entryKey, (visible.get(entryKey) ?? 0) + 1)
    coordinator.touch(instanceId, sessionId)
  } else {
    const count = (visible.get(entryKey) ?? 0) - 1
    if (count > 0) visible.set(entryKey, count)
    else visible.delete(entryKey)
  }
  coordinator.enforce()
}

export function reconcileSessionTranscriptBudget(): void {
  coordinator.enforce()
}

createRoot(() => createEffect(() => {
  loading()
  sessions()
  queueMicrotask(() => coordinator.enforce())
}))

messageStoreBus.onSessionChanged(accountSessionTranscript)
messageStoreBus.onSessionCleared((instanceId, sessionId) => {
  const entryKey = key(instanceId, sessionId)
  const pending = pendingMeasurements.get(entryKey)
  if (pending) {
    clearTimeout(pending.timer)
    pending.controller.abort()
  }
  pendingMeasurements.delete(entryKey)
  coordinator.forget(instanceId, sessionId)
})
messageStoreBus.onInstanceDestroyed((instanceId) => {
  coordinator.forgetInstance(instanceId)
  for (const entryKey of visible.keys()) {
    if (entryKey.startsWith(`${instanceId}\u0000`)) visible.delete(entryKey)
  }
  for (const [entryKey, pending] of pendingMeasurements) {
    if (!entryKey.startsWith(`${instanceId}\u0000`)) continue
    clearTimeout(pending.timer)
    pending.controller.abort()
    pendingMeasurements.delete(entryKey)
  }
})
