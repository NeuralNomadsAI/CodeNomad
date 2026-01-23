import type {
  MessageInfo,
  MessagePartRemovedEvent,
  MessagePartUpdatedEvent,
  MessageRemovedEvent,
  MessageUpdateEvent,
} from "../types/message"
import type {
  EventPermissionReplied,
  EventPermissionUpdated,
  EventSessionCompacted,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
} from "@opencode-ai/sdk"
import type { MessageStatus } from "./message-v2/types"

import { getLogger } from "../lib/logger"
import { showToastNotification, ToastVariant } from "../lib/notifications"
import { instances, addPermissionToQueue, removePermissionFromQueue } from "./instances"
import { showAlertDialog } from "./alerts"
import { sessions, setSessions, withSession, markSubagentComplete } from "./session-state"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"

const log = getLogger("sse")
import { loadMessages } from "./session-api"
import { setSessionCompactionState } from "./session-compaction"
import { scheduleChildCleanup, updateSessionActivity, cancelScheduledCleanup } from "./session-cleanup"
import { processToolCallForWorkspace } from "./workspace-state"
import {
  applyPartUpdateV2,
  replaceMessageIdV2,
  upsertMessageInfoV2,
  upsertPermissionV2,
  removePermissionV2,
  setSessionRevertV2,
} from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import type { InstanceMessageStore } from "./message-v2/instance-store"

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
  if (!instanceSessions) return

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
 
    const session = instanceSessions.get(sessionId)
    if (!session) return
 
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

    // Track tool calls for workspace panel
    if (part.type === "tool" && typeof part.tool === "string") {
      const toolState = (part as any).state
      const toolStatus = toolState?.status === "completed" ? "complete"
        : toolState?.status === "error" ? "error"
        : "running"
      const input = toolState?.input || {}
      processToolCallForWorkspace(
        instanceId,
        part.id || messageId,
        part.tool,
        input,
        toolStatus
      )
    }

    updateSessionInfo(instanceId, sessionId)
  } else if (event.type === "message.updated") {
    const info = event.properties?.info
    if (!info) return

    const sessionId = typeof info.sessionID === "string" ? info.sessionID : undefined
    const messageId = typeof info.id === "string" ? info.id : undefined
    if (!sessionId || !messageId) return

    const session = instanceSessions.get(sessionId)
    if (!session) return

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

  const compactingFlag = info.time?.compacting
  const isCompacting = typeof compactingFlag === "number" ? compactingFlag > 0 : Boolean(compactingFlag)
  setSessionCompactionState(instanceId, info.id, isCompacting)

  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

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
      version: info.version || "0",
      time: info.time
        ? { ...info.time }
        : {
            created: Date.now(),
            updated: Date.now(),
          },
    } as any

    setSessions((prev) => {
      const next = new Map(prev)
      const updated = new Map(prev.get(instanceId))
      updated.set(newSession.id, newSession)
      next.set(instanceId, updated)
      return next
    })
    setSessionRevertV2(instanceId, info.id, info.revert ?? null)

    log.info(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const mergedTime = {
      ...existingSession.time,
      ...(info.time ?? {}),
    }
    if (!info.time?.updated) {
      mergedTime.updated = Date.now()
    }

    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
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

    // Update activity tracking and cancel any scheduled cleanup
    updateSessionActivity(instanceId, info.id)
    if (existingSession.parentId) {
      // If this is a child session that becomes active, cancel cleanup
      cancelScheduledCleanup(instanceId, info.id)
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const updated = new Map(prev.get(instanceId))
      updated.set(existingSession.id, updatedSession)
      next.set(instanceId, updated)
      return next
    })
    setSessionRevertV2(instanceId, info.id, info.revert ?? null)
  }
}

function handleSessionIdle(instanceId: string, event: EventSessionIdle): void {
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  log.info(`[SSE] Session idle: ${sessionId}`)

  // Check if this is a child session (has parentId)
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)

  if (session?.parentId) {
    // Schedule cleanup for idle child sessions
    log.info(`Scheduling cleanup for idle child session: ${sessionId}`)
    scheduleChildCleanup(instanceId, sessionId, session.parentId)

    // Mark subagent as complete for archiving logic
    const store = messageStoreBus.getOrCreate(instanceId)
    const parentMessageCount = store.getSessionMessageIds(session.parentId).length
    markSubagentComplete(instanceId, sessionId, parentMessageCount)
    log.info(`Marked subagent ${sessionId} as complete at parent message count ${parentMessageCount}`)
  }

  // Update session status to idle
  withSession(instanceId, sessionId, (s) => {
    s.status = "idle"
  })
}

function handleSessionCompacted(instanceId: string, event: EventSessionCompacted): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  log.info(`[SSE] Session compacted: ${sessionID}`)

  setSessionCompactionState(instanceId, sessionID, false)

  withSession(instanceId, sessionID, (session) => {
    const time = { ...(session.time ?? {}) }
    time.compacting = 0
    session.time = time
  })

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
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  log.info(`[SSE] Message removed from session ${sessionID}, reloading messages`)
  loadMessages(instanceId, sessionID, true).catch((error) => log.error("Failed to reload messages after removal", error))
}

function handleMessagePartRemoved(instanceId: string, event: MessagePartRemovedEvent): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  log.info(`[SSE] Message part removed from session ${sessionID}, reloading messages`)
  loadMessages(instanceId, sessionID, true).catch((error) => log.error("Failed to reload messages after part removal", error))
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

function handlePermissionUpdated(instanceId: string, event: EventPermissionUpdated): void {
  const permission = event.properties
  if (!permission) return

  log.info(`[SSE] Permission updated: ${permission.id} (${permission.type})`)
  addPermissionToQueue(instanceId, permission)
  upsertPermissionV2(instanceId, permission)
}

function handlePermissionReplied(instanceId: string, event: EventPermissionReplied): void {
  const { permissionID } = event.properties
  if (!permissionID) return

  log.info(`[SSE] Permission replied: ${permissionID}`)
  removePermissionFromQueue(instanceId, permissionID)
  removePermissionV2(instanceId, permissionID)
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
  handleSessionUpdate,
  handleTuiToast,
}
