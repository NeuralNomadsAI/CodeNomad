import type {
  MessageInfo,
  MessagePartRemovedEvent,
  MessagePartDeltaEvent,
  MessagePartUpdatedEvent,
  MessageRemovedEvent,
  MessageUpdateEvent,
} from "../types/message"
import type {
  EventSessionCompacted,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
  EventSessionStatus,
} from "@opencode-ai/sdk"
import type { MessageStatus } from "./message-v2/types"
import type { Instance } from "../types/instance"
import { deriveMessageStatus } from "./message-v2/message-status"

import { getLogger } from "../lib/logger"
import type { EventSessionDeleted } from "../lib/sse-manager"
import { requestData } from "../lib/opencode-api"
import {
  enqueueDelta,
  clearPendingDeltasForInstance,
  clearPendingDeltasForMessage,
  clearPendingDeltasForPart,
  clearPendingDeltasForSession,
  flushPendingDeltasForMessage,
  requestDeltaRecovery,
  setRecoveryCallback,
  setFlushCallback,
} from "./delta-buffer"
import {
  getPermissionId,
  getPermissionKind,
  getPermissionSessionId,
  getRequestIdFromPermissionReply,
} from "../types/permission"
import type { LegacyPermissionAskedEvent, LegacyPermissionRepliedEvent, PermissionRequest } from "../types/permission"
import { getQuestionId, getQuestionSessionId, getRequestIdFromQuestionReply } from "../types/question"
import type { LegacyQuestionAnsweredEvent, LegacyQuestionAskedEvent, QuestionRequest } from "../types/question"
import type {
  EventPermissionV2Asked,
  EventPermissionV2Replied,
  EventQuestionV2Asked,
  EventQuestionV2Rejected,
  EventQuestionV2Replied,
} from "@opencode-ai/sdk/v2"
import { showToastNotification, type ToastHandle, ToastVariant } from "../lib/notifications"
import { sendOsNotification } from "../lib/os-notifications"
import { preferences } from "./preferences"
import {
  instances,
  isInstanceRuntimeCurrent,
  addPermissionToQueue,
  getPermissionQueue,
  removePermissionFromQueue,
  markPermissionReplied,
  hasRepliedPermission,
  addQuestionToQueue,
  hasAnsweredQuestion,
  markQuestionAnswered,
  removeQuestionFromQueue,
} from "./instances"
import { showAlertDialog } from "./alerts"
import {
  createClientSession,
  getIdleSinceForStatusTransition,
  mapSdkSessionRetry,
  mapSdkSessionStatus,
  type Session,
  type SessionRetryState,
  type SessionStatus,
} from "../types/session"
import { activeSessionId, ensureSessionAncestorsExpanded, getAuthoritativelyDeletedSessionIdsForInstance, invalidateSessionMessageLoad, markSessionMetadataMutation, prependSessionListId, sessions, setSessionStatus, setSessions, syncInstanceSessionIndicator, withSession } from "./session-state"
import { mergeFetchedSessionRuntimeState } from "./session-generation-recovery"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { tGlobal } from "../lib/i18n"

import { clearBufferedDeltaSnapshotFence, loadMessages, removeSessionRuntimeState, SessionMessageLoadTimeoutError } from "./session-api"
import { getRootClient } from "./opencode-client"
import { getWorktreeSlugForDirectory, getWorktreeSlugForSession } from "./worktrees"
import { getOpenCodeWorkspaceIdForWorktree } from "./opencode-workspaces"
import {
  applyPartUpdateV2,
  applyPartDeltaV2,
  reconcilePendingPermissionsV2,
  reconcilePendingQuestionsV2,
  upsertMessageInfoV2,
  upsertPermissionV2,
  upsertQuestionV2,
  removeMessagePartV2,
  removeMessageV2,
  removePermissionV2,
  removeQuestionV2,
  setSessionRevertV2,
} from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { handleConversationAssistantPartUpdated } from "./conversation-speech"
import { scheduleSessionMemorySweep } from "./session-memory"

const log = getLogger("sse")
const pendingSessionFetches = new Map<string, Promise<void>>()
const pendingSessionFetchRuntimes = new Map<string, Instance>()
const pendingSessionStatuses = new Map<string, { status: SessionStatus; retry?: SessionRetryState | null }>()
const MAX_DELTA_RECOVERY_ATTEMPTS = 3
const DELTA_RECOVERY_BACKOFF_MS = 100
const DELTA_RECOVERY_LOAD_TIMEOUT_MS = 10_000
type DeltaRecovery = {
  dirty: boolean
  running: boolean
  attempts: number
  deltas: Map<string, { messageId: string; partId: string; field: string; delta: string; expectedValue?: string }>
  requireActive: boolean
  idleReconcileRequested: boolean
  instance: Instance
}
const pendingDeltaRecoveries = new Map<string, DeltaRecovery>()
const pendingIdleMessageReconciliations = new Map<string, Instance>()
let activeRetryToast: ToastHandle | null = null

