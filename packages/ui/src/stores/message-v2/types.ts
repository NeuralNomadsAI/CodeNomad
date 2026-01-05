import type { ClientPart } from "../../types/message"
import type { PermissionRequestLike } from "../../types/permission"

export type MessageStatus = "sending" | "sent" | "streaming" | "complete" | "error"
export type MessageRole = "user" | "assistant"

export interface NormalizedPartRecord {
  id: string
  data: ClientPart
  revision: number
}

export interface MessageRecord {
  id: string
  sessionId: string
  role: MessageRole
  status: MessageStatus
  createdAt: number
  updatedAt: number
  revision: number
  isEphemeral?: boolean
  partIds: string[]
  parts: Record<string, NormalizedPartRecord>
}

export interface SessionRevertState {
  messageID?: string
  partID?: string
  snapshot?: string
  diff?: string
}

export interface SessionRecord {
  id: string
  title?: string
  parentId?: string | null
  createdAt: number
  updatedAt: number
  messageIds: string[]
  revert?: SessionRevertState | null
}

export interface PendingPartEntry {
  messageId: string
  part: ClientPart
  receivedAt: number
}

export interface PermissionEntry {
  permission: PermissionRequestLike
  messageId?: string
  partId?: string
  enqueuedAt: number
}

export interface InstancePermissionState {
  queue: PermissionEntry[]
  active: PermissionEntry | null
  byMessage: Record<string, Record<string, PermissionEntry>>
}

export interface ScrollSnapshot {
  scrollTop: number
  atBottom: boolean
  updatedAt: number
}

export interface UsageEntry {
  messageId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  combinedTokens: number
  cost: number
  timestamp: number
  hasContextUsage: boolean
}

export interface SessionUsageState {
  entries: Record<string, UsageEntry>
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCost: number
  actualUsageTokens: number
  latestMessageId?: string
}

export interface LatestTodoSnapshot {
  messageId: string
  partId: string
  timestamp: number
}

export interface InstanceMessageState {
  instanceId: string
  sessions: Record<string, SessionRecord>
  sessionOrder: string[]
  messages: Record<string, MessageRecord>
  messageInfoVersion: Record<string, number>
  pendingParts: Record<string, PendingPartEntry[]>
  sessionRevisions: Record<string, number>
  permissions: InstancePermissionState
  usage: Record<string, SessionUsageState>
  scrollState: Record<string, ScrollSnapshot>
  latestTodos: Record<string, LatestTodoSnapshot | undefined>
}

export interface SessionUpsertInput {
  id: string
  title?: string
  parentId?: string | null
  messageIds?: string[]
  revert?: SessionRevertState | null
}

export interface MessageUpsertInput {
  id: string
  sessionId: string
  role: MessageRole
  status: MessageStatus
  parts?: ClientPart[]
  createdAt?: number
  updatedAt?: number
  isEphemeral?: boolean
  bumpRevision?: boolean
}

export interface PartUpdateInput {
  messageId: string
  part: ClientPart
  bumpRevision?: boolean
}

export interface ReplaceMessageIdOptions {
  oldId: string
  newId: string
}

export interface ScrollCacheKey {
  instanceId: string
  sessionId: string
  scope: string
}
