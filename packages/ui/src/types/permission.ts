import type { PermissionV2Reply, PermissionV2Request, EventPermissionV2Replied } from "@opencode-ai/sdk/v2"

export type PermissionReply = PermissionV2Reply
export type PermissionRequest = PermissionV2Request

export function mergePermissionRequest(previous: PermissionRequest | undefined, next: PermissionRequest): PermissionRequest {
  if (!previous) return next
  return {
    ...previous,
    ...next,
    metadata: {
      ...(previous.metadata ?? {}),
      ...(next.metadata ?? {}),
    },
    source: next.source ?? previous.source,
  }
}

export function getPermissionId(permission: PermissionRequest | null | undefined): string {
  return permission?.id ?? ""
}

export function getPermissionSessionId(permission: PermissionRequest | null | undefined): string | undefined {
  return permission?.sessionID
}

export function getPermissionMessageId(permission: PermissionRequest | null | undefined): string | undefined {
  return permission?.source?.messageID
}

export function getPermissionCallId(permission: PermissionRequest | null | undefined): string | undefined {
  return permission?.source?.callID
}

export function getPermissionKind(permission: PermissionRequest | null | undefined): string {
  return permission?.action ?? "permission"
}

export function getPermissionPatterns(permission: PermissionRequest | null | undefined): string[] {
  return permission?.resources?.filter((value) => typeof value === "string") ?? []
}

export function getPermissionDisplayTitle(permission: PermissionRequest | null | undefined): string {
  const kind = getPermissionKind(permission)
  const patterns = getPermissionPatterns(permission)
  if (patterns.length > 0) {
    return `${kind}: ${patterns.join(", ")}`
  }
  return kind
}

export function getRequestIdFromPermissionReply(properties: EventPermissionV2Replied["properties"] | null | undefined): string | undefined {
  return properties?.requestID
}