messageStoreBus.onInstanceDestroyed((instanceId) => {
  const prefix = `${instanceId}:`
  for (const key of pendingSessionFetches.keys()) if (key.startsWith(prefix)) pendingSessionFetches.delete(key)
  for (const key of pendingSessionFetchRuntimes.keys()) if (key.startsWith(prefix)) pendingSessionFetchRuntimes.delete(key)
  for (const key of pendingSessionStatuses.keys()) if (key.startsWith(prefix)) pendingSessionStatuses.delete(key)
  for (const key of pendingDeltaRecoveries.keys()) if (key.startsWith(prefix)) pendingDeltaRecoveries.delete(key)
  for (const key of pendingIdleMessageReconciliations.keys()) if (key.startsWith(prefix)) pendingIdleMessageReconciliations.delete(key)
  clearPendingDeltasForInstance(instanceId)
})

messageStoreBus.onSessionCleared((instanceId, sessionId) => {
  const key = `${instanceId}:${sessionId}`
  pendingDeltaRecoveries.delete(key)
  pendingIdleMessageReconciliations.delete(key)
})

function shouldSendOsNotification(kind: "needsInput" | "idle"): boolean {
  if (typeof document === "undefined") return false
  const pref = preferences()
  if (!pref.osNotificationsEnabled) return false
  if (!pref.osNotificationsAllowWhenVisible && document.visibilityState === "visible") return false
  if (kind === "needsInput") return Boolean(pref.notifyOnNeedsInput)
  if (kind === "idle") return Boolean(pref.notifyOnIdle)
  return false
}

function isChildSession(instanceId: string, sessionId: string): boolean | null {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return null
  return session.parentId !== null && session.parentId !== undefined
}

function shouldSendOsNotificationForSession(
  kind: "needsInput" | "idle",
  instanceId: string,
  sessionId: string | undefined | null,
): boolean {
  if (!shouldSendOsNotification(kind)) return false
  if (!sessionId) return true

  const child = isChildSession(instanceId, sessionId)

  // Avoid notification spam from spawned child/subagent sessions arriving before hydration.
  if (child === null) return false
  if (child) return false

  return true
}

function getInstanceDisplayName(instanceId: string): string {
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  return instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder
}

function getSessionTitle(instanceId: string, sessionId: string | undefined | null): string {
  if (!sessionId) return ""
  const session = sessions().get(instanceId)?.get(sessionId)
  const title = session?.title?.trim()
  return title && title.length > 0 ? title : sessionId
}

function fireOsNotification(payload: { title: string; body: string }) {
  void sendOsNotification(payload).catch((error) => {
    log.warn("Failed to send OS notification", error)
  })
}

interface TuiToastEvent {
  type: "tui.toast.show"
  properties: {
    title?: string
    message: string
    variant: "info" | "success" | "warning" | "error"
    duration?: number
  }
}

const ALLOWED_TOAST_VARIANTS = new Set<ToastVariant>(["info", "success", "warning", "error"])

