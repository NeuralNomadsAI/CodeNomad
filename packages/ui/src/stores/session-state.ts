import { createSignal } from "solid-js"

import type { Session, Agent, Provider } from "../types/session"
import { deleteSession, loadMessages } from "./session-api"
import { showToastNotification } from "../lib/notifications"
import { messageStoreBus } from "./message-v2/bus"
import { instances } from "./instances"
import { showConfirmDialog } from "./alerts"

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
    const response = await instance.client.session.messages({ path: { id: session.id } })
    messages = response.data || []
  } catch (error) {
    console.error(`Failed to fetch messages for session ${session.id}:`, error)
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
        console.error(`Failed to delete blank session ${sessionId}:`, error)
      })
      return true
    })

  if (cleanupPromises.length > 0) {
    console.log(`Cleaning up ${cleanupPromises.length} blank sessions`)
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
  isSessionBusy,
  isSessionMessagesLoading,
  getSessionInfo,
  isBlankSession,
  cleanupBlankSessions,
}
