import type { PermissionV2Reply, PermissionV2Request, EventPermissionV2Replied } from "@opencode-ai/sdk/v2"

export type PermissionReply = PermissionV2Reply
export type PermissionSource = "legacy" | "v2"

export interface LegacyPermissionRequest {
  id: string
  sessionID?: string
  sessionId?: string
  permission?: string
  type?: string
  pattern?: string
  patterns?: string[]
  always?: string[]
  title?: string
  metadata?: Record<string, unknown>
  tool?: {
    messageID?: string
    messageId?: string
    callID?: string
    callId?: string
  }
  messageID?: string
  messageId?: string
  callID?: string
  callId?: string
  partID?: string
  partId?: string
  toolCallID?: string
  toolCallId?: string
  time?: { created?: number }
}

export type PermissionRequest = PermissionV2Request | LegacyPermissionRequest

export type LegacyPermissionAskedEvent = {
  type: "permission.asked" | "permission.updated"
  properties?: LegacyPermissionRequest
}

export type LegacyPermissionRepliedEvent = {
  type: "permission.replied"
  properties?: {
    requestID?: string
    requestId?: string
    permissionID?: string
    permissionId?: string
  }
}

function isV2Permission(permission: PermissionRequest | null | undefined): permission is PermissionV2Request {
  return Boolean(permission && "action" in permission && Array.isArray((permission as PermissionV2Request).resources))
}

export function mergePermissionRequest(previous: PermissionRequest | undefined, next: PermissionRequest): PermissionRequest {
  if (!previous) return next
  const previousMetadata = previous.metadata ?? {}
  const nextMetadata = next.metadata ?? {}
  return {
    ...previous,
    ...next,
    metadata: {
      ...previousMetadata,
      ...nextMetadata,
    },
    source: isV2Permission(next) ? next.source ?? (isV2Permission(previous) ? previous.source : undefined) : undefined,
    tool: !isV2Permission(next) ? next.tool ?? (!isV2Permission(previous) ? previous.tool : undefined) : undefined,
  }
}

export function getPermissionId(permission: PermissionRequest | null | undefined): string {
  return permission?.id ?? ""
}

export function getPermissionSessionId(permission: PermissionRequest | null | undefined): string | undefined {
  return permission?.sessionID ?? (!isV2Permission(permission) ? permission?.sessionId : undefined)
}

export function getPermissionMessageId(permission: PermissionRequest | null | undefined): string | undefined {
  if (isV2Permission(permission)) return permission.source?.messageID
  return permission?.tool?.messageID ?? permission?.tool?.messageId ?? permission?.messageID ?? permission?.messageId
}

export function getPermissionCallId(permission: PermissionRequest | null | undefined): string | undefined {
  if (isV2Permission(permission)) return permission.source?.callID
  const metadata = permission?.metadata ?? {}
  return (
    permission?.tool?.callID ??
    permission?.tool?.callId ??
    permission?.callID ??
    permission?.callId ??
    permission?.toolCallID ??
    permission?.toolCallId ??
    (metadata.callID as string | undefined) ??
    (metadata.callId as string | undefined)
  )
}

export function getPermissionKind(permission: PermissionRequest | null | undefined): string {
  if (isV2Permission(permission)) return permission.action
  return permission?.permission ?? permission?.type ?? "permission"
}

export function getPermissionPatterns(permission: PermissionRequest | null | undefined): string[] {
  if (isV2Permission(permission)) return permission.resources.filter((value) => typeof value === "string")
  const patterns = permission?.patterns
  if (Array.isArray(patterns)) return patterns.filter((value) => typeof value === "string")
  return typeof permission?.pattern === "string" && permission.pattern.length > 0 ? [permission.pattern] : []
}

export function getPermissionDisplayTitle(permission: PermissionRequest | null | undefined): string {
  if (!isV2Permission(permission) && typeof permission?.title === "string" && permission.title.trim().length > 0) {
    return permission.title
  }
  const kind = getPermissionKind(permission)
  const patterns = getPermissionPatterns(permission)
  if (patterns.length > 0) {
    return `${kind}: ${patterns.join(", ")}`
  }
  return kind
}

export function getRequestIdFromPermissionReply(
  properties: EventPermissionV2Replied["properties"] | LegacyPermissionRepliedEvent["properties"] | null | undefined,
): string | undefined {
  return properties?.requestID ?? (properties as LegacyPermissionRepliedEvent["properties"])?.requestId ?? (properties as LegacyPermissionRepliedEvent["properties"])?.permissionID ?? (properties as LegacyPermissionRepliedEvent["properties"])?.permissionId
}
