import type { PermissionRequest } from "../../types/permission"
import { getPermissionCallId, getPermissionMessageId, getPermissionSessionId } from "../../types/permission"
import type { Message, MessageInfo } from "../../types/message"
import type { Session } from "../../types/session"
import { messageStoreBus } from "./bus"
import { canHydrateMessages } from "./message-hydration-authority"
import type { MessageStatus, SessionRevertState } from "./types"

interface SessionMetadata {
  id: string
  title?: string
  parentId?: string | null
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
  expectedRevision?: number,
  preserveOmitted = false,
  confirmPending = true,
): boolean {
  if (!session || !Array.isArray(messages)) return false
  const store = messageStoreBus.getOrCreate(instanceId)
  if (expectedRevision !== undefined && !canHydrateMessages(expectedRevision, store.getSessionRevision(session.id))) return false
  const metadata: SessionMetadata = "id" in session ? { id: session.id, title: session.title, parentId: session.parentId ?? null } : session

  store.addOrUpdateSession({
    id: metadata.id,
    title: metadata.title,
    parentId: metadata.parentId ?? null,
    // Transcript-only projections have no authority over session metadata.
    // A full session snapshot can explicitly clear a staged revert.
    ...("revert" in session ? { revert: session.revert ?? null } : {}),
  })

  const normalizedMessages = messages.map((message) => ({
    id: message.id,
    sessionId: message.sessionId,
    role: message.type,
    status: normalizeStatus(message.status),
    createdAt: message.timestamp,
    updatedAt: message.timestamp,
    parts: message.parts,
    // Ephemeral marks records that stand in for something not yet confirmed
    // by the server. A user message present in a REST snapshot IS confirmed,
    // even when its end time is not recorded yet (status "streaming" via the
    // shared derivation) — the live SSE path keeps such user records
    // non-ephemeral, so the REST path must match. Assistant streaming records
    // keep the pre-existing ephemeral treatment.
    isEphemeral: message.status === "sending" || (message.type === "assistant" && message.status === "streaming"),
    bumpRevision: false,
  }))

  store.hydrateMessages(metadata.id, normalizedMessages, messageInfos?.values(), { preserveOmitted, confirmPending })
  return true
}

function extractPermissionMessageId(permission: PermissionRequest): string | undefined {
  return getPermissionMessageId(permission)
}

function extractPermissionPartId(permission: PermissionRequest): string | undefined {
  const metadata = (permission as any).metadata || {}
  return (
    (permission as any).partID ||
    (permission as any).partId ||
    metadata.partID ||
    metadata.partId ||
    undefined
  )
}

function extractPermissionCallId(permission: PermissionRequest): string | undefined {
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
      (part as any).id ??
      undefined
    if (toolCallId === callId && typeof part.id === "string" && part.id.length > 0) {
      return part.id
    }
  }
  return undefined
}

export function upsertPermissionV2(instanceId: string, permission: PermissionRequest): void {
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
    enqueuedAt: Date.now(),
  })
}

export function reconcilePendingPermissionsV2(instanceId: string, sessionId?: string): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const pending = store.state.permissions.queue
  if (!pending || pending.length === 0) return

  for (const entry of pending) {
    if (!entry) continue
    const permission = entry.permission
    if (!permission) continue

    const permissionSessionId = getPermissionSessionId(permission)
    if (sessionId && permissionSessionId && permissionSessionId !== sessionId) {
      continue
    }

    const messageId = entry.messageId ?? extractPermissionMessageId(permission)
    const callId = extractPermissionCallId(permission)
    const resolvedPartId = resolvePartIdFromCallId(store, messageId, callId)
    if (entry.partId && messageId && store.getPermissionState(messageId, entry.partId)) {
      if (!resolvedPartId || resolvedPartId === entry.partId) {
        continue
      }
    }
    if (!resolvedPartId) continue

    store.upsertPermission({
      ...entry,
      messageId,
      partId: resolvedPartId,
    })
  }
}

export function removePermissionV2(instanceId: string, permissionId: string): void {
  if (!permissionId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.removePermission(permissionId)
}

export function removeMessageV2(instanceId: string, messageId: string, sessionId?: string): void {
  if (!messageId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.removeMessage(messageId, sessionId)
}

export function setSessionRevertV2(instanceId: string, sessionId: string, revert?: SessionRevertState | null): void {
  if (!sessionId) return
  const store = messageStoreBus.getOrCreate(instanceId)
  store.setSessionRevert(sessionId, revert ?? null)
}
