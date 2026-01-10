import type { PermissionRequestLike } from "../../types/permission"
import { getPermissionCallId, getPermissionMessageId } from "../../types/permission"
import type { QuestionRequest } from "../../types/question"
import { getQuestionCallId, getQuestionMessageId } from "../../types/question"
import type { Message, MessageInfo, ClientPart } from "../../types/message"
import type { Session } from "../../types/session"
import { messageStoreBus } from "./bus"
import type { MessageStatus, SessionRevertState } from "./types"

interface SessionMetadata {
  id: string
  title?: string
  parentId?: string | null
}

function resolveSessionMetadata(session?: Session | null): SessionMetadata | undefined {
  if (!session) return undefined
  return {
    id: session.id,
    title: session.title,
    parentId: session.parentId ?? null,
  }
}

function normalizeStatus(status: Message["status"]): MessageStatus {
  switch (status) {
    case "sending":
    case "sent":
    case "streaming":
    case "complete":
    case "error":
      return status
    default:
      return "complete"
  }
}

export function seedSessionMessagesV2(
  instanceId: string,
  session: Session | SessionMetadata,
  messages: Message[],
  messageInfos?: Map<string, MessageInfo>,
): void {
  if (!session || !Array.isArray(messages)) return
  const store = messageStoreBus.getOrCreate(instanceId)
  const metadata: SessionMetadata = "id" in session ? { id: session.id, title: session.title, parentId: session.parentId ?? null } : session

  store.addOrUpdateSession({
    id: metadata.id,
    title: metadata.title,
    parentId: metadata.parentId ?? null,
    revert: (session as Session)?.revert ?? undefined,
  })

  const normalizedMessages = messages.map((message) => ({
    id: message.id,
    sessionId: message.sessionId,
    role: message.type,
    status: normalizeStatus(message.status),
    createdAt: message.timestamp,
    updatedAt: message.timestamp,
    parts: message.parts,
    isEphemeral: message.status === "sending" || message.status === "streaming",
    bumpRevision: false,
  }))

  store.hydrateMessages(metadata.id, normalizedMessages, messageInfos?.values())
}

interface MessageInfoOptions {
  status?: MessageStatus
  bumpRevision?: boolean
}

export function upsertMessageInfoV2(instanceId: string, info: MessageInfo | null | undefined, options?: MessageInfoOptions): void {
  if (!info || typeof info.id !== "string" || typeof info.sessionID !== "string") {
    return
  }
  const store = messageStoreBus.getOrCreate(instanceId)
  const timeInfo = (info.time ?? {}) as { created?: number; completed?: number }
  const createdAt = typeof timeInfo.created === "number" ? timeInfo.created : Date.now()
  const completedAt = typeof timeInfo.completed === "number" ? timeInfo.completed : undefined

  store.upsertMessage({
    id: info.id,
    sessionId: info.sessionID,
    role: info.role === "user" ? "user" : "assistant",
    status: options?.status ?? "complete",
    createdAt,
    updatedAt: completedAt ?? createdAt,
    bumpRevision: Boolean(options?.bumpRevision),
  })
  store.setMessageInfo(info.id, info)
}

export function applyPartUpdateV2(instanceId: string, part: ClientPart | null | undefined): void {
  if (!part || typeof part.messageID !== "string") {
    return
  }
  const store = messageStoreBus.getOrCreate(instanceId)
  store.applyPartUpdate({
    messageId: part.messageID,
    part,
  })
}

