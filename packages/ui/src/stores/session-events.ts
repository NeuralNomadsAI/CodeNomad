import type {
  MessageInfo,
  MessagePartRemovedEvent,
  MessagePartDeltaEvent,
  MessagePartUpdatedEvent,
  MessageRemovedEvent,
  MessageUpdateEvent,
} from "../types/message"
import type {
  PermissionAsked,
  PermissionReplied,
  QuestionAsked,
  QuestionRejected,
  QuestionReplied,
  SessionCompactionEnded,
  SessionCreated,
  SessionExecutionFailed,
  SessionIdle,
  SessionRevertCleared,
  SessionRevertCommitted,
  SessionRevertStaged,
  SessionStatus2,
  TuiToastShow,
} from "@opencode-ai/client"
import type { MessageStatus } from "./message-v2/types"
import { deriveMessageStatus } from "./message-v2/message-status"

import { getLogger } from "../lib/logger"
import type { EventSessionDeleted, NativeSessionEvent } from "../lib/sse-manager"
import {
  enqueueDelta,
  clearPendingDeltasForInstance,
  clearPendingDeltasForPart,
  flushPendingDeltasForMessage,
  setFlushCallback,
} from "./delta-buffer"
import {
  getPermissionId,
  getPermissionKind,
  getPermissionSessionId,
  getRequestIdFromPermissionReply,
} from "../types/permission"
import type { PermissionRequest } from "../types/permission"
import { getQuestionId, getQuestionSessionId, getRequestIdFromQuestionReply } from "../types/question"
import type { QuestionRequest } from "../types/question"
import { showToastNotification, type ToastHandle, ToastVariant } from "../lib/notifications"
import { sendOsNotification } from "../lib/os-notifications"
import { preferences } from "./preferences"
import {
  instances,
  addPermissionToQueue,
  getPermissionQueue,
  removePermissionFromQueue,
  markPermissionReplied,
  hasRepliedPermission,
  addQuestionToQueue,
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
import { ensureSessionAncestorsExpanded, getAuthoritativelyDeletedSessionIdsForInstance, prependSessionListId, sessions, setSessionStatus, setSessions, syncInstanceSessionIndicator, withSession } from "./session-state"
import { mergeFetchedSessionRuntimeState } from "./session-generation-recovery"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { tGlobal } from "../lib/i18n"

import { loadMessages, removeSessionRuntimeState } from "./session-api"
import { getRootClient } from "./opencode-client"
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

const log = getLogger("sse")
const pendingSessionFetches = new Map<string, {
  status: SessionStatus
  retry?: SessionRetryState | null
}>()
const NATIVE_REFRESH_DELAY_MS = 75
const nativeRefreshes = new Map<string, {
  instanceId: string
  sessionId: string
  pending: boolean
  speakAfter: boolean
  timer?: ReturnType<typeof setTimeout>
  running?: Promise<void>
  cancelled: boolean
}>()
let activeRetryToast: ToastHandle | null = null

function speakCompletedAssistantText(instanceId: string, sessionId: string): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageId = store.getLastAssistantMessageId(sessionId)
  const message = messageId ? store.getMessage(messageId) : undefined
  if (!messageId || message?.status !== "complete") return
  const info = store.getMessageInfo(messageId)
  for (const partId of message.partIds) {
    handleConversationAssistantPartUpdated(instanceId, message.parts[partId].data, info)
  }
}

function requestNativeSessionRefresh(instanceId: string, sessionId: string, final = false): void {
  if (!instances().has(instanceId)) return
  const key = `${instanceId}:${sessionId}`
  const refresh = nativeRefreshes.get(key) ?? { instanceId, sessionId, pending: false, speakAfter: false, cancelled: false }
  refresh.pending = true
  refresh.speakAfter ||= final
  if (refresh.timer) clearTimeout(refresh.timer)
  nativeRefreshes.set(key, refresh)

  const run = async () => {
    if (refresh.running) return refresh.running
    refresh.running = (async () => {
      do {
        if (refresh.cancelled || !instances().has(instanceId)) return
        refresh.pending = false
        try {
          await loadMessages(refresh.instanceId, refresh.sessionId, { force: true })
        } catch (error) {
          log.error("Failed to refresh native session messages", { instanceId, sessionId, error })
        }
      } while (refresh.pending && !refresh.cancelled)

      if (refresh.speakAfter && !refresh.cancelled && instances().has(instanceId)) {
        refresh.speakAfter = false
        speakCompletedAssistantText(refresh.instanceId, refresh.sessionId)
      }
    })().finally(() => {
      refresh.running = undefined
      if (!refresh.pending && !refresh.speakAfter && nativeRefreshes.get(key) === refresh) nativeRefreshes.delete(key)
    })
    return refresh.running
  }

  if (final) {
    if (refresh.timer) clearTimeout(refresh.timer)
    refresh.timer = undefined
    void run()
  } else {
    refresh.timer = setTimeout(() => {
      refresh.timer = undefined
      void run()
    }, NATIVE_REFRESH_DELAY_MS)
  }
}

