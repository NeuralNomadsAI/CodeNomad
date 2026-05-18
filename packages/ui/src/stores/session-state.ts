import { batch, createSignal } from "solid-js"

import { getIdleSinceForStatusTransition, type Session, type SessionStatus, type Agent, type Provider } from "../types/session"
import { deleteSession, loadMessages } from "./session-api"
import { showToastNotification } from "../lib/notifications"
import { messageStoreBus } from "./message-v2/bus"
import { instances } from "./instances"
import { showConfirmDialog } from "./alerts"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"
import { getOrCreateWorktreeClient, getWorktreeSlugForSession } from "./worktrees"
import { tGlobal } from "../lib/i18n"
import { computeThreadTotals, type ThreadTotals } from "../lib/thread-totals"

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

// Recursive SessionThread type - supports unlimited nesting depth
export type SessionThread = {
  session: Session                    // The session for this node
  children: SessionThread[]            // Recursive children
  depth: number                       // Nesting depth (0 = top-level parent)
  hasChildren: boolean                 // Whether this session has any descendants
  latestUpdated: number               // Latest update time in this thread
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
const [threadTotalsByInstance, setThreadTotalsByInstance] = createSignal<Map<string, Map<string, ThreadTotals>>>(new Map())

// Track expansion state for ANY session that has children (not just top-level parents)
const [expandedSessions, setExpandedSessions] = createSignal<Map<string, Set<string>>>(new Map())

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

function markSessionIdleSeen(instanceId: string, sessionId: string): void {
  withSession(instanceId, sessionId, (session) => {
    if (session.status !== "idle") return false
    if (typeof session.idleSince !== "number") return false
    session.idleSince = null
  })
}

function markViewedSessionIdleSeen(
  instanceId: string,
  sessionId: string,
  keepUnseenSubagentIdleStatus: boolean,
): void {
  setSessions((prev) => {
    const instanceSessions = prev.get(instanceId)
    if (!instanceSessions) return prev

    const viewedSession = instanceSessions.get(sessionId)
    if (!viewedSession) return prev

    const idsToClear = new Set<string>([sessionId])
    if (viewedSession.parentId === null && !keepUnseenSubagentIdleStatus) {
      for (const session of instanceSessions.values()) {
        if (session.parentId === sessionId) idsToClear.add(session.id)
      }
    }

    let changed = false
    const updatedSessions = new Map(instanceSessions)
    for (const id of idsToClear) {
      const session = updatedSessions.get(id)
      if (!session) continue
      if (session.status !== "idle") continue
      if (typeof session.idleSince !== "number") continue
      updatedSessions.set(id, { ...session, idleSince: null })
      changed = true
    }

    if (!changed) return prev

    const next = new Map(prev)
    next.set(instanceId, updatedSessions)
    return next
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
  let parentToExpand: string | null = null

  withSession(instanceId, sessionId, (session) => {
    if (session.status === status) return false
    const previous = session.status
    session.status = status
    session.idleSince = getIdleSinceForStatusTransition(previous, status, session.idleSince)
    if (status !== "working") {
      session.retry = null
    }

    // If a child session starts working, auto-expand its parent thread once.
    // Users can still collapse it afterwards; we only expand on the transition.
    if (session.parentId && status === "working" && previous !== "working") {
      parentToExpand = session.parentId
    }
  })

  if (parentToExpand) {
    ensureSessionExpanded(instanceId, parentToExpand)
  }
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

  // Recursively collect all descendants for a session
  const collectDescendants = (sessionId: string): Session[] => {
    const children = getChildSessions(instanceId, sessionId)
    const result: Session[] = []
    for (const child of children) {
      result.push(child)
      result.push(...collectDescendants(child.id))
    }
    return result
  }

  return [parent, ...collectDescendants(parentId)]
}

type SessionThreadCacheEntry = {
  signature: string
  thread: SessionThread
}

type SessionThreadCache = {
  bySessionId: Map<string, SessionThreadCacheEntry>
}

const sessionThreadCache = new Map<string, SessionThreadCache>()

function getOrCreateSessionThreadCache(instanceId: string): SessionThreadCache {
  let cache = sessionThreadCache.get(instanceId)
  if (!cache) {
    cache = { bySessionId: new Map() }
    sessionThreadCache.set(instanceId, cache)
  }
  return cache
}

/**
 * Recursively builds a SessionThread tree from a session and its children.
 * Each node contains its session, depth, and recursive children array.
 */
function buildSessionThreadTree(
  session: Session,
  childrenByParent: Map<string, Session[]>,
  depth: number,
): SessionThread {
  const directChildren = childrenByParent.get(session.id) ?? []

  // Sort children by updated time (most recent first)
  if (directChildren.length > 1) {
    directChildren.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
  }

  // Recursively build child threads
  const childThreads: SessionThread[] = []
  for (const child of directChildren) {
    childThreads.push(buildSessionThreadTree(child, childrenByParent, depth + 1))
  }

  // Calculate latestUpdated: max of this session and all descendants
  let latestUpdated = session.time.updated ?? 0
  for (const childThread of childThreads) {
    if (childThread.latestUpdated > latestUpdated) {
      latestUpdated = childThread.latestUpdated
    }
  }

  // hasChildren is true if this session has any descendants
  const hasChildren = childThreads.length > 0 || directChildren.length > 0

  return {
    session,
    children: childThreads,
    depth,
    hasChildren,
    latestUpdated,
  }
}

/**
 * Generates a signature for cache invalidation based on session state.
 * Includes the session's update time and all descendant IDs.
 */
function computeThreadSignature(
  session: Session,
  childrenByParent: Map<string, Session[]>,
  visitedDescendants: Set<string> = new Set(),
): string {
  const parts: string[] = []
  parts.push(String(session.time.updated ?? 0))

  const directChildren = childrenByParent.get(session.id) ?? []
  for (const child of directChildren) {
    if (visitedDescendants.has(child.id)) continue
    visitedDescendants.add(child.id)
    parts.push(child.id)
  }

  // Sort to ensure deterministic signature regardless of iteration order
  parts.sort()
  return parts.join(":")
}

function getSessionThreads(instanceId: string): SessionThread[] {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions || instanceSessions.size === 0) {
    sessionThreadCache.delete(instanceId)
    return []
  }

  const cache = getOrCreateSessionThreadCache(instanceId)
  const seenSessionIds = new Set<string>()

  // Group sessions by parent ID
  const childrenByParent = new Map<string, Session[]>()
  const rootSessions: Session[] = []

  for (const session of instanceSessions.values()) {
    if (session.parentId === null) {
      rootSessions.push(session)
    } else {
      const parentId = session.parentId
      const children = childrenByParent.get(parentId)
      if (children) {
        children.push(session)
      } else {
        childrenByParent.set(parentId, [session])
      }
    }
  }

  // Sort root sessions by updated time (most recent first)
  if (rootSessions.length > 1) {
    rootSessions.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
  }

  const threads: SessionThread[] = []

  for (const rootSession of rootSessions) {
    seenSessionIds.add(rootSession.id)

    const signature = computeThreadSignature(rootSession, childrenByParent)
    const cached = cache.bySessionId.get(rootSession.id)

    if (cached && cached.signature === signature) {
      threads.push(cached.thread)
    } else {
      const thread = buildSessionThreadTree(rootSession, childrenByParent, 0)
      cache.bySessionId.set(rootSession.id, { signature, thread })
      threads.push(thread)
    }
  }

  // Clean up cache entries for sessions that no longer exist
  for (const sessionId of Array.from(cache.bySessionId.keys())) {
    if (!seenSessionIds.has(sessionId)) {
      cache.bySessionId.delete(sessionId)
    }
  }

  // Sort threads by latestUpdated (most recent first), then by session ID
  threads.sort((a, b) => {
    if (b.latestUpdated !== a.latestUpdated) return b.latestUpdated - a.latestUpdated
    const bUpdated = b.session.time.updated ?? 0
    const aUpdated = a.session.time.updated ?? 0
    if (bUpdated !== aUpdated) return bUpdated - aUpdated
    return b.session.id.localeCompare(a.session.id)
  })

  return threads
}

function isSessionExpanded(instanceId: string, sessionId: string): boolean {
  return Boolean(expandedSessions().get(instanceId)?.has(sessionId))
}

function setSessionExpanded(instanceId: string, sessionId: string, expanded: boolean): void {
  setExpandedSessions((prev) => {
    const next = new Map(prev)
    const currentSet = next.get(instanceId) ?? new Set<string>()
    const updated = new Set(currentSet)

    if (expanded) {
      updated.add(sessionId)
    } else {
      updated.delete(sessionId)
    }

    if (updated.size === 0) {
      next.delete(instanceId)
    } else {
      next.set(instanceId, updated)
    }

    return next
  })
}

function toggleSessionExpanded(instanceId: string, sessionId: string): void {
  setExpandedSessions((prev) => {
    const next = new Map(prev)
    const currentSet = next.get(instanceId) ?? new Set<string>()
    const updated = new Set(currentSet)

    if (updated.has(sessionId)) {
      updated.delete(sessionId)
    } else {
      updated.add(sessionId)
    }

    next.set(instanceId, updated)
    return next
  })
}

function ensureSessionExpanded(instanceId: string, sessionId: string): void {
  if (isSessionExpanded(instanceId, sessionId)) return
  setSessionExpanded(instanceId, sessionId, true)
}

/**
 * Recursively collects all visible session IDs based on expansion state.
 * A session is visible if:
 * 1. It has no parent (root session)
 * 2. Its parent chain is fully expanded
 */
function collectVisibleSessionIds(
  threads: SessionThread[],
  expanded: Set<string> | undefined,
  parentPath: string[] = [],
): string[] {
  const ids: string[] = []

  for (const thread of threads) {
    // This session is visible because its root is always visible
    ids.push(thread.session.id)

    // If this session is expanded, recursively collect visible children
    if (expanded?.has(thread.session.id) && thread.children.length > 0) {
      ids.push(...collectVisibleSessionIds(thread.children, expanded, [...parentPath, thread.session.id]))
    }
  }

  return ids
}

function getVisibleSessionIds(instanceId: string): string[] {
  const threads = getSessionThreads(instanceId)
  if (threads.length === 0) return []

  const expanded = expandedSessions().get(instanceId)
  return collectVisibleSessionIds(threads, expanded)
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

function getThreadTotals(instanceId: string, parentSessionId: string): ThreadTotals | undefined {
  return threadTotalsByInstance().get(instanceId)?.get(parentSessionId)
}

function updateThreadTotalsForParent(instanceId: string, parentSessionId: string): void {
  const family = getSessionFamily(instanceId, parentSessionId)
  const totals = computeThreadTotals(family, sessionInfoByInstance().get(instanceId))

  setThreadTotalsByInstance((prev) => {
    const next = new Map(prev)
    const instanceTotals = new Map(next.get(instanceId))
    instanceTotals.set(parentSessionId, totals)
    next.set(instanceId, instanceTotals)
    return next
  })
}

function updateThreadTotalsForSession(instanceId: string, sessionId: string): void {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return
  updateThreadTotalsForParent(instanceId, session.parentId ?? session.id)
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
    const worktreeSlug = getWorktreeSlugForSession(instanceId, session.id)
    const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)
    messages = await requestData<any[]>(
      client.session.messages({ sessionID: session.id }),
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
      tGlobal("sessionState.cleanup.deepConfirm.message"),
      {
        title: tGlobal("sessionState.cleanup.deepConfirm.title"),
        detail: tGlobal("sessionState.cleanup.deepConfirm.detail"),
        confirmLabel: tGlobal("sessionState.cleanup.deepConfirm.confirmLabel"),
        cancelLabel: tGlobal("sessionState.cleanup.deepConfirm.cancelLabel"),
        dismissible: false,
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
        message: deletedCount === 1
          ? tGlobal("sessionState.cleanup.toast.one", { count: deletedCount })
          : tGlobal("sessionState.cleanup.toast.other", { count: deletedCount }),
        variant: "info"
      })
    }
  }
}