export function replaceMessageIdV2(instanceId: string, oldId: string, newId: string): void {
  if (!oldId || !newId || oldId === newId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.replaceMessageId({ oldId, newId })
}

function extractPermissionMessageId(permission: PermissionRequestLike): string | undefined {
  return getPermissionMessageId(permission)
}

function extractPermissionPartId(permission: PermissionRequestLike): string | undefined {
  const metadata = (permission as any).metadata || {}
  return (
    (permission as any).partID ||
    (permission as any).partId ||
    metadata.partID ||
    metadata.partId ||
    undefined
  )
}

function extractPermissionCallId(permission: PermissionRequestLike): string | undefined {
  return getPermissionCallId(permission)
}

function resolvePartIdFromCallId(store: ReturnType<typeof messageStoreBus.getOrCreate>, messageId?: string, callId?: string): string | undefined {
  if (!messageId || !callId) return undefined
  const record = store.getMessage(messageId)
  if (!record) return undefined
  for (const partId of record.partIds) {
    const part = record.parts[partId]?.data
    if (!part || part.type !== "tool") continue
    const toolCallId =
      (part as any).callID ??
      (part as any).callId ??
      (part as any).toolCallID ??
      (part as any).toolCallId ??
      undefined
    if (toolCallId === callId && typeof part.id === "string" && part.id.length > 0) {
      return part.id
    }
  }
  return undefined
}

export function upsertPermissionV2(instanceId: string, permission: PermissionRequestLike): void {
  if (!permission) return
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageId = extractPermissionMessageId(permission)
  let partId = extractPermissionPartId(permission)
  if (!partId) {
    const callId = extractPermissionCallId(permission)
    partId = resolvePartIdFromCallId(store, messageId, callId)
  }
  store.upsertPermission({
    permission,
    messageId,
    partId,
    enqueuedAt: (permission as any).time?.created ?? Date.now(),
  })
}

export function reconcilePendingPermissionsV2(instanceId: string, sessionId?: string): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const pending = store.state.permissions.queue
  if (!pending || pending.length === 0) return

  for (const entry of pending) {
    if (!entry || entry.partId) continue
    const permission = entry.permission
    if (!permission) continue

    const permissionSessionId = (permission as any)?.sessionID ?? (permission as any)?.sessionId ?? undefined
    if (sessionId && permissionSessionId && permissionSessionId !== sessionId) {
      continue
    }

    const messageId = entry.messageId ?? extractPermissionMessageId(permission)
    const callId = extractPermissionCallId(permission)
    const resolvedPartId = resolvePartIdFromCallId(store, messageId, callId)
    if (!resolvedPartId) continue

    store.upsertPermission({
      ...entry,
      messageId,
      partId: resolvedPartId,
    })
  }
}

function extractQuestionMessageId(request: QuestionRequest): string | undefined {
  return getQuestionMessageId(request)
}

function extractQuestionCallId(request: QuestionRequest): string | undefined {
  return getQuestionCallId(request)
}

export function upsertQuestionV2(instanceId: string, request: QuestionRequest): void {
  if (!request) return
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageId = extractQuestionMessageId(request)
  let partId: string | undefined = undefined
  const callId = extractQuestionCallId(request)
  if (callId) {
    partId = resolvePartIdFromCallId(store, messageId, callId)
  }
  store.upsertQuestion({
    request,
    messageId,
    partId,
    enqueuedAt: (request as any).time?.created ?? Date.now(),
  })
}

export function reconcilePendingQuestionsV2(instanceId: string, sessionId?: string): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const pending = store.state.questions.queue
  if (!pending || pending.length === 0) return

  for (const entry of pending) {
    if (!entry || entry.partId) continue
    const request = entry.request
    if (!request) continue

    const questionSessionId = request.sessionID
    if (sessionId && questionSessionId && questionSessionId !== sessionId) {
      continue
    }

    const messageId = entry.messageId ?? extractQuestionMessageId(request)
    const callId = extractQuestionCallId(request)
    const resolvedPartId = resolvePartIdFromCallId(store, messageId, callId)
    if (!resolvedPartId) continue

    store.upsertQuestion({
      ...entry,
      messageId,
      partId: resolvedPartId,
    })
  }
}

export function removeQuestionV2(instanceId: string, requestId: string): void {
  if (!requestId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.removeQuestion(requestId)
}

export function removePermissionV2(instanceId: string, permissionId: string): void {
  if (!permissionId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.removePermission(permissionId)
}

export function removeMessageV2(instanceId: string, messageId: string): void {
  if (!messageId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.removeMessage(messageId)
}

export function removeMessagePartV2(instanceId: string, messageId: string, partId: string): void {
  if (!messageId || !partId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.removeMessagePart(messageId, partId)
}

export function ensureSessionMetadataV2(instanceId: string, session: Session | null | undefined): void {
  if (!session) return
  const store = messageStoreBus.getOrCreate(instanceId)
  const existingMessageIds = store.getSessionMessageIds(session.id)
  store.addOrUpdateSession({
    id: session.id,
    title: session.title,
    parentId: session.parentId ?? null,
    messageIds: existingMessageIds,
  })
}

export function getSessionMetadataFromStore(session?: Session | null): SessionMetadata | undefined {
  return resolveSessionMetadata(session ?? undefined)
}

export function setSessionRevertV2(instanceId: string, sessionId: string, revert?: SessionRevertState | null): void {
  if (!sessionId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.setSessionRevert(sessionId, revert ?? null)
}
