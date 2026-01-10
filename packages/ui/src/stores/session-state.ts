import { batch, createSignal } from "solid-js"

import type { Session, SessionStatus, Agent, Provider } from "../types/session"
import { deleteSession, loadMessages } from "./session-api"
import { showToastNotification } from "../lib/notifications"
import { messageStoreBus } from "./message-v2/bus"
import { instances } from "./instances"
import { showConfirmDialog } from "./alerts"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"

const log = getLogger("session")

export interface SessionInfo {
  cost: number
  contextWindow: number
  isSubscriptionModel: boolean
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  actualUsageTokens: number
  modelOutputLimit: number
  contextAvailableTokens: number | null
}

export type SessionThread = {
  parent: Session
  children: Session[]
  latestUpdated: number
}

const [sessions, setSessions] = createSignal<Map<string, Map<string, Session>>>(new Map())
const [activeSessionId, setActiveSessionId] = createSignal<Map<string, string>>(new Map())
const [activeParentSessionId, setActiveParentSessionId] = createSignal<Map<string, string>>(new Map())
const [agents, setAgents] = createSignal<Map<string, Agent[]>>(new Map())
const [providers, setProviders] = createSignal<Map<string, Provider[]>>(new Map())
const [sessionDraftPrompts, setSessionDraftPrompts] = createSignal<Map<string, string>>(new Map())

const [loading, setLoading] = createSignal({
  fetchingSessions: new Map<string, boolean>(),
  creatingSession: new Map<string, boolean>(),
  deletingSession: new Map<string, Set<string>>(),
  loadingMessages: new Map<string, Set<string>>(),
})

const [messagesLoaded, setMessagesLoaded] = createSignal<Map<string, Set<string>>>(new Map())
const [sessionInfoByInstance, setSessionInfoByInstance] = createSignal<Map<string, Map<string, SessionInfo>>>(new Map())

const [expandedSessionParents, setExpandedSessionParents] = createSignal<Map<string, Set<string>>>(new Map())

export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

type InstanceIndicatorCounts = {
  permission: number
  working: number
  compacting: number
}

const [instanceIndicatorCounts, setInstanceIndicatorCounts] = createSignal<Map<string, InstanceIndicatorCounts>>(new Map())

function getIndicatorBucket(session: Pick<Session, "status" | "pendingPermission" | "pendingQuestion">): InstanceSessionIndicatorStatus | "idle" {
  if (session.pendingPermission || session.pendingQuestion) {
    return "permission"
  }
  const status = session.status ?? "idle"
  return status
}

function adjustIndicatorCounts(
  instanceId: string,
  previous: InstanceSessionIndicatorStatus | "idle",
  next: InstanceSessionIndicatorStatus | "idle",
): void {
  if (previous === next) return

  const decKey = previous === "idle" ? null : previous
  const incKey = next === "idle" ? null : next

  setInstanceIndicatorCounts((prev) => {
    const current = prev.get(instanceId) ?? { permission: 0, working: 0, compacting: 0 }
    const updated: InstanceIndicatorCounts = { ...current }

    if (decKey) {
      updated[decKey] = Math.max(0, updated[decKey] - 1)
    }

    if (incKey) {
      updated[incKey] = updated[incKey] + 1
    }

    const hasAny = updated.permission > 0 || updated.working > 0 || updated.compacting > 0
    if (!hasAny) {
      if (!prev.has(instanceId)) return prev
      const nextMap = new Map(prev)
      nextMap.delete(instanceId)
      return nextMap
    }

    const same =
      current.permission === updated.permission &&
      current.working === updated.working &&
      current.compacting === updated.compacting
    if (same && prev.has(instanceId)) {
      return prev
    }

    const nextMap = new Map(prev)
    nextMap.set(instanceId, updated)
    return nextMap
  })
}

