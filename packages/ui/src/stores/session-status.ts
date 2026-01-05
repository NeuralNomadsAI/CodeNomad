import type { Session, SessionStatus } from "../types/session"
import type { MessageInfo } from "../types/message"
import type { MessageRecord } from "./message-v2/types"
import { sessions } from "./sessions"
import { isSessionCompactionActive } from "./session-compaction"
import { messageStoreBus } from "./message-v2/bus"

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


export function deriveSessionStatusFromMessages(instanceId: string, sessionId: string): SessionStatus {
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

export function getSessionStatus(instanceId: string, sessionId: string): SessionStatus {
  const session = getSession(instanceId, sessionId)
  if (!session) {
    return "idle"
  }
  return session.status ?? deriveSessionStatusFromMessages(instanceId, sessionId)
}

export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

export function getInstanceSessionIndicatorStatus(instanceId: string): InstanceSessionIndicatorStatus {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions || instanceSessions.size === 0) {
    return "idle"
  }

  let bestRank = 0
  let best: InstanceSessionIndicatorStatus = "idle"

  for (const session of instanceSessions.values()) {
    let rank = 0
    let status: InstanceSessionIndicatorStatus = "idle"

    if (session.pendingPermission) {
      status = "permission"
      rank = 3
    } else {
      const sessionStatus = getSessionStatus(instanceId, session.id)
      if (sessionStatus === "compacting") {
        status = "compacting"
        rank = 2
      } else if (sessionStatus === "working") {
        status = "working"
        rank = 1
      }
    }

    if (rank > bestRank) {
      bestRank = rank
      best = status
      if (bestRank === 3) {
        break
      }
    }
  }

  return best
}

export function isSessionBusy(instanceId: string, sessionId: string): boolean {
  const status = getSessionStatus(instanceId, sessionId)
  return status === "working" || status === "compacting"
}