async function fetchSessionInfo(instanceId: string, sessionId: string, directory?: string): Promise<Session | null> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return null

  const slugFromDirectory = getWorktreeSlugForDirectory(instanceId, directory)
  const slug = slugFromDirectory ?? getWorktreeSlugForSession(instanceId, sessionId)
  const client = getRootClient(instanceId)
  const workspace = await getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (!isInstanceRuntimeCurrent(instanceId, instance)) return null

  try {
    const info = await requestData<any>(
      client.session.get({ sessionID: sessionId, ...(workspace ? { workspace } : {}) }),
      "session.get",
    )
    if (!isInstanceRuntimeCurrent(instanceId, instance)) return null

    let rawStatus = (info as any)?.status
    let fetchedStatusKnown = false
    try {
      const statuses = await requestData<Record<string, any>>(client.session.status(), "session.status")
      if (!isInstanceRuntimeCurrent(instanceId, instance)) return null
      rawStatus ??= statuses?.[sessionId]
      fetchedStatusKnown = true
    } catch (error) {
      log.error("Failed to fetch session status", error)
    }
    if (!isInstanceRuntimeCurrent(instanceId, instance)) return null
    const hasStatus = rawStatus && typeof rawStatus === "object" && typeof rawStatus.type === "string"
    fetchedStatusKnown ||= Boolean(hasStatus)
    const fetchedStatus: SessionStatus = hasStatus ? mapSdkSessionStatus(rawStatus) : "idle"
    const fetchedRetry: SessionRetryState | null = hasStatus ? mapSdkSessionRetry(rawStatus) : null

    const fetched = createClientSession(info, instanceId, "", { providerId: "", modelId: "" }, fetchedStatus)
    fetched.retry = fetchedRetry
    fetched.runtimeStatusKnown = fetchedStatusKnown

    let updatedInstanceSessions: Map<string, Session> | undefined
    let shouldExpandAncestors = false

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      const existing = instanceSessions.get(sessionId)
      const compacting = existing?.status === "compacting"
      const candidate: Session = {
        ...fetched,
        agent: existing?.agent ?? fetched.agent,
        model: existing?.model ?? fetched.model,
        status: compacting ? "compacting" : fetched.status,
        retry: compacting ? null : fetched.retry,
        idleSince: getIdleSinceForStatusTransition(existing?.status, compacting ? "compacting" : fetched.status, existing?.idleSince),
        pendingPermission: existing?.pendingPermission ?? fetched.pendingPermission,
        pendingQuestion: existing?.pendingQuestion ?? false,
        runtimeStatusKnown: compacting || fetched.runtimeStatusKnown,
      }
      const merged = mergeFetchedSessionRuntimeState(
        candidate,
        existing,
        existing,
        getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId),
      )
      if (!merged) return prev
      instanceSessions.set(sessionId, merged)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions

      if (merged.parentId && merged.status === "working" && (existing?.status ?? "idle") !== "working") {
        shouldExpandAncestors = true
      }
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)

    if (shouldExpandAncestors) ensureSessionAncestorsExpanded(instanceId, sessionId)

    return fetched
  } catch (error) {
    log.error("Failed to fetch session info", error)
    return null
  }
}

function ensureSessionStatus(
  instanceId: string,
  sessionId: string,
  status: SessionStatus,
  directory?: string,
  retry?: SessionRetryState | null,
) {
  const existing = sessions().get(instanceId)?.get(sessionId)
  if (existing) {
    const key = `${instanceId}:${sessionId}`
    if (pendingSessionFetches.has(key)) pendingSessionStatuses.set(key, { status, retry })
    setSessionStatus(instanceId, sessionId, status, { retry })
    scheduleSessionMemorySweep()
    return
  }

  const key = `${instanceId}:${sessionId}`
  pendingSessionStatuses.set(key, { status, retry })
  const runtime = instances().get(instanceId)
  const pendingRuntime = pendingSessionFetchRuntimes.get(key)
  if (pendingSessionFetches.has(key) && pendingRuntime && isInstanceRuntimeCurrent(instanceId, pendingRuntime)) return

  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId, directory)
    if (!fetched) return
    const latest = pendingSessionStatuses.get(key) ?? { status, retry }
    setSessionStatus(instanceId, sessionId, latest.status, { retry: latest.retry, force: true })
    scheduleSessionMemorySweep()
  })()

  pendingSessionFetches.set(key, pending)
  if (runtime) pendingSessionFetchRuntimes.set(key, runtime)
  void pending.finally(() => {
    if (pendingSessionFetches.get(key) === pending) {
      pendingSessionFetches.delete(key)
      pendingSessionFetchRuntimes.delete(key)
      pendingSessionStatuses.delete(key)
    }
  })
}

function resolveMessageRole(info?: MessageInfo | null): "user" | "assistant" {
  return info?.role === "user" ? "user" : "assistant"
}

