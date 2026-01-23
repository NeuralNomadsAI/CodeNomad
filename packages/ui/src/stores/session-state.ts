import { createSignal } from "solid-js"

import type { Session, Agent, Provider, SessionStatus } from "../types/session"
import { deleteSession, loadMessages } from "./session-api"
import { showToastNotification } from "../lib/notifications"
import { messageStoreBus } from "./message-v2/bus"
import { instances } from "./instances"
import { showConfirmDialog } from "./alerts"
import { getLogger } from "../lib/logger"

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

// Thread groups a parent session with its children, sorted by most recent activity
export type SessionThread = {
  parent: Session
  children: Session[]
  latestUpdated: number // Max of parent/children update times
}

const [sessions, setSessions] = createSignal<Map<string, Map<string, Session>>>(new Map())
const [activeSessionId, setActiveSessionId] = createSignal<Map<string, string>>(new Map())
const [activeParentSessionId, setActiveParentSessionId] = createSignal<Map<string, string>>(new Map())
const [agents, setAgents] = createSignal<Map<string, Agent[]>>(new Map())
const [providers, setProviders] = createSignal<Map<string, Provider[]>>(new Map())
const [sessionDraftPrompts, setSessionDraftPrompts] = createSignal<Map<string, string>>(new Map())

// Archiving state for subagents
// Key: `${instanceId}:${sessionId}`, Value: { completedAt, parentMessageCountAtComplete, archived }
interface SubagentArchiveState {
  completedAt: number
  parentMessageCountAtComplete: number
  archived: boolean
}
const [subagentArchiveState, setSubagentArchiveState] = createSignal<Map<string, SubagentArchiveState>>(new Map())
const ARCHIVE_AFTER_MESSAGES = 2

const [loading, setLoading] = createSignal({
  fetchingSessions: new Map<string, boolean>(),
  creatingSession: new Map<string, boolean>(),
  deletingSession: new Map<string, Set<string>>(),
  loadingMessages: new Map<string, Set<string>>(),
})

const [messagesLoaded, setMessagesLoaded] = createSignal<Map<string, Set<string>>>(new Map())
const [sessionInfoByInstance, setSessionInfoByInstance] = createSignal<Map<string, Map<string, SessionInfo>>>(new Map())

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

function withSession(instanceId: string, sessionId: string, updater: (session: Session) => void) {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  const session = instanceSessions.get(sessionId)
  if (!session) return

  updater(session)

  const updatedSession = {
    ...session,
  }

  setSessions((prev) => {
    const next = new Map(prev)
    const newInstanceSessions = new Map(instanceSessions)
    newInstanceSessions.set(sessionId, updatedSession)
    next.set(instanceId, newInstanceSessions)
    return next
  })
}

function setSessionCompactionState(instanceId: string, sessionId: string, isCompacting: boolean): void {
  withSession(instanceId, sessionId, (session) => {
    const time = { ...(session.time ?? {}) }
    time.compacting = isCompacting ? Date.now() : 0
    session.time = time
  })
}

function setSessionStatus(instanceId: string, sessionId: string, status: SessionStatus): void {
  withSession(instanceId, sessionId, (session) => {
    if (session.status === status) return
    session.status = status
  })
}

function setSessionPendingPermission(instanceId: string, sessionId: string, pending: boolean): void {
  withSession(instanceId, sessionId, (session) => {
    if (session.pendingPermission === pending) return
    session.pendingPermission = pending
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

// Build sorted list of session threads (parent + children grouped together)
function getSessionThreads(instanceId: string): SessionThread[] {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions || instanceSessions.size === 0) return []

  const parents: Session[] = []
  const childrenByParent = new Map<string, Session[]>()

  for (const session of instanceSessions.values()) {
    if (session.parentId === null) {
      parents.push(session)
    } else if (session.parentId) {
      const children = childrenByParent.get(session.parentId) || []
      children.push(session)
      childrenByParent.set(session.parentId, children)
    }
  }

  const threads: SessionThread[] = parents.map((parent) => {
    const children = childrenByParent.get(parent.id) ?? []
    // Sort children by most recently updated first
    children.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))

    const parentUpdated = parent.time.updated ?? 0
    const latestChild = children[0]?.time.updated ?? 0

    return {
      parent,
      children,
      latestUpdated: Math.max(parentUpdated, latestChild),
    }
  })

  // Sort threads by most recently updated first
  threads.sort((a, b) => b.latestUpdated - a.latestUpdated)
  return threads
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

// Archive helper functions
function getArchiveKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function isSubagentArchived(instanceId: string, sessionId: string): boolean {
  const key = getArchiveKey(instanceId, sessionId)
  return subagentArchiveState().get(key)?.archived ?? false
}

function markSubagentComplete(instanceId: string, sessionId: string, parentMessageCount: number): void {
  const key = getArchiveKey(instanceId, sessionId)
  const existing = subagentArchiveState().get(key)

  // Don't overwrite if already marked complete
  if (existing?.completedAt) return

  setSubagentArchiveState((prev) => {
    const next = new Map(prev)
    next.set(key, {
      completedAt: Date.now(),
      parentMessageCountAtComplete: parentMessageCount,
      archived: false,
    })
    return next
  })
}

function checkAndArchiveSubagents(instanceId: string, currentParentMessageCount: number): void {
  setSubagentArchiveState((prev) => {
    let changed = false
    const next = new Map(prev)

    for (const [key, state] of prev.entries()) {
      if (!key.startsWith(`${instanceId}:`)) continue
      if (state.archived) continue
      if (!state.completedAt) continue

      const messagesSinceComplete = currentParentMessageCount - state.parentMessageCountAtComplete
      if (messagesSinceComplete >= ARCHIVE_AFTER_MESSAGES) {
        next.set(key, { ...state, archived: true })
        changed = true
      }
    }

    return changed ? next : prev
  })
}

function toggleSubagentArchive(instanceId: string, sessionId: string): void {
  const key = getArchiveKey(instanceId, sessionId)
  setSubagentArchiveState((prev) => {
    const existing = prev.get(key)
    if (!existing) return prev

    const next = new Map(prev)
    next.set(key, { ...existing, archived: !existing.archived })
    return next
  })
}

function getArchivedSubagents(instanceId: string): string[] {
  const result: string[] = []
  const prefix = `${instanceId}:`

  for (const [key, state] of subagentArchiveState().entries()) {
    if (key.startsWith(prefix) && state.archived) {
      result.push(key.slice(prefix.length))
    }
  }

  return result
}

function getActiveSubagents(instanceId: string): Session[] {
  const allSessions = getSessions(instanceId)
  const archived = new Set(getArchivedSubagents(instanceId))

  return allSessions.filter((s) => s.parentId !== null && !archived.has(s.id))
}

function getArchivedSubagentSessions(instanceId: string): Session[] {
  const allSessions = getSessions(instanceId)
  const archived = new Set(getArchivedSubagents(instanceId))

  return allSessions.filter((s) => s.parentId !== null && archived.has(s.id))
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
    const response = await instance.client.session.messages({ path: { id: session.id } })
    messages = response.data || []
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
  setSessionCompactionState,
  setSessionStatus,
  setSessionPendingPermission,
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
  isSessionBusy,
  isSessionMessagesLoading,
  getSessionInfo,
  isBlankSession,
  cleanupBlankSessions,
  // Archive exports
  isSubagentArchived,
  markSubagentComplete,
  checkAndArchiveSubagents,
  toggleSubagentArchive,
  getArchivedSubagents,
  getActiveSubagents,
  getArchivedSubagentSessions,
  ARCHIVE_AFTER_MESSAGES,
}
