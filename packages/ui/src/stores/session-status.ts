import type { Session, SessionStatus } from "../types/session"
import type { MessageInfo } from "../types/message"
import type { MessageRecord } from "./message-v2/types"
import { sessions } from "./sessions"
import { isSessionCompactionActive } from "./session-compaction"
import { messageStoreBus } from "./message-v2/bus"
import { hasUnreadCompletion } from "./session-state"

function getSession(instanceId: string, sessionId: string): Session | null {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions?.get(sessionId) ?? null
}

function isSessionCompacting(session: Session): boolean {
  const time = (session.time as (Session["time"] & { compacting?: number }) | undefined)
  const compactingFlag = time?.compacting
  if (typeof compactingFlag === "number") {
    return compactingFlag > 0
  }
  return Boolean(compactingFlag)
}

function getLatestInfoFromStore(instanceId: string, sessionId: string, role?: MessageInfo["role"]): MessageInfo | undefined {
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageIds = store.getSessionMessageIds(sessionId)
  let latest: MessageInfo | undefined
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const id of messageIds) {
    const info = store.getMessageInfo(id)
    if (!info) continue
    if (role && info.role !== role) continue
    const timestamp = info.time?.created ?? 0
    if (timestamp >= latestTimestamp) {
      latest = info
      latestTimestamp = timestamp
    }
  }
  return latest
}

function getLastMessageFromStore(instanceId: string, sessionId: string): MessageRecord | undefined {
  const store = messageStoreBus.getOrCreate(instanceId)
  const messageIds = store.getSessionMessageIds(sessionId)
  let latest: MessageRecord | undefined
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const id of messageIds) {
    const record = store.getMessage(id)
    if (!record) continue
    const info = store.getMessageInfo(id)
    const timestamp = info?.time?.created ?? record.createdAt ?? Number.NEGATIVE_INFINITY
    if (timestamp >= latestTimestamp) {
      latest = record
      latestTimestamp = timestamp
    }
  }
  return latest
}


function getInfoCreatedTimestamp(info?: MessageInfo): number {
  if (!info) {
    return Number.NEGATIVE_INFINITY
  }
  const created = info.time?.created
  if (typeof created === "number" && Number.isFinite(created)) {
    return created
  }
  return Number.NEGATIVE_INFINITY
}

function getAssistantCompletionTimestamp(info?: MessageInfo): number {
  if (!info) {
    return Number.NEGATIVE_INFINITY
  }
  const completed = (info.time as { completed?: number } | undefined)?.completed
  if (typeof completed === "number" && Number.isFinite(completed)) {
    return completed
  }
  return Number.NEGATIVE_INFINITY
}

function isAssistantInfoPending(info?: MessageInfo): boolean {
  if (!info) {
    return false
  }
  const completed = (info.time as { completed?: number } | undefined)?.completed
  if (completed === undefined || completed === null) {
    return true
  }
  const created = getInfoCreatedTimestamp(info)
  return completed < created
}

function isAssistantStillGeneratingRecord(record: MessageRecord, info?: MessageInfo): boolean {
  if (record.role !== "assistant") {
    return false
  }

  if (record.status === "error") {
    return false
  }

  if (record.status === "streaming" || record.status === "sending") {
    return true
  }

  const completedAt = (info?.time as { completed?: number } | undefined)?.completed
  if (completedAt !== undefined && completedAt !== null) {
    return false
  }

  return !(record.status === "complete" || record.status === "sent")
}


export function getSessionStatus(instanceId: string, sessionId: string): SessionStatus {
  const session = getSession(instanceId, sessionId)
  if (!session) {
    return "idle"
  }

  const store = messageStoreBus.getOrCreate(instanceId)

  if (isSessionCompactionActive(instanceId, sessionId) || isSessionCompacting(session)) {
    return "compacting"
  }

  const latestUserInfo = getLatestInfoFromStore(instanceId, sessionId, "user")
  const latestAssistantInfo = getLatestInfoFromStore(instanceId, sessionId, "assistant")

  const lastRecord = getLastMessageFromStore(instanceId, sessionId)

  if (!lastRecord) {
    const latestInfo = latestUserInfo ?? latestAssistantInfo
    if (!latestInfo) {
      return "idle"
    }
    if (latestInfo.role === "user") {
      return "working"
    }
    const infoCompleted = latestInfo.time?.completed
    return infoCompleted ? "idle" : "working"
  }

  if (lastRecord.role === "user") {
    return "working"
  }
  const infoForRecord = store.getMessageInfo(lastRecord.id) ?? latestAssistantInfo
  if (infoForRecord && isAssistantStillGeneratingRecord(lastRecord, infoForRecord)) {
    return "working"
  }

  if (isAssistantInfoPending(latestAssistantInfo)) {
    return "working"
  }

  const userTimestamp = getInfoCreatedTimestamp(latestUserInfo)
  const assistantCompletedAt = getAssistantCompletionTimestamp(latestAssistantInfo)
  if (userTimestamp > assistantCompletedAt) {
    return "working"
  }

  return "idle"
}

export function isSessionBusy(instanceId: string, sessionId: string): boolean {
  const status = getSessionStatus(instanceId, sessionId)
  return status === "working" || status === "compacting"
}

export type InstanceAggregateStatus = "idle" | "working" | "error" | "completed"

/**
 * Get aggregate status for an instance based on all its sessions
 * Priority: error > working > idle
 */
export function getInstanceAggregateStatus(instanceId: string): InstanceAggregateStatus {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions || instanceSessions.size === 0) {
    return "idle"
  }

  let hasWorking = false
  let hasError = false
  let hasCompleted = false

  for (const [sessionId, session] of instanceSessions.entries()) {
    // Check for pending permission (treated as error/attention needed)
    if (session.pendingPermission) {
      hasError = true
      break // Error has highest priority
    }

    const status = getSessionStatus(instanceId, sessionId)
    if (status === "working" || status === "compacting") {
      hasWorking = true
    }

    // Check for unread completions (only parent sessions)
    if (session.parentId === null && hasUnreadCompletion(instanceId, sessionId)) {
      hasCompleted = true
    }
  }

  if (hasError) return "error"
  if (hasWorking) return "working"
  if (hasCompleted) return "completed"
  return "idle"
}
