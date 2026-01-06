import type {
  MessageInfo,
  MessagePartRemovedEvent,
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

import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"
import { getPermissionId, getPermissionKind, getRequestIdFromPermissionReply } from "../types/permission"
import type { PermissionReplyEventPropertiesLike, PermissionRequestLike } from "../types/permission"
import { showToastNotification, ToastVariant } from "../lib/notifications"
import { instances, addPermissionToQueue, removePermissionFromQueue } from "./instances"
import { showAlertDialog } from "./alerts"
import { createClientSession, mapSdkSessionStatus, type Session, type SessionStatus } from "../types/session"
import { sessions, setSessions, syncInstanceSessionIndicator, withSession } from "./session-state"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"

import { loadMessages } from "./session-api"
import {
  applyPartUpdateV2,
  replaceMessageIdV2,
  upsertMessageInfoV2,
  upsertPermissionV2,
  removeMessagePartV2,
  removeMessageV2,
  removePermissionV2,
  setSessionRevertV2,
} from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import type { InstanceMessageStore } from "./message-v2/instance-store"

const log = getLogger("sse")
const pendingSessionFetches = new Map<string, Promise<void>>()

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

function applySessionStatus(instanceId: string, sessionId: string, status: SessionStatus) {
  withSession(instanceId, sessionId, (session) => {
    const current = session.status ?? "idle"
    if (current === status) return false

    if (current === "compacting" && status !== "compacting") {
      return false
    }

    session.status = status
  })
}

async function fetchSessionInfo(instanceId: string, sessionId: string): Promise<Session | null> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return null

  try {
    const info = await requestData<any>(
      instance.client.session.get({ sessionID: sessionId }),
      "session.get",
    )

    let fetchedStatus: SessionStatus = "idle"
    try {
      const statuses = await requestData<Record<string, any>>(instance.client.session.status(), "session.status")
      const rawStatus = (info as any)?.status ?? statuses?.[sessionId]
      const hasType = rawStatus && typeof rawStatus === "object" && typeof rawStatus.type === "string"
      fetchedStatus = hasType ? mapSdkSessionStatus(rawStatus) : "idle"
    } catch (error) {
      log.error("Failed to fetch session status", error)
    }

    const fetched = createClientSession(info, instanceId, "", { providerId: "", modelId: "" }, fetchedStatus)

    let updatedInstanceSessions: Map<string, Session> | undefined

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) ?? new Map<string, Session>()
      const existing = instanceSessions.get(sessionId)
      const merged: Session = {
        ...fetched,
        agent: existing?.agent ?? fetched.agent,
        model: existing?.model ?? fetched.model,
        status: existing?.status === "compacting" ? "compacting" : fetched.status,
        pendingPermission: existing?.pendingPermission ?? fetched.pendingPermission,
      }
      instanceSessions.set(sessionId, merged)
      next.set(instanceId, instanceSessions)
      updatedInstanceSessions = instanceSessions
      return next
    })

    syncInstanceSessionIndicator(instanceId, updatedInstanceSessions)

    return fetched
  } catch (error) {
    log.error("Failed to fetch session info", error)
    return null
  }
}

function ensureSessionStatus(instanceId: string, sessionId: string, status: SessionStatus) {
  const instanceSessions = sessions().get(instanceId)
  const existing = instanceSessions?.get(sessionId)
  if (existing) {
    if ((existing.status ?? "idle") === status) {
      return
    }
    applySessionStatus(instanceId, sessionId, status)
    return
  }

  const key = `${instanceId}:${sessionId}`
  if (pendingSessionFetches.has(key)) {
    return
  }

  const pending = (async () => {
    const fetched = await fetchSessionInfo(instanceId, sessionId)
    if (!fetched) return
    applySessionStatus(instanceId, sessionId, status)
  })()

  pendingSessionFetches.set(key, pending)
  void pending.finally(() => pendingSessionFetches.delete(key))
}

type MessageRole = "user" | "assistant"


function resolveMessageRole(info?: MessageInfo | null): MessageRole {
  return info?.role === "user" ? "user" : "assistant"
}

function findPendingMessageId(
  store: InstanceMessageStore,
  sessionId: string,
  role: MessageRole,
): string | undefined {
  const messageIds = store.getSessionMessageIds(sessionId)
  const lastId = messageIds[messageIds.length - 1]
  if (!lastId) return undefined
  const record = store.getMessage(lastId)
  if (!record) return undefined
  if (record.sessionId !== sessionId) return undefined
  if (record.role !== role) return undefined
  return record.status === "sending" ? record.id : undefined
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
      ensureSessionStatus(instanceId, sessionId, "compacting")
    }

    const store = messageStoreBus.getOrCreate(instanceId)
    const role: MessageRole = resolveMessageRole(messageInfo)
    const createdAt = typeof messageInfo?.time?.created === "number" ? messageInfo.time.created : Date.now()


    let record = store.getMessage(messageId)
    if (!record) {
      const pendingId = findPendingMessageId(store, sessionId, role)
      if (pendingId && pendingId !== messageId) {
        replaceMessageIdV2(instanceId, pendingId, messageId)
        record = store.getMessage(messageId)
      }
    }

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
 
    applyPartUpdateV2(instanceId, { ...part, sessionID: sessionId, messageID: messageId })


    updateSessionInfo(instanceId, sessionId)
  } else if (event.type === "message.updated") {
    const info = event.properties?.info
    if (!info) return

    const sessionId = typeof info.sessionID === "string" ? info.sessionID : undefined
    const messageId = typeof info.id === "string" ? info.id : undefined
    if (!sessionId || !messageId) return

    withSession(instanceId, sessionId, (session) => {
      session.time = { ...(session.time ?? {}), updated: Date.now() }
    })

    const store = messageStoreBus.getOrCreate(instanceId)

    const role: MessageRole = info.role === "user" ? "user" : "assistant"
    const hasError = Boolean((info as any).error)
    const status: MessageStatus = hasError ? "error" : "complete"

    let record = store.getMessage(messageId)
    if (!record) {
      const pendingId = findPendingMessageId(store, sessionId, role)
      if (pendingId && pendingId !== messageId) {
        replaceMessageIdV2(instanceId, pendingId, messageId)
        record = store.getMessage(messageId)
      }
    }

    if (!record) {
      const createdAt = info.time?.created ?? Date.now()
      const completedAt = (info.time as { completed?: number } | undefined)?.completed
      store.upsertMessage({
        id: messageId,
        sessionId,
        role,
        status,
        createdAt,
        updatedAt: completedAt ?? createdAt,
      })
    }

    upsertMessageInfoV2(instanceId, info, { status, bumpRevision: true })

    updateSessionInfo(instanceId, sessionId)
  }
}

