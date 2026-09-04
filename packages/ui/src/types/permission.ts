import type { PermissionReply as NativePermissionReply, PermissionReplied, PermissionRequest as NativePermissionRequest } from "@opencode-ai/client"

export type PermissionReply = NativePermissionReply
export type PermissionRequest = NativePermissionRequest

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
  return permission?.source?.id
}

export function getPermissionKind(permission: PermissionRequest | null | undefined): string {
  return permission?.action ?? "permission"
}

export function getPermissionPatterns(permission: PermissionRequest | null | undefined): string[] {
  return permission?.resources.filter((value) => typeof value === "string") ?? []
}

export function getPermissionDisplayTitle(permission: PermissionRequest | null | undefined): string {
  const kind = getPermissionKind(permission)
  const patterns = getPermissionPatterns(permission)
  if (patterns.length > 0) {
    return `${kind}: ${patterns.join(", ")}`
  }
  return kind
}

export function getRequestIdFromPermissionReply(
  data: PermissionReplied["data"] | null | undefined,
): string | undefined {
  return data?.requestID
}