function handleMessageUpdate(instanceId: string, event: MessageUpdateEvent | MessagePartUpdatedEvent): void {
  const instanceSessions = sessions().get(instanceId)

  if (event.type === "message.part.updated") {
    const rawPart = event.properties?.part
    if (!rawPart) return
 
    const part = normalizeMessagePart(rawPart)
    const messageInfo = (event as any)?.properties?.message as MessageInfo | undefined
 
    const fallbackSessionId = typeof messageInfo?.sessionID === "string" ? messageInfo.sessionID : undefined
    const fallbackMessageId = typeof messageInfo?.id === "string" ? messageInfo.id : undefined
 
    const sessionId = typeof part.sessionID === "string" ? part.sessionID : fallbackSessionId
    const messageId = typeof part.messageID === "string" ? part.messageID : fallbackMessageId
    if (!sessionId || !messageId) return
    if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return
    if (part.type === "compaction") {
      ensureSessionStatus(instanceId, sessionId, "compacting", (event as any)?.directory)
    }

    const store = messageStoreBus.getOrCreate(instanceId)
    const role = resolveMessageRole(messageInfo)
    const createdAt = typeof messageInfo?.time?.created === "number" ? messageInfo.time.created : Date.now()

    store.confirmServerMessage(messageId, { clearOptimisticParts: true })
    const record = store.getMessage(messageId)

    if (!record) {
      store.upsertMessage({
        id: messageId,
        sessionId,
        role,
        status: "streaming",
        createdAt,
        updatedAt: createdAt,
        isEphemeral: true,
      })
    }

    if (messageInfo) {
      upsertMessageInfoV2(instanceId, messageInfo, { status: "streaming" })
    }
  
    // Clear any pending deltas for this part before applying the full part update.
    // The part update contains the complete state from the server, so accumulated
    // deltas would be stale and cause duplication if flushed later.
    if (part.id) {
      clearPendingDeltasForPart(instanceId, messageId, part.id)
      clearBufferedDeltaSnapshotFence(instanceId, sessionId, messageId, part.id)
    }
    applyPartUpdateV2(instanceId, { ...part, sessionID: sessionId, messageID: messageId })
    handleConversationAssistantPartUpdated(instanceId, { ...part, sessionID: sessionId, messageID: messageId }, messageInfo)

    if (part.type === "tool") {
      // Interruptions can arrive before their tool part exists; re-link now.
      reconcilePendingPermissionsV2(instanceId, sessionId)
      reconcilePendingQuestionsV2(instanceId, sessionId)
    }

    updateSessionInfo(instanceId, sessionId)
  } else if (event.type === "message.updated") {
    const info = event.properties?.info
    if (!info) return

    const sessionId = typeof info.sessionID === "string" ? info.sessionID : undefined
    const messageId = typeof info.id === "string" ? info.id : undefined
    if (!sessionId || !messageId) return
    if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return

    // Flush any pending deltas for this message before applying the update.
    // Deltas are buffered for up to 50ms; if message.updated arrives before
    // the buffer flushes, the message could be marked complete/error with
    // stale text mutations still pending. Flushing first preserves the
    // server's event ordering: all delta content is applied, then the
    // message status/metadata update runs on the complete content.
    flushPendingDeltasForMessage(instanceId, messageId, applyPartDeltaV2)

    const timeInfo = (info.time ?? {}) as { created?: number; updated?: number; end?: number; completed?: number }
    const nextUpdated =
      typeof timeInfo.end === "number" && timeInfo.end > 0
        ? timeInfo.end
        : typeof timeInfo.completed === "number" && timeInfo.completed > 0
          ? timeInfo.completed
          : typeof timeInfo.updated === "number" && timeInfo.updated > 0
            ? timeInfo.updated
            : typeof timeInfo.created === "number" && timeInfo.created > 0
              ? timeInfo.created
              : Date.now()

    withSession(instanceId, sessionId, (session) => {
      const currentUpdated = session.time?.updated ?? 0
      if (nextUpdated <= currentUpdated) return false
      session.time = { ...(session.time ?? {}), updated: nextUpdated }
    })

    const store = messageStoreBus.getOrCreate(instanceId)

    const role = info.role === "user" ? "user" : "assistant"
    const status: MessageStatus = deriveMessageStatus({
      role: info.role,
      error: (info as any).error,
      time: info.time as { completed?: number } | undefined,
    })

    store.confirmServerMessage(messageId)
    const record = store.getMessage(messageId)

    if (!record) {
      const createdAt = info.time?.created ?? Date.now()
      const endAt = timeInfo.end ?? timeInfo.completed
      store.upsertMessage({
        id: messageId,
        sessionId,
        role,
        status,
        createdAt,
        updatedAt: endAt ?? createdAt,
      })
    }

    upsertMessageInfoV2(instanceId, info, { status, bumpRevision: true })

    updateSessionInfo(instanceId, sessionId)
  }
}

// Delta buffer callback setup
setFlushCallback((batch) => {
  for (const { instanceId, sessionId, messageId, partId, field, delta } of batch) {
    if (!applyPartDeltaV2(instanceId, { messageId, partId, field, delta })) {
      requestDeltaRecovery({ instanceId, ...(sessionId ? { sessionId } : {}), messageId, partId, field, delta })
    }
  }
})