function recomputeIndicatorCounts(instanceId: string, instanceSessions: Map<string, Session> | undefined): void {
  if (!instanceSessions || instanceSessions.size === 0) {
    setInstanceIndicatorCounts((prev) => {
      if (!prev.has(instanceId)) return prev
      const next = new Map(prev)
      next.delete(instanceId)
      return next
    })
    return
  }

  let permission = 0
  let working = 0
  let compacting = 0

  for (const session of instanceSessions.values()) {
    if (session.pendingPermission || session.pendingQuestion) {
      permission += 1
      continue
    }
    const status = session.status ?? "idle"
    if (status === "compacting") {
      compacting += 1
    } else if (status === "working") {
      working += 1
    }
  }

  if (permission === 0 && working === 0 && compacting === 0) {
    setInstanceIndicatorCounts((prev) => {
      if (!prev.has(instanceId)) return prev
      const next = new Map(prev)
      next.delete(instanceId)
      return next
    })
    return
  }

  setInstanceIndicatorCounts((prev) => {
    const current = prev.get(instanceId)
    if (current && current.permission === permission && current.working === working && current.compacting === compacting) {
      return prev
    }
    const next = new Map(prev)
    next.set(instanceId, { permission, working, compacting })
    return next
  })
}

export function getInstanceSessionIndicatorStatusCached(instanceId: string): InstanceSessionIndicatorStatus {
  const counts = instanceIndicatorCounts().get(instanceId)
  if (!counts) return "idle"
  if (counts.permission > 0) return "permission"
  if (counts.compacting > 0) return "compacting"
  if (counts.working > 0) return "working"
  return "idle"
}

export function syncInstanceSessionIndicator(instanceId: string, instanceSessions?: Map<string, Session>): void {
  recomputeIndicatorCounts(instanceId, instanceSessions ?? sessions().get(instanceId))
}

function clearLoadedFlag(instanceId: string, sessionId: string) {
  if (!instanceId || !sessionId) return
  setMessagesLoaded((prev) => {
    const existing = prev.get(instanceId)
    if (!existing || !existing.has(sessionId)) {
      return prev
    }
    const next = new Map(prev)
    const updated = new Set(existing)
    updated.delete(sessionId)
    if (updated.size === 0) {
      next.delete(instanceId)
    } else {
      next.set(instanceId, updated)
    }
    return next
  })
}

messageStoreBus.onSessionCleared((instanceId, sessionId) => {
  clearLoadedFlag(instanceId, sessionId)
})

function getDraftKey(instanceId: string, sessionId: string): string {

  return `${instanceId}:${sessionId}`
}

function getSessionDraftPrompt(instanceId: string, sessionId: string): string {
  if (!instanceId || !sessionId) return ""
  const key = getDraftKey(instanceId, sessionId)
  return sessionDraftPrompts().get(key) ?? ""
}

function setSessionDraftPrompt(instanceId: string, sessionId: string, value: string) {
  const key = getDraftKey(instanceId, sessionId)
  setSessionDraftPrompts((prev) => {
    const next = new Map(prev)
    if (!value) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    return next
  })
}

