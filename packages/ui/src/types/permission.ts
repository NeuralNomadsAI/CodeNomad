export type PermissionReply = "once" | "always" | "reject"

export interface PermissionToolRefLike {
  messageID?: string
  messageId?: string
  callID?: string
  callId?: string
}

// Compat type that covers both the legacy Permission.Info payload and the new
// PermissionNext.Request payload.
export interface PermissionRequestLike {
  id: string

  // Legacy fields
  type?: string
  pattern?: string
  title?: string
  sessionID?: string
  messageID?: string
  messageId?: string
  callID?: string
  callId?: string
  metadata?: Record<string, unknown>
  time?: { created?: number }

  // New fields
  permission?: string
  patterns?: string[]
  always?: string[]
  tool?: PermissionToolRefLike
}

export interface PermissionReplyEventPropertiesLike {
  sessionID?: string
  sessionId?: string
  permissionID?: string
  permissionId?: string
  requestID?: string
  requestId?: string
  response?: PermissionReply
  reply?: PermissionReply
}

export function getPermissionId(permission: PermissionRequestLike | null | undefined): string {
  return permission?.id ?? ""
}

export function getPermissionSessionId(permission: PermissionRequestLike | null | undefined): string | undefined {
  return (
    (permission as any)?.sessionID ??
    (permission as any)?.sessionId ??
    undefined
  )
}

export function getPermissionMessageId(permission: PermissionRequestLike | null | undefined): string | undefined {
  const tool = (permission as any)?.tool as PermissionToolRefLike | undefined
  return (
    tool?.messageID ??
    tool?.messageId ??
    (permission as any)?.messageID ??
    (permission as any)?.messageId ??
    undefined
  )
}

export function getPermissionCallId(permission: PermissionRequestLike | null | undefined): string | undefined {
  const tool = (permission as any)?.tool as PermissionToolRefLike | undefined
  const metadata = (permission as any)?.metadata || {}
  return (
    tool?.callID ??
    tool?.callId ??
    (permission as any)?.callID ??
    (permission as any)?.callId ??
    (permission as any)?.toolCallID ??
    (permission as any)?.toolCallId ??
    metadata.callID ??
    metadata.callId ??
    undefined
  )
}

export function getPermissionCreatedAt(permission: PermissionRequestLike | null | undefined): number {
  const created = (permission as any)?.time?.created
  return typeof created === "number" ? created : Date.now()
}

export function getPermissionKind(permission: PermissionRequestLike | null | undefined): string {
  return (
    (permission as any)?.permission ??
    (permission as any)?.type ??
    "permission"
  )
}

export function getPermissionPatterns(permission: PermissionRequestLike | null | undefined): string[] {
  const patterns = (permission as any)?.patterns
  if (Array.isArray(patterns)) {
    return patterns.filter((value) => typeof value === "string")
  }
  const pattern = (permission as any)?.pattern
  if (typeof pattern === "string" && pattern.length > 0) {
    return [pattern]
  }
  return []
}

export function getPermissionDisplayTitle(permission: PermissionRequestLike | null | undefined): string {
  const title = (permission as any)?.title
  if (typeof title === "string" && title.trim().length > 0) {
    return title
  }

  const kind = getPermissionKind(permission)
  const patterns = getPermissionPatterns(permission)
  if (patterns.length > 0) {
    return `${kind}: ${patterns.join(", ")}`
  }
  return kind
}

export function getRequestIdFromPermissionReply(properties: PermissionReplyEventPropertiesLike | null | undefined): string | undefined {
  return (
    (properties as any)?.requestID ??
    (properties as any)?.requestId ??
    (properties as any)?.permissionID ??
    (properties as any)?.permissionId ??
    undefined
  )
}