setRecoveryCallback(({ instanceId, sessionId, messageId, partId, field, delta }) => {
  if (!sessionId) {
    log.warn("Dropped orphan delta without a session", { instanceId, messageId, partId })
    return
  }
  const instance = instances().get(instanceId)
  if (!instance) return
  const key = `${instanceId}:${sessionId}`
  const existing = pendingDeltaRecoveries.get(key)
  if (existing && isInstanceRuntimeCurrent(instanceId, existing.instance)) {
    if (delta !== undefined) {
      const deltaKey = `${messageId}:${partId}:${field}`
      const pending = existing.deltas.get(deltaKey)
      existing.deltas.set(deltaKey, {
        messageId,
        partId,
        field,
        delta: `${pending?.delta ?? ""}${delta}`,
        expectedValue: pending?.expectedValue === undefined ? undefined : `${pending.expectedValue}${delta}`,
      })
    }
    existing.dirty = true
    runDeltaRecovery(instanceId, sessionId, existing)
    return
  }
  if (existing) pendingDeltaRecoveries.delete(key)
  const recovery: DeltaRecovery = {
    dirty: true,
    running: false,
    attempts: 0,
    deltas: new Map(delta === undefined ? [] : [[`${messageId}:${partId}:${field}`, { messageId, partId, field, delta }]]),
    requireActive: activeSessionId().get(instanceId) === sessionId,
    idleReconcileRequested: false,
    instance,
  }
  pendingDeltaRecoveries.set(key, recovery)
  runDeltaRecovery(instanceId, sessionId, recovery)
})

function runDeltaRecovery(instanceId: string, sessionId: string, recovery: DeltaRecovery): void {
  if (recovery.running) return
  const key = `${instanceId}:${sessionId}`
  if (!isInstanceRuntimeCurrent(instanceId, recovery.instance)) {
    if (pendingDeltaRecoveries.get(key) === recovery) pendingDeltaRecoveries.delete(key)
    return
  }
  const session = sessions().get(instanceId)?.get(sessionId)
  if (session?.status === "working" || session?.status === "compacting") return
  recovery.running = true
  void (async () => {
    try {
      while (recovery.dirty && recovery.attempts < MAX_DELTA_RECOVERY_ATTEMPTS) {
        if (!isInstanceRuntimeCurrent(instanceId, recovery.instance) || !sessions().get(instanceId)?.has(sessionId)) return
        if (recovery.requireActive && activeSessionId().get(instanceId) !== sessionId) {
          invalidateSessionMessageLoad(instanceId, sessionId)
          return
        }
        const currentStatus = sessions().get(instanceId)?.get(sessionId)?.status
        if (currentStatus === "working" || currentStatus === "compacting") return

        await new Promise((resolve) => setTimeout(resolve, (recovery.attempts + 1) * DELTA_RECOVERY_BACKOFF_MS))
        if (!isInstanceRuntimeCurrent(instanceId, recovery.instance) || !sessions().get(instanceId)?.has(sessionId)) return
        if (recovery.requireActive && activeSessionId().get(instanceId) !== sessionId) {
          invalidateSessionMessageLoad(instanceId, sessionId)
          return
        }
        const statusAfterBackoff = sessions().get(instanceId)?.get(sessionId)?.status
        if (statusAfterBackoff === "working" || statusAfterBackoff === "compacting") return

        recovery.dirty = false
        recovery.attempts += 1
        try {
          await loadMessages(instanceId, sessionId, { force: true, timeoutMs: DELTA_RECOVERY_LOAD_TIMEOUT_MS })
          if (!isInstanceRuntimeCurrent(instanceId, recovery.instance)) return
          for (const [deltaKey, pending] of recovery.deltas) {
            const part = messageStoreBus.getInstance(instanceId)?.getMessage(pending.messageId)?.parts[pending.partId]?.data as any
            const value = part?.[pending.field]
            if (pending.expectedValue !== undefined && typeof value === "string" && value.startsWith(pending.expectedValue)) {
              recovery.deltas.delete(deltaKey)
            } else if (recovery.attempts < MAX_DELTA_RECOVERY_ATTEMPTS) {
              if (pending.expectedValue === undefined && typeof value === "string") {
                pending.expectedValue = `${value}${pending.delta}`
              }
              applyPartDeltaV2(instanceId, pending)
              recovery.dirty = true
            } else {
              recovery.deltas.delete(deltaKey)
            }
          }
        } catch (error) {
          recovery.dirty = true
          if (recovery.attempts >= MAX_DELTA_RECOVERY_ATTEMPTS) throw error
        }
      }
      if (recovery.dirty) {
        log.warn("Revision recovery exhausted", { instanceId, sessionId, attempts: recovery.attempts })
      }
    } catch (error) {
      log.warn("Failed to recover orphan delta", { instanceId, sessionId, error })
    } finally {
      recovery.running = false
      const latestStatus = sessions().get(instanceId)?.get(sessionId)?.status
      const waitingForIdle = isInstanceRuntimeCurrent(instanceId, recovery.instance) &&
        recovery.attempts < MAX_DELTA_RECOVERY_ATTEMPTS && recovery.dirty &&
        (latestStatus === "working" || latestStatus === "compacting")
      const forceIdleReconcile = isInstanceRuntimeCurrent(instanceId, recovery.instance) &&
        (!recovery.requireActive || activeSessionId().get(instanceId) === sessionId) &&
        recovery.idleReconcileRequested && !waitingForIdle
      if (!waitingForIdle && pendingDeltaRecoveries.get(key) === recovery) pendingDeltaRecoveries.delete(key)
      if (forceIdleReconcile) reconcileIdleSessionMessages(instanceId, sessionId, true, recovery.instance)
    }
  })()
}

