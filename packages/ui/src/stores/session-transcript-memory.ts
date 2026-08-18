import { createEffect, createRoot } from "solid-js"
import { getLogger } from "../lib/logger"
import { onCacheSessionChanged } from "../lib/global-cache"
import { SessionTranscriptMeasurementQueue } from "../lib/session-transcript-measurement"
import { isSessionTranscriptProtected, SessionTranscriptLru } from "../lib/session-transcript-lru"
import { messageStoreBus } from "./message-v2/bus"
import { loading, sessions } from "./session-state"
import { clearNativeContentDeltaState, estimateNativeContentDeltaRetainedBytes } from "./native-session-streaming"

// Inactive transcript budget. Protected active/live 200-message windows retain authoritative content and may exceed it.
export const SESSION_TRANSCRIPT_BYTE_BUDGET = 64 * 1024 * 1024

const log = getLogger("session")
const visible = new Map<string, number>()
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
    clearNativeContentDeltaState(instanceId, sessionId)
    messageStoreBus.getInstance(instanceId)?.evictSessionTranscript(sessionId)
  },
})

const measurements = new SessionTranscriptMeasurementQueue({
  delayMs: 100,
  measure: async (instanceId, sessionId, signal) => {
    const transcriptBytes = await messageStoreBus.getInstance(instanceId)?.estimateSessionRetainedBytes(sessionId, signal) ?? 0
    if (!Number.isFinite(transcriptBytes)) return transcriptBytes
    const nativeBytes = await estimateNativeContentDeltaRetainedBytes(instanceId, sessionId, signal)
    return Number.isFinite(nativeBytes) ? transcriptBytes + nativeBytes : nativeBytes
  },
  account: (instanceId, sessionId, bytes) => coordinator.account(instanceId, sessionId, bytes),
  onError: (instanceId, sessionId, error) => {
    log.warn("Failed to measure session transcript", { instanceId, sessionId, error })
  },
})

export function accountSessionTranscript(instanceId: string, sessionId: string): void {
  measurements.schedule(instanceId, sessionId)
}

export function touchSessionTranscript(instanceId: string, sessionId: string): void {
  coordinator.touch(instanceId, sessionId)
  measurements.schedule(instanceId, sessionId)
}

export function setSessionTranscriptVisible(instanceId: string, sessionId: string, value: boolean): void {
  const entryKey = key(instanceId, sessionId)
  if (value) {
    visible.set(entryKey, (visible.get(entryKey) ?? 0) + 1)
    touchSessionTranscript(instanceId, sessionId)
  } else {
    const count = (visible.get(entryKey) ?? 0) - 1
    if (count > 0) visible.set(entryKey, count)
    else visible.delete(entryKey)
    measurements.schedule(instanceId, sessionId)
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
onCacheSessionChanged(accountSessionTranscript)
messageStoreBus.onSessionCleared((instanceId, sessionId) => {
  measurements.cancel(instanceId, sessionId)
  coordinator.forget(instanceId, sessionId)
})
messageStoreBus.onInstanceDestroyed((instanceId) => {
  coordinator.forgetInstance(instanceId)
  for (const entryKey of visible.keys()) {
    if (entryKey.startsWith(`${instanceId}\u0000`)) visible.delete(entryKey)
  }
  measurements.cancelInstance(instanceId)
})
