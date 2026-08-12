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

export function getPermissionDisplayTitle(permission: PermissionRequest | null | undefined): string {
  const kind = getPermissionKind(permission).slice(0, 384)
  const titleLimit = 384
  let title = `${kind}: `
  let count = 0
  let scanned = 0
  for (const resource of permission?.resources ?? []) {
    if (++scanned > 10_000) break
    if (typeof resource !== "string") continue
    const separator = count > 0 ? ", " : ""
    const remaining = titleLimit - title.length - separator.length
    if (remaining <= 3) break
    title += separator + resource.slice(0, remaining)
    count += 1
  }
  return count > 0 ? title : kind
}

export function getRequestIdFromPermissionReply(
  data: PermissionReplied["data"] | null | undefined,
): string | undefined {
  return data?.requestID
}
