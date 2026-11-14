import { createEffect, createRoot } from "solid-js"
import { getLogger } from "../lib/logger"
import { onCacheSessionChanged } from "../lib/global-cache"
import { SessionTranscriptMeasurementQueue } from "../lib/session-transcript-measurement"
import { isSessionTranscriptProtected, SessionTranscriptLru } from "../lib/session-transcript-lru"
import { messageStoreBus } from "./message-v2/bus"
import { loading, sessions } from "./session-state"
import { destroyOpenCodeData } from "./opencode-data"
import { cancelTranscriptProjections } from "./opencode-projection-frame"
import { isSessionTranscriptVisible, releaseSessionTranscriptVisible, retainSessionTranscriptVisible, clearInstanceTranscriptVisible } from "./session-transcript-visibility"

// Inactive transcript budget. Protected active/live 200-message windows retain authoritative content and may exceed it.
export const SESSION_TRANSCRIPT_BYTE_BUDGET = 64 * 1024 * 1024

const log = getLogger("session")

const coordinator = new SessionTranscriptLru({
  byteBudget: SESSION_TRANSCRIPT_BYTE_BUDGET,
  isProtected: (instanceId, sessionId) => {
    const session = sessions().get(instanceId)?.get(sessionId)
    return isSessionTranscriptProtected({
      visible: isSessionTranscriptVisible(instanceId, sessionId),
      loading: loading().loadingMessages.get(instanceId)?.has(sessionId),
      status: session?.status,
      generationPending: session?.generationAdmissionToken !== undefined || session?.generationRecovery === "pending",
      permissionBlocked: session?.pendingPermission,
      questionBlocked: session?.pendingForm,
      liveMessages: messageStoreBus.getInstance(instanceId)?.hasLiveSessionMessages(sessionId),
    })
  },
  evict: (instanceId, sessionId) => {
    log.info("Evicting inactive session transcript", { instanceId, sessionId })
    cancelTranscriptProjections(instanceId, sessionId)
    destroyOpenCodeData(instanceId, sessionId)
    messageStoreBus.getInstance(instanceId)?.evictSessionTranscript(sessionId)
  },
})

const measurements = new SessionTranscriptMeasurementQueue({
  // Deferred-highlight cache commits land every ~150-350ms while a mounted
  // burst drains; a shorter quiet window would keep aborting and restarting
  // the retained-graph walk mid-drain. The trailing debounce plus this
  // window collapses a switch's measurement storm into one final walk.
  delayMs: 500,
  measure: async (instanceId, sessionId, signal) => {
    return messageStoreBus.getInstance(instanceId)?.estimateSessionRetainedBytes(sessionId, signal) ?? 0
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
  if (value) {
    retainSessionTranscriptVisible(instanceId, sessionId)
    touchSessionTranscript(instanceId, sessionId)
  } else {
    releaseSessionTranscriptVisible(instanceId, sessionId)
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
  clearInstanceTranscriptVisible(instanceId)
  measurements.cancelInstance(instanceId)
})