function handleMessagePartDelta(instanceId: string, event: MessagePartDeltaEvent): void {
  const props = event.properties
  if (!props) return
  const { messageID, partID, field, delta } = props
  if (!messageID || !partID || !field || typeof delta !== "string") return
  const sessionId = props.sessionID ?? messageStoreBus.getInstance(instanceId)?.getMessage(messageID)?.sessionId
  if (sessionId) {
    if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return
  }
  enqueueDelta(instanceId, messageID, partID, field, delta, sessionId)
}

function handleSessionUpdate(instanceId: string, event: EventSessionUpdated): void {
  const info = event.properties?.info

  if (!info) return
  if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(info.id)) return
  markSessionMetadataMutation(instanceId, info.id)
  const instanceSessions = sessions().get(instanceId) ?? new Map<string, Session>()
  const existingSession = instanceSessions.get(info.id)
  const incomingRevert = info.revert ?? null
  const previousRevert = existingSession?.revert ?? null
  const revertChanged = (
    incomingRevert?.messageID !== previousRevert?.messageID ||
    incomingRevert?.partID !== previousRevert?.partID ||
    incomingRevert?.snapshot !== previousRevert?.snapshot ||
    incomingRevert?.diff !== previousRevert?.diff
  )
  if (revertChanged) {
    invalidateSessionMessageLoad(instanceId, info.id)
  }

  if (!existingSession) {
    const newSession = {
      id: info.id,
      instanceId,
      title: info.title || tGlobal("sessionList.session.untitled"),
      parentId: info.parentID || null,
      agent: "",
      model: {
        providerId: "",
        modelId: "",
      },
      status: "idle",
      retry: null,
      idleSince: null,
      version: info.version || "0",
      metadata: (info as any).metadata,
      time: info.time
        ? { ...info.time }
        : {
            created: Date.now(),
            updated: Date.now(),
          },
      revert: info.revert
        ? {
            messageID: info.revert.messageID,
            partID: info.revert.partID,
            snapshot: info.revert.snapshot,
            diff: info.revert.diff,
          }
        : undefined,
    } as Session

    let updatedInstanceSessions: Map<string, Session> | undefined

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      instanceSessions.set(newSession.id, newSession)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)
    setSessionRevertV2(instanceId, info.id, incomingRevert)
    if (!newSession.parentId) {
      prependSessionListId(instanceId, newSession.id)
    }

    log.info(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const mergedTime = {
      ...existingSession.time,
      ...(info.time ?? {}),
    }
    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
      parentId: info.parentID ?? existingSession.parentId,
      status: existingSession.status ?? "idle",
      retry: existingSession.retry ?? null,
      metadata: (info as any).metadata ?? existingSession.metadata,
      time: mergedTime,
      revert: info.revert
        ? {
            messageID: info.revert.messageID,
            partID: info.revert.partID,
            snapshot: info.revert.snapshot,
            diff: info.revert.diff,
          }
        : undefined,
    }

    let updatedInstanceSessions: Map<string, Session> | undefined

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      instanceSessions.set(existingSession.id, updatedSession)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)
    setSessionRevertV2(instanceId, info.id, incomingRevert)
  }
}

function handleSessionDeleted(instanceId: string, event: EventSessionDeleted): void {
  const properties = event.properties
  const sessionId = properties?.info?.id ?? properties?.sessionID ?? properties?.id
  if (!sessionId) return
  clearPendingDeltasForSession(instanceId, sessionId)

  log.info(`[SSE] Session deleted: ${sessionId}`)
  removeSessionRuntimeState(instanceId, sessionId)
}

function handleSessionIdle(instanceId: string, event: EventSessionIdle): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  if (shouldSendOsNotificationForSession("idle", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" is idle` : "Session is idle"
    fireOsNotification({ title, body })
  }

  ensureSessionStatus(instanceId, sessionId, "idle", (event as any)?.directory)
  reconcileIdleSessionMessages(instanceId, sessionId)
  scheduleSessionMemorySweep()
  log.info(`[SSE] Session idle: ${sessionId}`)
}