function clearNativeSessionRefresh(instanceId: string, sessionId: string): void {
  const refresh = nativeRefreshes.get(`${instanceId}:${sessionId}`)
  if (refresh) refresh.cancelled = true
  if (refresh?.timer) clearTimeout(refresh.timer)
  nativeRefreshes.delete(`${instanceId}:${sessionId}`)
}

function handleNativeSessionEvent(instanceId: string, event: NativeSessionEvent): void {
  if (!instances().has(instanceId)) return
  const sessionId = event.data?.sessionID
  if (!sessionId) return

  if (event.type === "session.compaction.started" || event.type === "session.compaction.admitted") {
    ensureSessionStatus(instanceId, sessionId, "compacting", event.location?.directory)
  } else if (
    event.type === "session.execution.started" ||
    event.type === "session.step.started" ||
    event.type.startsWith("session.text.") ||
    event.type.startsWith("session.reasoning.") ||
    event.type.startsWith("session.tool.")
  ) {
    ensureSessionStatus(instanceId, sessionId, "working", event.location?.directory)
  }

  requestNativeSessionRefresh(instanceId, sessionId)
}

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

const ALLOWED_TOAST_VARIANTS = new Set<ToastVariant>(["info", "success", "warning", "error"])

async function fetchSessionInfo(instanceId: string, sessionId: string, directory?: string): Promise<Session | null> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return null

  const client = getRootClient(instanceId)
  const instanceClient = instance.client
  void directory

  try {
    const info = await client.session.get({ sessionID: sessionId })
    if (instances().get(instanceId)?.client !== instanceClient) return null
    const fetched = createClientSession(info, instanceId)

    let updatedInstanceSessions: Map<string, Session> | undefined
    let shouldExpandAncestors = false

    setSessions((prev) => {
      if (instances().get(instanceId)?.client !== instanceClient) return prev
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
        runtimeStatusKnown: compacting || existing?.runtimeStatusKnown || false,
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
    setSessionStatus(instanceId, sessionId, status, { retry })
    return
  }

  const key = `${instanceId}:${sessionId}`
  const existingFetch = pendingSessionFetches.get(key)
  if (existingFetch) {
    existingFetch.status = status
    existingFetch.retry = retry
    return
  }

  const pendingState = { status, retry }
  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId, directory)
    if (!fetched) return
    setSessionStatus(instanceId, sessionId, pendingState.status, { retry: pendingState.retry })
  })()

  pendingSessionFetches.set(key, pendingState)
  void pending.finally(() => {
    if (pendingSessionFetches.get(key) === pendingState) pendingSessionFetches.delete(key)
  })
}

messageStoreBus.onInstanceDestroyed((instanceId) => {
  clearPendingDeltasForInstance(instanceId)
  const prefix = `${instanceId}:`
  for (const [key, refresh] of nativeRefreshes) {
    if (!key.startsWith(prefix)) continue
    refresh.cancelled = true
    if (refresh.timer) clearTimeout(refresh.timer)
    nativeRefreshes.delete(key)
  }
  for (const key of pendingSessionFetches.keys()) {
    if (key.startsWith(prefix)) pendingSessionFetches.delete(key)
  }
})

function resolveMessageRole(info?: MessageInfo | null): "user" | "assistant" {
  return info?.role === "user" ? "user" : "assistant"
}