function handleSessionUpdate(instanceId: string, event: EventSessionUpdated): void {
  const info = event.properties?.info

  if (!info) return

  const instanceSessions = sessions().get(instanceId) ?? new Map<string, Session>()

  const existingSession = instanceSessions.get(info.id)

  if (!existingSession) {
    const newSession = {
      id: info.id,
      instanceId,
      title: info.title || "Untitled",
      parentId: info.parentID || null,
      agent: "",
      model: {
        providerId: "",
        modelId: "",
      },
      status: "idle",
      version: info.version || "0",
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
    setSessionRevertV2(instanceId, info.id, info.revert ?? null)

    log.info(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const mergedTime = {
      ...existingSession.time,
      ...(info.time ?? {}),
    }
    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
      status: existingSession.status ?? "idle",
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

function handleSessionIdle(instanceId: string, event: EventSessionIdle): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  ensureSessionStatus(instanceId, sessionId, "idle")
  log.info(`[SSE] Session idle: ${sessionId}`)
}

function handleSessionStatus(instanceId: string, event: EventSessionStatus): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  const status = mapSdkSessionStatus(event.properties.status)
  ensureSessionStatus(instanceId, sessionId, status)
  log.info(`[SSE] Session status updated: ${sessionId}`, { status })
}

function handleSessionCompacted(instanceId: string, event: EventSessionCompacted): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)

  const existing = sessions().get(instanceId)?.get(sessionID)
  if (existing) {
    withSession(instanceId, sessionID, (session) => {
      session.status = "working"
    })
  } else {
    ensureSessionStatus(instanceId, sessionID, "working")
  }

  loadMessages(instanceId, sessionID, true).catch((error) => log.error("Failed to reload session after compaction", error))

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionID)
  const label = session?.title?.trim() ? session.title : sessionID
  const instanceFolder = instances().get(instanceId)?.folder ?? instanceId
  const instanceName = instanceFolder.split(/[\\/]/).filter(Boolean).pop() ?? instanceFolder

  showToastNotification({
    title: instanceName,
    message: `Session ${label ? `"${label}"` : sessionID} was compacted`,
    variant: "info",
    duration: 10000,
  })
}

function handleSessionError(_instanceId: string, event: EventSessionError): void {
  const error = event.properties?.error
  log.error(`[SSE] Session error:`, error)

  let message = "Unknown error"

  if (error) {
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
      message = error.data.message as string
    } else if ("message" in error && typeof error.message === "string") {
      message = error.message
    }
  }

  showAlertDialog(`Error: ${message}`, {
    title: "Session error",
    variant: "error",
  })
}

function handleMessageRemoved(instanceId: string, event: MessageRemovedEvent): void {
  const { sessionID, messageID } = event.properties
  if (!sessionID || !messageID) return

  log.info(`[SSE] Message removed from session ${sessionID}`, { messageID })
  removeMessageV2(instanceId, messageID)
  updateSessionInfo(instanceId, sessionID)
}

function handleMessagePartRemoved(instanceId: string, event: MessagePartRemovedEvent): void {
  const { sessionID, messageID, partID } = event.properties
  if (!sessionID || !messageID || !partID) return

  log.info(`[SSE] Message part removed from session ${sessionID}`, { messageID, partID })
  removeMessagePartV2(instanceId, messageID, partID)
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

function handlePermissionUpdated(instanceId: string, event: { type: string; properties?: PermissionRequestLike } | any): void {
  const permission = event?.properties as PermissionRequestLike | undefined
  if (!permission) return

  log.info(`[SSE] Permission request: ${getPermissionId(permission)} (${getPermissionKind(permission)})`)
  addPermissionToQueue(instanceId, permission)
  upsertPermissionV2(instanceId, permission)
}

function handlePermissionReplied(instanceId: string, event: { type: string; properties?: PermissionReplyEventPropertiesLike } | any): void {
  const properties = event?.properties as PermissionReplyEventPropertiesLike | undefined
  const requestId = getRequestIdFromPermissionReply(properties)
  if (!requestId) {
    log.warn(`[SSE] Permission replied but no requestId found:`, properties)
    return
  }

  log.info(`[SSE] Permission replied: ${requestId}`)
  log.info(`[SSE] Calling removePermissionFromQueue and removePermissionV2 for: ${requestId}`)
  removePermissionFromQueue(instanceId, requestId)
  removePermissionV2(instanceId, requestId)
}

export {
  handleMessagePartRemoved,
  handleMessageRemoved,
  handleMessageUpdate,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleSessionCompacted,
  handleSessionError,
  handleSessionIdle,
  handleSessionStatus,
  handleSessionUpdate,
  handleTuiToast,
}
