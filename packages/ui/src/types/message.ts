// SDK types
import type {
  EventMessageUpdated as MessageUpdateEvent,
  EventMessageRemoved as MessageRemovedEvent,
  EventMessagePartUpdated as MessagePartUpdatedEvent,
  EventMessagePartRemoved as MessagePartRemovedEvent,
  Part as SDKPart,
  Message as SDKMessage,
  Permission,
} from "@opencode-ai/sdk"

// Re-export for other modules
export type {
  MessageUpdateEvent,
  MessageRemovedEvent,
  MessagePartUpdatedEvent,
  MessagePartRemovedEvent,
  SDKPart,
  SDKMessage
}

export interface RenderCache {
  text: string
  html: string
  theme?: string
  mode?: string
}

export interface PendingPermissionState {
  permission: Permission
  active: boolean
}

// Client-specific part extensions (using intersection type since SDKPart is a union)
export type ClientPart = SDKPart & {
  sessionID?: string
  messageID?: string
  synthetic?: boolean
  renderCache?: RenderCache
  pendingPermission?: PendingPermissionState
}

export interface Message {
  id: string
  sessionId: string
  type: "user" | "assistant"
  parts: ClientPart[]
  timestamp: number
  status: "sending" | "sent" | "streaming" | "complete" | "error"
  version: number
}

export interface TextPart {
  id?: string
  type: "text"
  text: string
  version?: number
  synthetic?: boolean
  renderCache?: RenderCache
}

export type MessageInfo = SDKMessage

function hasTextSegment(segment: string | { text?: string }): boolean {
  if (typeof segment === "string") {
    return segment.trim().length > 0
  }

  if (segment && typeof segment === "object" && segment.text) {
    return typeof segment.text === "string" && segment.text.trim().length > 0
  }

  return false
}

export function partHasRenderableText(part: ClientPart): boolean {
  if (!part || typeof part !== "object") {
    return false
  }

  const typedPart = part as SDKPart
  
  if (typedPart.type === "text" && hasTextSegment(typedPart.text)) {
    return true
  }

  if (typedPart.type === "file" && (typedPart as any).filename) {
    return true
  }

  if (typedPart.type === "tool") {
    return true // Tool parts are always renderable
  }

  if (typedPart.type === "reasoning" && hasTextSegment(typedPart.text)) {
    return true
  }

  return false
}