function handleMessageUpdate(instanceId: string, event: MessageUpdateEvent | MessagePartUpdatedEvent): void {
  if (!instances().has(instanceId)) return
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

    // Flush any pending deltas for this message before applying the update.
    // Deltas are buffered for up to 50ms; if message.updated arrives before
    // the buffer flushes, the message could be marked complete/error with
    // stale text mutations still pending. Flushing first preserves the
    // server's event ordering: all delta content is applied, then the
    // message status/metadata update runs on the complete content.
    flushPendingDeltasForMessage(instanceId, messageId, applyPartDeltaV2)

    const timeInfo = (info.time ?? {}) as { created?: number; updated?: number; end?: number }
    const nextUpdated =
      typeof timeInfo.end === "number" && timeInfo.end > 0
        ? timeInfo.end
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
      const endAt = (info.time as { end?: number } | undefined)?.end
      store.upsertMessage({
        id: messageId,
        sessionId,
        role,
        status,
        createdAt,
        updatedAt: endAt ?? createdAt,
      })
    }

    upsertMessageInfoV2(instanceId, info as unknown as MessageInfo, { status, bumpRevision: true })

    updateSessionInfo(instanceId, sessionId)
  }
}

// Delta buffer callback setup
setFlushCallback((batch) => {
  for (const { instanceId, messageId, partId, field, delta } of batch) {
    if (!instances().has(instanceId)) continue
    applyPartDeltaV2(instanceId, { messageId, partId, field, delta })
  }
})

function handleMessagePartDelta(instanceId: string, event: MessagePartDeltaEvent): void {
  if (!instances().has(instanceId)) return
  const props = event.properties
  if (!props) return
  const { messageID, partID, field, delta } = props
  if (!messageID || !partID || !field || typeof delta !== "string") return
  enqueueDelta(instanceId, messageID, partID, field, delta)
}

function handleSessionUpdate(
  instanceId: string,
  event: SessionCreated | SessionRevertStaged | SessionRevertCleared | SessionRevertCommitted,
): void {
  if (!instances().has(instanceId)) return
  if (event.type !== "session.created") {
    const revert = event.type === "session.revert.staged" ? event.data.revert : null
    setSessionRevertV2(instanceId, event.data.sessionID, revert)
    withSession(instanceId, event.data.sessionID, (session) => {
      session.revert = revert ?? undefined
    })
    return
  }

  const info = {
    ...event.data,
    id: event.data.sessionID,
    time: { created: event.created, updated: event.created },
  }
  if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(info.id)) return

  const instanceSessions = sessions().get(instanceId) ?? new Map<string, Session>()

  const existingSession = instanceSessions.get(info.id)

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
      projectID: (info as any).projectID ?? "",
      cost: (info as any).cost ?? 0,
      tokens: (info as any).tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      location: (info as any).location ?? { directory: instances().get(instanceId)?.folder ?? "" },
      time: info.time
        ? { ...info.time }
        : {
            created: Date.now(),
            updated: Date.now(),
          },
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
      time: mergedTime,
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
  }
}

function handleSessionDeleted(instanceId: string, event: EventSessionDeleted): void {
  if (!instances().has(instanceId)) return
  const sessionId = event.data?.sessionID ?? event.properties?.info?.id ?? event.properties?.sessionID ?? event.properties?.id
  if (!sessionId) return

  log.info(`[SSE] Session deleted: ${sessionId}`)
  clearNativeSessionRefresh(instanceId, sessionId)
  removeSessionRuntimeState(instanceId, sessionId)
}