// Backward compatibility aliases for renamed exports
const expandedSessionParents = expandedSessions
const isSessionParentExpanded = isSessionExpanded
const setSessionParentExpanded = setSessionExpanded
const toggleSessionParentExpanded = toggleSessionExpanded
const ensureSessionParentExpanded = ensureSessionExpanded

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
  threadTotalsByInstance,
  getThreadTotals,
  updateThreadTotalsForParent,
  updateThreadTotalsForSession,
  getSessionDraftPrompt,
  setSessionDraftPrompt,
  clearSessionDraftPrompt,
  clearInstanceDraftPrompts,
  pruneDraftPrompts,
  withSession,
  setSessionPendingPermission,
  setSessionPendingQuestion,
  markSessionIdleSeen,
  markViewedSessionIdleSeen,
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
  isSessionExpanded,
  setSessionExpanded,
  toggleSessionExpanded,
  ensureSessionExpanded,
  setActiveSessionFromList,
  isSessionBusy,
  isSessionMessagesLoading,
  getSessionInfo,
  isBlankSession,
  cleanupBlankSessions,
  // Backward compatibility aliases
  expandedSessionParents,
  isSessionParentExpanded,
  setSessionParentExpanded,
  toggleSessionParentExpanded,
  ensureSessionParentExpanded,
}
