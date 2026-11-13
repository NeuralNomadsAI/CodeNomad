import { createEffect, createRoot } from "solid-js"
import { getLogger } from "../lib/logger"
import { onCacheSessionChanged } from "../lib/global-cache"
import { SessionTranscriptMeasurementQueue } from "../lib/session-transcript-measurement"
import { isSessionTranscriptProtected, SessionTranscriptLru } from "../lib/session-transcript-lru"
import { messageStoreBus } from "./message-v2/bus"
import { loading, sessions } from "./session-state"
import { destroyOpenCodeData, getOpenCodeInstanceGeneration } from "./opencode-data"
import { cancelTranscriptProjections } from "./opencode-projection-frame"
import { isSessionTranscriptVisible, retainSessionTranscriptVisible, clearSessionTranscriptVisible, clearInstanceTranscriptVisible } from "./session-transcript-visibility"
import type { captureBackendOperation } from "../lib/backend-operation"

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
  delayMs: 100,
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

/** Scalar ownership identity: catalogue object replacements preserve a view's lease. */
export function sessionTranscriptBinding(instanceId: string, sessionId: string): string | undefined {
  const session = sessions().get(instanceId)?.get(sessionId)
  return session ? JSON.stringify([getOpenCodeInstanceGeneration(instanceId), session.projectID,
    session.location?.directory, session.location?.workspaceID]) : undefined
}

export function setSessionTranscriptVisible(instanceId: string, sessionId: string, operation: ReturnType<typeof captureBackendOperation>): () => void {
  const binding = sessionTranscriptBinding(instanceId, sessionId)
  const release = retainSessionTranscriptVisible(instanceId, sessionId, {
    signal: operation.signal,
    current: () => binding !== undefined && operation.current() && sessionTranscriptBinding(instanceId, sessionId) === binding,
  })
  if (isSessionTranscriptVisible(instanceId, sessionId)) touchSessionTranscript(instanceId, sessionId)
  coordinator.enforce()
  return () => {
    if (!release()) return
    measurements.schedule(instanceId, sessionId)
    coordinator.enforce()
  }
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
  clearSessionTranscriptVisible(instanceId, sessionId)
  measurements.cancel(instanceId, sessionId)
  coordinator.forget(instanceId, sessionId)
})
messageStoreBus.onInstanceDestroyed((instanceId) => {
  coordinator.forgetInstance(instanceId)
  clearInstanceTranscriptVisible(instanceId)
  measurements.cancelInstance(instanceId)
})