function handleSessionStatus(instanceId: string, event: EventSessionStatus): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  const rawStatus = event.properties.status
  const status = mapSdkSessionStatus(rawStatus)
  const retry = mapSdkSessionRetry(rawStatus)
  ensureSessionStatus(instanceId, sessionId, status, (event as any)?.directory, retry)
  if (status === "idle") reconcileIdleSessionMessages(instanceId, sessionId)
  scheduleSessionMemorySweep()
  if (retry) {
    const remainingSeconds = Math.max(0, Math.round((retry.next - Date.now()) / 1000))
    const countdown =
      remainingSeconds > 0
        ? tGlobal("sessionList.status.retryingIn", { seconds: String(remainingSeconds) })
        : tGlobal("sessionList.status.retrying")
    const label = getSessionTitle(instanceId, sessionId)
    activeRetryToast?.dismiss()
    activeRetryToast = showToastNotification({
      title: label || getInstanceDisplayName(instanceId),
      message: tGlobal("sessionList.status.retryToast", {
        countdown,
        message: retry.message,
        attempt: String(retry.attempt),
      }),
      variant: "error",
      duration: 7000,
    })
  }
  log.info(`[SSE] Session status updated: ${sessionId}`, { status })
}

function reconcileIdleSessionMessages(instanceId: string, sessionId: string, force = false, expectedInstance?: Instance): void {
  const instance = expectedInstance ?? instances().get(instanceId)
  if (!instance || !isInstanceRuntimeCurrent(instanceId, instance)) return
  const recoveryKey = `${instanceId}:${sessionId}`
  const recovery = pendingDeltaRecoveries.get(recoveryKey)
  let forceReconcile = false
  if (recovery) {
    if ((recovery.running || recovery.attempts < MAX_DELTA_RECOVERY_ATTEMPTS) && isInstanceRuntimeCurrent(instanceId, recovery.instance)) {
      recovery.idleReconcileRequested = true
      runDeltaRecovery(instanceId, sessionId, recovery)
      return
    }
    forceReconcile = recovery.dirty && isInstanceRuntimeCurrent(instanceId, recovery.instance)
    pendingDeltaRecoveries.delete(recoveryKey)
  }
  if (!force && !forceReconcile && !messageStoreBus.getInstance(instanceId)?.hasSessionActiveWork(sessionId)) return
  const key = `${instanceId}:${sessionId}`
  const pendingRuntime = pendingIdleMessageReconciliations.get(key)
  if (pendingRuntime && isInstanceRuntimeCurrent(instanceId, pendingRuntime)) return
  pendingIdleMessageReconciliations.set(key, instance)
  void loadMessages(instanceId, sessionId, {
    force: true,
    timeoutMs: DELTA_RECOVERY_LOAD_TIMEOUT_MS,
  })
    .catch((error) => {
      if (error instanceof SessionMessageLoadTimeoutError) {
        messageStoreBus.getInstance(instanceId)?.interruptSessionActiveMessages(sessionId)
      }
      log.warn("Failed to reconcile idle session messages", { instanceId, sessionId, error })
    })
    .finally(() => {
      if (pendingIdleMessageReconciliations.get(key) === instance) pendingIdleMessageReconciliations.delete(key)
    })
}

function handleSessionCompacted(instanceId: string, event: EventSessionCompacted): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)

  const existing = sessions().get(instanceId)?.get(sessionID)
  if (existing) setSessionStatus(instanceId, sessionID, "working", { force: true })
  else ensureSessionStatus(instanceId, sessionID, "working", (event as any)?.directory)

  loadMessages(instanceId, sessionID, { force: true }).catch((error) => log.error("Failed to reload session after compaction", error))

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionID)
  const label = session?.title?.trim() ? session.title : sessionID
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  const instanceName = instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder
  const displayLabel = label ? `"${label}"` : sessionID

  showToastNotification({
    title: instanceName,
    message: tGlobal("sessionEvents.sessionCompactedToast", { label: displayLabel }),
    variant: "info",
    duration: 10000,
  })
}

function handleSessionError(instanceId: string, event: EventSessionError): void {
  const error = event.properties?.error
  const sessionId = event.properties?.sessionID
  if (sessionId) messageStoreBus.getOrCreate(instanceId).failPendingSends(sessionId)
  log.error(`[SSE] Session error:`, error)

  let message = tGlobal("sessionEvents.sessionError.unknown")

  if (error) {
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
      message = error.data.message as string
    } else if ("message" in error && typeof error.message === "string") {
      message = error.message
    }
  }
  if (message.length > 10_000) message = `${message.slice(0, 10_000)}...`

  showAlertDialog(tGlobal("sessionEvents.sessionError.message", { message }), {
    title: tGlobal("sessionEvents.sessionError.title"),
    variant: "error",
  })
}

