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
import { deriveMessageStatus } from "./message-v2/message-status"

import { getLogger } from "../lib/logger"
import type { EventSessionDeleted } from "../lib/sse-manager"
import { requestData } from "../lib/opencode-api"
import {
  enqueueDelta,
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

const log = getLogger("sse")
const pendingSessionFetches = new Map<string, Promise<void>>()
let activeRetryToast: ToastHandle | null = null

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

  try {
    const info = await requestData<any>(
      client.session.get({ sessionID: sessionId, ...(workspace ? { workspace } : {}) }),
      "session.get",
    )

    let rawStatus = (info as any)?.status
    let fetchedStatusKnown = false
    try {
      const statuses = await requestData<Record<string, any>>(client.session.status(), "session.status")
      rawStatus ??= statuses?.[sessionId]
      fetchedStatusKnown = true
    } catch (error) {
      log.error("Failed to fetch session status", error)
    }
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
    setSessionStatus(instanceId, sessionId, status, { retry })
    return
  }

  const key = `${instanceId}:${sessionId}`
  if (pendingSessionFetches.has(key)) return

  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId, directory)
    if (!fetched) return
    setSessionStatus(instanceId, sessionId, status, { retry })
  })()

  pendingSessionFetches.set(key, pending)
  void pending.finally(() => pendingSessionFetches.delete(key))
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

    upsertMessageInfoV2(instanceId, info, { status, bumpRevision: true })

    updateSessionInfo(instanceId, sessionId)
  }
}

// Delta buffer callback setup
setFlushCallback((batch) => {
  for (const { instanceId, messageId, partId, field, delta } of batch) {
    applyPartDeltaV2(instanceId, { messageId, partId, field, delta })
  }
})

function handleMessagePartDelta(instanceId: string, event: MessagePartDeltaEvent): void {
  const props = event.properties
  if (!props) return
  const { messageID, partID, field, delta } = props
  if (!messageID || !partID || !field || typeof delta !== "string") return
  enqueueDelta(instanceId, messageID, partID, field, delta)
}

function handleSessionUpdate(instanceId: string, event: EventSessionUpdated): void {
  const info = event.properties?.info

  if (!info) return
  const workspaceId = (info as typeof info & { workspaceID?: string }).workspaceID
  if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(info.id)) return

  const instanceSessions = sessions().get(instanceId) ?? new Map<string, Session>()

  const existingSession = instanceSessions.get(info.id)

  if (!existingSession) {
    const newSession = {
      id: info.id,
      instanceId,
      projectId: info.projectID,
      workspaceId,
      directory: info.directory,
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
    setSessionRevertV2(instanceId, info.id, info.revert ?? null)
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
      projectId: info.projectID ?? existingSession.projectId,
      workspaceId,
      directory: info.directory ?? existingSession.directory,
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
        : existingSession.revert,
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
    setSessionRevertV2(instanceId, info.id, info.revert ?? null)
  }
}

function handleSessionDeleted(instanceId: string, event: EventSessionDeleted): void {
  const properties = event.properties
  const sessionId = properties?.info?.id ?? properties?.sessionID ?? properties?.id
  if (!sessionId) return

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
  log.info(`[SSE] Session idle: ${sessionId}`)
}

function handleSessionStatus(instanceId: string, event: EventSessionStatus): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  const rawStatus = event.properties.status
  const status = mapSdkSessionStatus(rawStatus)
  const retry = mapSdkSessionRetry(rawStatus)
  ensureSessionStatus(instanceId, sessionId, status, (event as any)?.directory, retry)
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

  showAlertDialog(tGlobal("sessionEvents.sessionError.message", { message }), {
    title: tGlobal("sessionEvents.sessionError.title"),
    variant: "error",
  })
}

function handleMessageRemoved(instanceId: string, event: MessageRemovedEvent): void {
  const { sessionID, messageID } = event.properties
  if (!sessionID || !messageID) return

  log.info(`[SSE] Message removed from session ${sessionID}`, { messageID })
  removeMessageV2(instanceId, messageID, sessionID)
  updateSessionInfo(instanceId, sessionID)
}

function handleMessagePartRemoved(instanceId: string, event: MessagePartRemovedEvent): void {
  const { sessionID, messageID, partID } = event.properties
  if (!sessionID || !messageID || !partID) return

  log.info(`[SSE] Message part removed from session ${sessionID}`, { messageID, partID })
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
