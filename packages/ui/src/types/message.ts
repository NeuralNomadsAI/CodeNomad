import type {
  SessionMessageInfo,
  SessionStructuredError,
} from "@opencode-ai/client"

import type { PermissionRequest } from "./permission"
import type { ToolState } from "./tool-state"

interface PartBase {
  id?: string
  sessionID?: string
  messageID?: string
  synthetic?: boolean
  [key: string]: unknown
}

interface TextMessagePart extends PartBase { type: "text"; text: string }
interface ReasoningMessagePart extends PartBase { type: "reasoning"; text: string }
interface FileMessagePart extends PartBase { type: "file"; filename?: string }
interface ToolMessagePart extends PartBase { type: "tool"; tool: string; state?: ToolState }
interface CompactionMessagePart extends PartBase { type: "compaction" }
interface StepStartMessagePart extends PartBase { type: "step-start" }
interface StepFinishMessagePart extends PartBase { type: "step-finish" }

export type NormalizedMessagePart =
  | TextMessagePart
  | ReasoningMessagePart
  | FileMessagePart
  | ToolMessagePart
  | CompactionMessagePart
  | StepStartMessagePart
  | StepFinishMessagePart

export type NativeSessionMessageInfo = SessionMessageInfo

export interface RenderCache {
  text: string
  html: string
  theme?: string
  mode?: string
  wrap?: boolean
}

export interface PendingPermissionState {
  permission: PermissionRequest
  active: boolean
}

// Client-specific extensions on the normalized part union.
export type ClientPart = NormalizedMessagePart & {
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

export interface MessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: {
    created: number
    completed?: number
  }
  mode?: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  error?: (SessionStructuredError & {
    name?: string
    data?: { message?: string }
  }) | null
  summary?: boolean
  text?: string
}

export function isHiddenSyntheticTextPart(part: ClientPart): boolean {
  return Boolean(part && part.type === "text" && part.synthetic)
}

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

  if (isHiddenSyntheticTextPart(part)) {
    return false
  }

  if (part.type === "text" && hasTextSegment(part.text)) {
    return true
  }

  if (part.type === "file" && part.filename) {
    return true
  }

  if (part.type === "tool") {
    return true // Tool parts are always renderable
  }

  if (part.type === "reasoning" && hasTextSegment(part.text)) {
    return true
  }

  return false
}