function handleMessageRemoved(instanceId: string, event: MessageRemovedEvent): void {
  const { sessionID, messageID } = event.properties
  if (!sessionID || !messageID) return
  if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionID)) return

  log.info(`[SSE] Message removed from session ${sessionID}`, { messageID })
  clearPendingDeltasForMessage(instanceId, messageID)
  removeMessageV2(instanceId, messageID, sessionID)
  updateSessionInfo(instanceId, sessionID)
}

function handleMessagePartRemoved(instanceId: string, event: MessagePartRemovedEvent): void {
  const { sessionID, messageID, partID } = event.properties
  if (!sessionID || !messageID || !partID) return
  if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionID)) return

  log.info(`[SSE] Message part removed from session ${sessionID}`, { messageID, partID })
  clearPendingDeltasForPart(instanceId, messageID, partID)
  removeMessagePartV2(instanceId, messageID, partID, sessionID)
  updateSessionInfo(instanceId, sessionID)
}

function handleTuiToast(_instanceId: string, event: TuiToastEvent): void {
  const payload = event?.properties
  if (!payload || typeof payload.message !== "string" || typeof payload.variant !== "string") return
  if (!payload.message.trim()) return

  const variant: ToastVariant = ALLOWED_TOAST_VARIANTS.has(payload.variant as ToastVariant)
    ? (payload.variant as ToastVariant)
    : "info"

  showToastNotification({
    title: typeof payload.title === "string" ? payload.title : undefined,
    message: payload.message,
    variant,
    duration: typeof payload.duration === "number" ? payload.duration : undefined,
  })
}

function handlePermissionUpdated(instanceId: string, event: EventPermissionV2Asked | LegacyPermissionAskedEvent): void {
  const permission = event?.properties as PermissionRequest | undefined
  if (!permission) return
  const permissionId = getPermissionId(permission)
  if (!permissionId) return
  if (hasRepliedPermission(instanceId, permissionId)) {
    log.info(`[SSE] Ignoring stale permission request after local reply: ${permissionId}`)
    return
  }
  const isPending = getPermissionQueue(instanceId).some((pending) => pending.id === permissionId)
  const source = event.type === "permission.v2.asked"
    ? "v2"
    : event.type === "permission.updated" && isPending ? undefined : "legacy"

  log.info(`[SSE] Permission request: ${permissionId} (${getPermissionKind(permission)})`)
  const queuedPermission = addPermissionToQueue(instanceId, permission, source) ?? permission
  upsertPermissionV2(instanceId, queuedPermission)

  const sessionId = getPermissionSessionId(permission)

  if (shouldSendOsNotificationForSession("needsInput", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" needs permission` : "Session needs permission"
    fireOsNotification({ title, body })
  }
}

function handlePermissionReplied(instanceId: string, event: EventPermissionV2Replied | LegacyPermissionRepliedEvent): void {
  const properties = event?.properties
  const requestId = getRequestIdFromPermissionReply(properties)
  if (!requestId) return

  log.info(`[SSE] Permission replied: ${requestId}`)
  markPermissionReplied(instanceId, requestId)
  removePermissionFromQueue(instanceId, requestId)
  removePermissionV2(instanceId, requestId)
}

function handleQuestionAsked(instanceId: string, event: EventQuestionV2Asked | LegacyQuestionAskedEvent): void {
  const request = event?.properties as QuestionRequest | undefined
  if (!request) return
  if (hasAnsweredQuestion(instanceId, request.id)) return
  const source = event.type === "question.asked" ? "legacy" : "v2"

  log.info(`[SSE] Question asked: ${getQuestionId(request)}`)
  addQuestionToQueue(instanceId, request, source)
  upsertQuestionV2(instanceId, request)

  const sessionId = getQuestionSessionId(request)

  if (shouldSendOsNotificationForSession("needsInput", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" needs input` : "Session needs input"
    fireOsNotification({ title, body })
  }
}

function handleQuestionAnswered(
  instanceId: string,
  event: EventQuestionV2Replied | EventQuestionV2Rejected | LegacyQuestionAnsweredEvent,
): void {
  const properties = event?.properties
  const requestId = getRequestIdFromQuestionReply(properties)
  if (!requestId) return

  log.info(`[SSE] Question answered: ${requestId}`)
  markQuestionAnswered(instanceId, requestId)
  removeQuestionFromQueue(instanceId, requestId)
  removeQuestionV2(instanceId, requestId)
}

export {
  handleMessagePartRemoved,
  handleMessageRemoved,
  handleMessagePartDelta,
  handleMessageUpdate,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleQuestionAsked,
  handleQuestionAnswered,
  handleSessionCompacted,
  handleSessionDeleted,
  handleSessionError,
  handleSessionIdle,
  handleSessionStatus,
  handleSessionUpdate,
  handleTuiToast,
}