function handleSessionIdle(instanceId: string, event: SessionIdle): void {
  if (!instances().has(instanceId)) return
  const sessionId = event.data.sessionID
  if (!sessionId) return

  if (shouldSendOsNotificationForSession("idle", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" is idle` : "Session is idle"
    fireOsNotification({ title, body })
  }

  ensureSessionStatus(instanceId, sessionId, "idle", event.location?.directory)
  requestNativeSessionRefresh(instanceId, sessionId, true)
  log.info(`[SSE] Session idle: ${sessionId}`)
}

function handleSessionStatus(instanceId: string, event: SessionStatus2): void {
  if (!instances().has(instanceId)) return
  const sessionId = event.data.sessionID
  if (!sessionId) return

  const rawStatus = event.data.status
  const status = mapSdkSessionStatus(rawStatus)
  const retry = mapSdkSessionRetry(rawStatus)
  ensureSessionStatus(instanceId, sessionId, status, event.location?.directory, retry)
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

function handleSessionCompacted(instanceId: string, event: SessionCompactionEnded): void {
  if (!instances().has(instanceId)) return
  const sessionID = event.data.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)

  const existing = sessions().get(instanceId)?.get(sessionID)
  if (existing) setSessionStatus(instanceId, sessionID, "working", { force: true })
  else ensureSessionStatus(instanceId, sessionID, "working", event.location?.directory)

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

function handleSessionError(instanceId: string, event: SessionExecutionFailed): void {
  if (!instances().has(instanceId)) return
  const error = event.data.error
  const sessionId = event.data.sessionID
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

  showAlertDialog(tGlobal("sessionEvents.sessionError.message", { message }), {
    title: tGlobal("sessionEvents.sessionError.title"),
    variant: "error",
  })
}

function handleMessageRemoved(instanceId: string, event: MessageRemovedEvent): void {
  if (!instances().has(instanceId)) return
  const { sessionID, messageID } = event.properties
  if (!sessionID || !messageID) return

  log.info(`[SSE] Message removed from session ${sessionID}`, { messageID })
  removeMessageV2(instanceId, messageID, sessionID)
  updateSessionInfo(instanceId, sessionID)
}

function handleMessagePartRemoved(instanceId: string, event: MessagePartRemovedEvent): void {
  if (!instances().has(instanceId)) return
  const { sessionID, messageID, partID } = event.properties
  if (!sessionID || !messageID || !partID) return

  log.info(`[SSE] Message part removed from session ${sessionID}`, { messageID, partID })
  removeMessagePartV2(instanceId, messageID, partID, sessionID)
  updateSessionInfo(instanceId, sessionID)
}

function handleTuiToast(_instanceId: string, event: TuiToastShow): void {
  const payload = event.data
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

function handlePermissionUpdated(instanceId: string, event: PermissionAsked): void {
  if (!instances().has(instanceId)) return
  const permission = event.data as PermissionRequest
  if (!permission) return
  const permissionId = getPermissionId(permission)
  if (!permissionId) return
  if (hasRepliedPermission(instanceId, permissionId)) {
    log.info(`[SSE] Ignoring stale permission request after local reply: ${permissionId}`)
    return
  }
  const isPending = getPermissionQueue(instanceId).some((pending) => pending.id === permissionId)
  void isPending

  log.info(`[SSE] Permission request: ${permissionId} (${getPermissionKind(permission)})`)
  const queuedPermission = addPermissionToQueue(instanceId, permission) ?? permission
  upsertPermissionV2(instanceId, queuedPermission)

  const sessionId = getPermissionSessionId(permission)

  if (shouldSendOsNotificationForSession("needsInput", instanceId, sessionId)) {
    const title = getInstanceDisplayName(instanceId)
    const label = getSessionTitle(instanceId, sessionId)
    const body = label ? `Session "${label}" needs permission` : "Session needs permission"
    fireOsNotification({ title, body })
  }
}

function handlePermissionReplied(instanceId: string, event: PermissionReplied): void {
  if (!instances().has(instanceId)) return
  const requestId = getRequestIdFromPermissionReply(event.data)
  if (!requestId) return

  log.info(`[SSE] Permission replied: ${requestId}`)
  markPermissionReplied(instanceId, requestId)
  removePermissionFromQueue(instanceId, requestId)
  removePermissionV2(instanceId, requestId)
}

function handleQuestionAsked(instanceId: string, event: QuestionAsked): void {
  if (!instances().has(instanceId)) return
  const request = event.data as QuestionRequest
  if (!request) return
  log.info(`[SSE] Question asked: ${getQuestionId(request)}`)
  addQuestionToQueue(instanceId, request)
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
  event: QuestionReplied | QuestionRejected,
): void {
  if (!instances().has(instanceId)) return
  const requestId = getRequestIdFromQuestionReply(event.data)
  if (!requestId) return

  log.info(`[SSE] Question answered: ${requestId}`)
  removeQuestionFromQueue(instanceId, requestId)
  removeQuestionV2(instanceId, requestId)
}

export {
  handleMessagePartRemoved,
  handleMessageRemoved,
  handleMessagePartDelta,
  handleMessageUpdate,
  handleNativeSessionEvent,
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