function clearSessionDraftPrompt(instanceId: string, sessionId: string) {
  const key = getDraftKey(instanceId, sessionId)
  setSessionDraftPrompts((prev) => {
    if (!prev.has(key)) return prev
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

function clearInstanceDraftPrompts(instanceId: string) {
  if (!instanceId) return
  setSessionDraftPrompts((prev) => {
    let changed = false
    const next = new Map(prev)
    const prefix = `${instanceId}:`
    for (const key of Array.from(next.keys())) {
      if (key.startsWith(prefix)) {
        next.delete(key)
        changed = true
      }
    }
    return changed ? next : prev
  })
}

function pruneDraftPrompts(instanceId: string, validSessionIds: Set<string>) {
  setSessionDraftPrompts((prev) => {
    let changed = false
    const next = new Map(prev)
    const prefix = `${instanceId}:`
    for (const key of Array.from(next.keys())) {
      if (key.startsWith(prefix)) {
        const sessionId = key.slice(prefix.length)
        if (!validSessionIds.has(sessionId)) {
          next.delete(key)
          changed = true
        }
      }
    }
    return changed ? next : prev
  })
}

function withSession(instanceId: string, sessionId: string, updater: (session: Session) => void | boolean) {
  let previousBucket: InstanceSessionIndicatorStatus | "idle" | null = null
  let nextBucket: InstanceSessionIndicatorStatus | "idle" | null = null
  let didUpdate = false

  setSessions((prev) => {
    const instanceSessions = prev.get(instanceId)
    if (!instanceSessions) return prev

    const current = instanceSessions.get(sessionId)
    if (!current) return prev

    previousBucket = getIndicatorBucket(current)

    const updatedSession: Session = { ...current }
    const result = updater(updatedSession)
    if (result === false) {
      return prev
    }

    nextBucket = getIndicatorBucket(updatedSession)

    instanceSessions.set(sessionId, updatedSession)
    didUpdate = true

    const next = new Map(prev)
    next.set(instanceId, instanceSessions)
    return next
  })

  if (didUpdate && previousBucket && nextBucket) {
    adjustIndicatorCounts(instanceId, previousBucket, nextBucket)
  }
}

function setSessionPendingPermission(instanceId: string, sessionId: string, pending: boolean): void {
  withSession(instanceId, sessionId, (session) => {
    if (session.pendingPermission === pending) return false
    session.pendingPermission = pending
  })
}

function setSessionPendingQuestion(instanceId: string, sessionId: string, pending: boolean): void {
  withSession(instanceId, sessionId, (session) => {
    if (session.pendingQuestion === pending) return false
    session.pendingQuestion = pending
  })
}

function setActiveSession(instanceId: string, sessionId: string): void {
  setActiveSessionId((prev) => {
    const next = new Map(prev)
    next.set(instanceId, sessionId)
    return next
  })
}

function setActiveParentSession(instanceId: string, parentSessionId: string): void {
  setActiveParentSessionId((prev) => {
    const next = new Map(prev)
    next.set(instanceId, parentSessionId)
    return next
  })

  setActiveSession(instanceId, parentSessionId)
}

function clearActiveParentSession(instanceId: string): void {
  setActiveParentSessionId((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })

  setActiveSessionId((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}

function setSessionStatus(instanceId: string, sessionId: string, status: SessionStatus): void {
  withSession(instanceId, sessionId, (session) => {
    if (session.status === status) return false
    session.status = status
  })
}

function getActiveParentSession(instanceId: string): Session | null {
  const parentId = activeParentSessionId().get(instanceId)
  if (!parentId) return null

  const instanceSessions = sessions().get(instanceId)
  return instanceSessions?.get(parentId) || null
}

function getActiveSession(instanceId: string): Session | null {
  const sessionId = activeSessionId().get(instanceId)
  if (!sessionId) return null

  const instanceSessions = sessions().get(instanceId)
  return instanceSessions?.get(sessionId) || null
}

function getSessions(instanceId: string): Session[] {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions ? Array.from(instanceSessions.values()) : []
}

function getParentSessions(instanceId: string): Session[] {
  const allSessions = getSessions(instanceId)
  return allSessions.filter((s) => s.parentId === null)
}

function getChildSessions(instanceId: string, parentId: string): Session[] {
  const allSessions = getSessions(instanceId)
  return allSessions.filter((s) => s.parentId === parentId)
}

function getSessionFamily(instanceId: string, parentId: string): Session[] {
  const parent = sessions().get(instanceId)?.get(parentId)
  if (!parent) return []

  const children = getChildSessions(instanceId, parentId)
  return [parent, ...children]
}

function getSessionThreads(instanceId: string): SessionThread[] {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions || instanceSessions.size === 0) return []

  const parents: Session[] = []
  const childrenByParent = new Map<string, Session[]>()

  for (const session of instanceSessions.values()) {
    if (session.parentId === null) {
      parents.push(session)
      continue
    }

    const parentId = session.parentId
    if (!parentId) continue
    const children = childrenByParent.get(parentId)
    if (children) {
      children.push(session)
    } else {
      childrenByParent.set(parentId, [session])
    }
  }

  const threads: SessionThread[] = []

  for (const parent of parents) {
    const children = childrenByParent.get(parent.id) ?? []
    if (children.length > 1) {
      children.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
    }

    const parentUpdated = parent.time.updated ?? 0
    const latestChild = children[0]?.time.updated ?? 0
    const latestUpdated = Math.max(parentUpdated, latestChild)

    threads.push({ parent, children, latestUpdated })
  }

  threads.sort((a, b) => {
    if (b.latestUpdated !== a.latestUpdated) return b.latestUpdated - a.latestUpdated
    const bParentUpdated = b.parent.time.updated ?? 0
    const aParentUpdated = a.parent.time.updated ?? 0
    if (bParentUpdated !== aParentUpdated) return bParentUpdated - aParentUpdated
    return b.parent.id.localeCompare(a.parent.id)
  })

  return threads
}

function isSessionParentExpanded(instanceId: string, parentSessionId: string): boolean {
  return Boolean(expandedSessionParents().get(instanceId)?.has(parentSessionId))
}

function setSessionParentExpanded(instanceId: string, parentSessionId: string, expanded: boolean): void {
  setExpandedSessionParents((prev) => {
    const next = new Map(prev)
    const currentSet = next.get(instanceId) ?? new Set<string>()
    const updated = new Set(currentSet)

    if (expanded) {
      updated.add(parentSessionId)
    } else {
      updated.delete(parentSessionId)
    }

    if (updated.size === 0) {
      next.delete(instanceId)
    } else {
      next.set(instanceId, updated)
    }

    return next
  })
}

function toggleSessionParentExpanded(instanceId: string, parentSessionId: string): void {
  setExpandedSessionParents((prev) => {
    const next = new Map(prev)
    const currentSet = next.get(instanceId) ?? new Set<string>()
    const updated = new Set(currentSet)

    if (updated.has(parentSessionId)) {
      updated.delete(parentSessionId)
    } else {
      updated.add(parentSessionId)
    }

    next.set(instanceId, updated)
    return next
  })
}

function ensureSessionParentExpanded(instanceId: string, parentSessionId: string): void {
  if (isSessionParentExpanded(instanceId, parentSessionId)) return
  setSessionParentExpanded(instanceId, parentSessionId, true)
}

function getVisibleSessionIds(instanceId: string): string[] {
  const threads = getSessionThreads(instanceId)
  if (threads.length === 0) return []

  const expanded = expandedSessionParents().get(instanceId)
  const ids: string[] = []

  for (const thread of threads) {
    ids.push(thread.parent.id)
    if (expanded?.has(thread.parent.id)) {
      for (const child of thread.children) {
        ids.push(child.id)
      }
    }
  }

  return ids
}

function setActiveSessionFromList(instanceId: string, sessionId: string): void {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return

  if (session.parentId === null) {
    setActiveParentSession(instanceId, sessionId)
    return
  }

  const parentId = session.parentId
  if (!parentId) return

  batch(() => {
    setActiveParentSession(instanceId, parentId)
    setActiveSession(instanceId, sessionId)
  })
}

function isSessionBusy(instanceId: string, sessionId: string): boolean {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return false
  if (!instanceSessions.has(sessionId)) return false
  return true
}

function isSessionMessagesLoading(instanceId: string, sessionId: string): boolean {
  return Boolean(loading().loadingMessages.get(instanceId)?.has(sessionId))
}

function getSessionInfo(instanceId: string, sessionId: string): SessionInfo | undefined {
  return sessionInfoByInstance().get(instanceId)?.get(sessionId)
}

async function isBlankSession(session: Session, instanceId: string, fetchIfNeeded = false): Promise<boolean> {
  const created = session.time?.created || 0
  const updated = session.time?.updated || 0
  const hasChildren = getChildSessions(instanceId, session.id).length > 0
  const isFreshSession = created === updated && !hasChildren

  // Common short-circuit: fresh sessions without children
  if (!fetchIfNeeded) {
    return isFreshSession
  }

  // For a more thorough deep clean, we need to look at actual messages
  
  const instance = instances().get(instanceId)
  if (!instance?.client) {
    return isFreshSession
  }
  let messages: any[] = []
  try {
    messages = await requestData<any[]>(
      instance.client.session.messages({ sessionID: session.id }),
      "session.messages",
    )
  } catch (error) {
    log.error(`Failed to fetch messages for session ${session.id}`, error)
    return isFreshSession
  }

  // Specific logic by session type
  if (session.parentId === null) {
    // Parent: blank if no messages and no children (fresh !== blank sometimes!)
    const hasChildren = getChildSessions(instanceId, session.id).length > 0
    return messages.length === 0 && !hasChildren
  } else if (session.title?.includes("subagent)")) {
    // Subagent: "blank" (really: finished doing its job) if actually blank...
    // ... OR no streaming, no pending perms, no tool parts
    if (messages.length === 0) return true
    
    const hasStreaming = messages.some((msg) => {
      const info = msg.info.status || msg.status
      return info === "streaming" || info === "sending"
    })
    
    const lastMessage = messages[messages.length - 1]
    const lastParts = lastMessage?.parts || []
    const hasToolPart = lastParts.some((part: any) => 
      part.type === "tool" || part.data?.type === "tool"
    )
    
    return !hasStreaming && !session.pendingPermission && !hasToolPart
  } else {
    // Fork: blank if somehow has no messages or at revert point
    if (messages.length === 0) return true
  
    const lastMessage = messages[messages.length - 1]
    const lastInfo = lastMessage?.info || lastMessage
    return lastInfo?.id === session.revert?.messageID
  }
}


async function cleanupBlankSessions(instanceId: string, excludeSessionId?: string, fetchIfNeeded = false): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  if (fetchIfNeeded) {
    const confirmed = await showConfirmDialog(
      "This cleanup may be slow, and may delete sessions you didn't intend to delete. Are you sure?",
      {
        title: "Deep Clean Sessions",
        detail: "Deep Clean Sessions will delete all sessions that have no messages, remove any finished sub-agent sessions, and clear out any unused forks of a session.",
        confirmLabel: "Continue",
        cancelLabel: "Cancel"
      }
    )
    if (!confirmed) return
  }

  const cleanupPromises = Array.from(instanceSessions)
    .filter(([sessionId]) => sessionId !== excludeSessionId)
    .map(async ([sessionId, session]) => {
      const isBlank = await isBlankSession(session, instanceId, fetchIfNeeded)
      if (!isBlank) return false

      await deleteSession(instanceId, sessionId).catch((error: Error) => {
        log.error(`Failed to delete blank session ${sessionId}`, error)
      })
      return true
    })

  if (cleanupPromises.length > 0) {
    log.info(`Cleaning up ${cleanupPromises.length} blank sessions`)
    const deletionResults = await Promise.all(cleanupPromises)
    const deletedCount = deletionResults.filter(Boolean).length

    if (deletedCount > 0) {
      showToastNotification({
        message: `Cleaned up ${deletedCount} blank session${deletedCount === 1 ? "" : "s"}`,
        variant: "info"
      })
    }
  }
}

export {
  sessions,
  setSessions,
  activeSessionId,
  setActiveSessionId,
  activeParentSessionId,
  setActiveParentSessionId,
  agents,
  setAgents,
  providers,
  setProviders,
  loading,
  setLoading,
  messagesLoaded,
  setMessagesLoaded,
  sessionInfoByInstance,
  setSessionInfoByInstance,
  getSessionDraftPrompt,
  setSessionDraftPrompt,
  clearSessionDraftPrompt,
  clearInstanceDraftPrompts,
  pruneDraftPrompts,
  withSession,
  setSessionPendingPermission,
  setSessionPendingQuestion,
  setSessionStatus,
  setActiveSession,
 
  setActiveParentSession,

  clearActiveParentSession,
  getActiveSession,
  getActiveParentSession,
  getSessions,
  getParentSessions,
  getChildSessions,
  getSessionFamily,
  getSessionThreads,
  getVisibleSessionIds,
  isSessionParentExpanded,
  setSessionParentExpanded,
  toggleSessionParentExpanded,
  ensureSessionParentExpanded,
  setActiveSessionFromList,
  isSessionBusy,
  isSessionMessagesLoading,
  getSessionInfo,
  isBlankSession,
  cleanupBlankSessions,
}
