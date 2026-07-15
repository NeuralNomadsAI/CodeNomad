import { batch, createSignal } from "solid-js"

import { getIdleSinceForStatusTransition, type Session, type SessionStatus, type Agent, type Provider } from "../types/session"
import { deleteSession, loadMessages } from "./session-api"
import { showToastNotification } from "../lib/notifications"
import { messageStoreBus } from "./message-v2/bus"
import { instances, ensureYoloStateSynced } from "./instances"
import { showConfirmDialog } from "./alerts"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"
import { getRootClient } from "./opencode-client"
import { getOpenCodeWorkspaceIdForSession } from "./opencode-workspaces"
import { tGlobal } from "../lib/i18n"
import { computeThreadTotals, type ThreadTotals } from "../lib/thread-totals"
import { applySessionPage, getDefaultSessionPaginationState, type SessionPaginationState } from "./session-pagination-model"
import {
  resolveAuthoritativeGenerationRecovery,
  resolveHydratedGenerationRecovery,
  type PersistedGenerationRecovery,
} from "./session-generation-recovery"
import {
  buildSessionThreadsFromMap,
  collectVisibleSessionIds,
  getDescendantSessionsFromMap,
  getSessionAncestorIdsFromMap,
  getSessionRootFromMap,
  type SessionThread,
} from "./session-tree"

export type { SessionThread } from "./session-tree"

const log = getLogger("session")
let generationAdmissionSequence = 0
type GenerationAdmissionBaseline = Pick<Session, "generationRecovery" | "runtimeStatusKnown" | "idleSince">
interface GenerationAdmissionGroup {
  id: number
  tokens: Set<number>
  accepted: boolean
  baseline: GenerationAdmissionBaseline
}
const generationAdmissionGroups = new Map<string, GenerationAdmissionGroup>()

function generationAdmissionKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function cancelSessionGenerationAdmissions(instanceId: string, sessionId: string): void {
  generationAdmissionGroups.delete(generationAdmissionKey(instanceId, sessionId))
}

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
const [authoritativeDraftKeys, setAuthoritativeDraftKeys] = createSignal<Set<string>>(new Set())
const [authoritativeSessionSelectionInstanceIds, setAuthoritativeSessionSelectionInstanceIds] = createSignal<Set<string>>(new Set())
const [authoritativelyDeletedSessionKeys, setAuthoritativelyDeletedSessionKeys] = createSignal<Set<string>>(new Set())
type SessionDraftHydratedListener = (instanceId: string, sessionId: string, draft: string) => void
const sessionDraftHydratedListeners = new Set<SessionDraftHydratedListener>()

const [loading, setLoading] = createSignal({
  fetchingSessions: new Map<string, boolean>(),
  creatingSession: new Map<string, boolean>(),
  deletingSession: new Map<string, Set<string>>(),
  loadingMessages: new Map<string, Set<string>>(),
})

const [messagesLoaded, setMessagesLoaded] = createSignal<Map<string, Set<string>>>(new Map())
const [messageLoadErrors, setMessageLoadErrors] = createSignal<Map<string, Map<string, string>>>(new Map())
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

const SESSION_PAGE_SIZE = 200

type SessionSearchState = {
  query: string
  ids: string[]
  loading: boolean
  requestId: number
}

const [sessionPagination, setSessionPagination] = createSignal<Map<string, SessionPaginationState>>(new Map())
const [sessionSearch, setSessionSearch] = createSignal<Map<string, SessionSearchState>>(new Map())

function getSessionPaginationState(instanceId: string): SessionPaginationState {
  return sessionPagination().get(instanceId) ?? getDefaultSessionPaginationState()
}

function getSessionListIds(instanceId: string): string[] {
  return getSessionPaginationState(instanceId).ids
}

function getSessionNextCursor(instanceId: string): string | undefined {
  return getSessionPaginationState(instanceId).nextCursor
}

function setSessionPage(instanceId: string, ids: string[], hasMore: boolean, reset = false, nextCursor?: string): void {
  setSessionPagination((prev) => {
    const next = new Map(prev)
    next.set(instanceId, applySessionPage(prev.get(instanceId), ids, hasMore, reset, nextCursor))
    return next
  })
}

function getSessionHasMore(instanceId: string): boolean {
  return getSessionPaginationState(instanceId).hasMore
}

function resetSessionPagination(instanceId: string): void {
  setSessionPagination((prev) => {
    const next = new Map(prev)
    next.set(instanceId, getDefaultSessionPaginationState())
    return next
  })
}

function prependSessionListId(instanceId: string, sessionId: string): void {
  setSessionPagination((prev) => {
    const next = new Map(prev)
    const current = prev.get(instanceId) ?? { ids: [], hasMore: true }
    const ids = [sessionId, ...current.ids.filter((id) => id !== sessionId)]
    next.set(instanceId, { ...current, ids })
    return next
  })
}

function removeSessionListId(instanceId: string, sessionId: string): void {
  setSessionPagination((prev) => {
    const next = new Map(prev)
    const current = prev.get(instanceId) ?? { ids: [], hasMore: true }
    const ids = current.ids.filter((id) => id !== sessionId)
    next.set(instanceId, { ...current, ids })
    return next
  })
}

function beginSessionSearch(instanceId: string, query: string): number {
  const current = sessionSearch().get(instanceId)
  const requestId = (current?.requestId ?? 0) + 1
  setSessionSearch((prev) => {
    const next = new Map(prev)
    next.set(instanceId, { query, ids: current?.ids ?? [], loading: true, requestId })
    return next
  })
  return requestId
}

function isLatestSessionSearch(instanceId: string, query: string, requestId: number): boolean {
  const current = sessionSearch().get(instanceId)
  return Boolean(current && current.query === query && current.requestId === requestId)
}

function setSessionSearchResults(instanceId: string, query: string, ids: string[], requestId: number): boolean {
  if (!isLatestSessionSearch(instanceId, query, requestId)) return false
  setSessionSearch((prev) => {
    const next = new Map(prev)
    next.set(instanceId, { query, ids, loading: false, requestId })
    return next
  })
  return true
}

function clearSessionSearch(instanceId: string): void {
  setSessionSearch((prev) => {
    const current = prev.get(instanceId)
    const requestId = (current?.requestId ?? 0) + 1
    const next = new Map(prev)
    next.set(instanceId, { query: "", ids: [], loading: false, requestId })
    return next
  })
}

function getSessionSearchResultIds(instanceId: string): string[] {
  return sessionSearch().get(instanceId)?.ids ?? []
}

function getSessionSearchQuery(instanceId: string): string {
  return sessionSearch().get(instanceId)?.query ?? ""
}

function isSessionSearchLoading(instanceId: string): boolean {
  return sessionSearch().get(instanceId)?.loading ?? false
}

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

function writeSessionDraftPrompt(instanceId: string, sessionId: string, value: string) {
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

function markSessionDraftAuthoritative(instanceId: string, sessionId: string) {
  const key = getDraftKey(instanceId, sessionId)
  setAuthoritativeDraftKeys((prev) => {
    if (prev.has(key)) return prev
    const next = new Set(prev)
    next.add(key)
    return next
  })
}

function setSessionDraftPrompt(instanceId: string, sessionId: string, value: string) {
  markSessionDraftAuthoritative(instanceId, sessionId)
  writeSessionDraftPrompt(instanceId, sessionId, value)
}

function hydrateSessionDraftPrompt(instanceId: string, sessionId: string, value: string): void {
  writeSessionDraftPrompt(instanceId, sessionId, value)
  for (const listener of sessionDraftHydratedListeners) listener(instanceId, sessionId, value)
}

function onSessionDraftHydrated(listener: SessionDraftHydratedListener): () => void {
  sessionDraftHydratedListeners.add(listener)
  return () => sessionDraftHydratedListeners.delete(listener)
}

function getSessionDraftPromptsForInstance(instanceId: string): Record<string, string> {
  if (!instanceId) return {}
  const prefix = `${instanceId}:`
  const result: Record<string, string> = {}
  for (const [key, value] of sessionDraftPrompts()) {
    if (!key.startsWith(prefix) || !value) continue
    result[key.slice(prefix.length)] = value
  }
  return result
}

function getAuthoritativeDraftSessionIdsForInstance(instanceId: string): ReadonlySet<string> {
  if (!instanceId) return new Set()
  const prefix = `${instanceId}:`
  return new Set(
    [...authoritativeDraftKeys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  )
}

function getAuthoritativelyDeletedSessionIdsForInstance(instanceId: string): ReadonlySet<string> {
  if (!instanceId) return new Set()
  const prefix = `${instanceId}:`
  return new Set(
    [...authoritativelyDeletedSessionKeys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  )
}

function markSessionDeletedAuthoritative(instanceId: string, sessionId: string): void {
  const key = getDraftKey(instanceId, sessionId)
  setAuthoritativelyDeletedSessionKeys((prev) => {
    if (prev.has(key)) return prev
    const next = new Set(prev)
    next.add(key)
    return next
  })
}

function clearInstanceDeletedSessionAuthority(instanceId: string): void {
  if (!instanceId) return
  const prefix = `${instanceId}:`
  setAuthoritativelyDeletedSessionKeys((prev) => {
    const next = new Set([...prev].filter((key) => !key.startsWith(prefix)))
    return next.size === prev.size ? prev : next
  })
}

function clearSessionDraftPrompt(instanceId: string, sessionId: string) {
  const key = getDraftKey(instanceId, sessionId)
  markSessionDraftAuthoritative(instanceId, sessionId)
  setSessionDraftPrompts((prev) => {
    if (!prev.has(key)) return prev
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

function clearInstanceDraftPromptValues(instanceId: string) {
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

function clearInstanceDraftPromptAuthority(instanceId: string) {
  if (!instanceId) return
  setAuthoritativeDraftKeys((prev) => {
    const prefix = `${instanceId}:`
    const next = new Set([...prev].filter((key) => !key.startsWith(prefix)))
    return next.size === prev.size ? prev : next
  })
}

function clearInstanceDraftPrompts(instanceId: string) {
  clearInstanceDraftPromptValues(instanceId)
  clearInstanceDraftPromptAuthority(instanceId)
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
  if (pending) cancelSessionGenerationAdmissions(instanceId, sessionId)
  withSession(instanceId, sessionId, (session) => {
    if (session.pendingPermission === pending && (!pending || !session.generationRecovery)) return false
    session.pendingPermission = pending
    if (pending) {
      session.generationRecovery = null
      session.generationAdmissionToken = undefined
    }
  })
}

function setSessionPendingQuestion(instanceId: string, sessionId: string, pending: boolean): void {
  if (pending) cancelSessionGenerationAdmissions(instanceId, sessionId)
  withSession(instanceId, sessionId, (session) => {
    if (session.pendingQuestion === pending && (!pending || !session.generationRecovery)) return false
    session.pendingQuestion = pending
    if (pending) {
      session.generationRecovery = null
      session.generationAdmissionToken = undefined
    }
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
        if (session.id === sessionId) continue
        if (getSessionRootFromMap(instanceSessions, session.id)?.id === sessionId) idsToClear.add(session.id)
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

function markSessionSelectionAuthoritative(instanceId: string): void {
  setAuthoritativeSessionSelectionInstanceIds((prev) => {
    if (prev.has(instanceId)) return prev
    const next = new Set(prev)
    next.add(instanceId)
    return next
  })
}

function hydrateSessionIdleMarkers(instanceId: string, markers: Readonly<Record<string, number>>): void {
  setSessions((prev) => {
    const instanceSessions = prev.get(instanceId)
    if (!instanceSessions) return prev

    let changed = false
    const updatedSessions = new Map(instanceSessions)
    for (const [sessionId, idleSince] of Object.entries(markers)) {
      const session = updatedSessions.get(sessionId)
      if (!session || session.status !== "idle" || typeof session.idleSince === "number") continue
      updatedSessions.set(sessionId, { ...session, idleSince })
      changed = true
    }
    if (!changed) return prev

    const next = new Map(prev)
    next.set(instanceId, updatedSessions)
    return next
  })
}

function hydrateSessionGenerationRecovery(
  instanceId: string,
  markers: Readonly<Record<string, PersistedGenerationRecovery>>,
): void {
  setSessions((prev) => {
    const instanceSessions = prev.get(instanceId)
    if (!instanceSessions) return prev

    let changed = false
    const updatedSessions = new Map(instanceSessions)
    for (const [sessionId, persisted] of Object.entries(markers)) {
      const session = updatedSessions.get(sessionId)
      if (!session) continue
      const generationRecovery = session.pendingPermission || session.pendingQuestion
        ? null
        : resolveHydratedGenerationRecovery(
            persisted,
            session.status,
            session.runtimeStatusKnown === true,
          )
      if ((session.generationRecovery ?? null) === generationRecovery) continue
      updatedSessions.set(sessionId, { ...session, generationRecovery })
      changed = true
    }
    if (!changed) return prev

    const next = new Map(prev)
    next.set(instanceId, updatedSessions)
    return next
  })
}

function beginSessionGenerationAdmission(instanceId: string, sessionId: string): {
  complete: () => void
  rollback: () => void
} {
  generationAdmissionSequence += 1
  const token = generationAdmissionSequence
  const key = generationAdmissionKey(instanceId, sessionId)
  let group = generationAdmissionGroups.get(key)
  if (!group) {
    const session = sessions().get(instanceId)?.get(sessionId)
    if (!session) return { complete: () => {}, rollback: () => {} }
    group = {
      id: token,
      tokens: new Set(),
      accepted: false,
      baseline: {
        generationRecovery: session.generationRecovery,
        runtimeStatusKnown: session.runtimeStatusKnown,
        idleSince: session.idleSince,
      },
    }
    generationAdmissionGroups.set(key, group)
  }
  group.tokens.add(token)
  withSession(instanceId, sessionId, (session) => {
    session.generationRecovery = "pending"
    session.runtimeStatusKnown = false
    session.idleSince = null
    session.generationAdmissionToken = group!.id
  })
  const settle = (accepted: boolean) => {
    const activeGroup = generationAdmissionGroups.get(key)
    if (!activeGroup || !activeGroup.tokens.delete(token)) return
    activeGroup.accepted ||= accepted
    if (activeGroup.tokens.size > 0) return
    generationAdmissionGroups.delete(key)
    withSession(instanceId, sessionId, (session) => {
      if (session.generationAdmissionToken !== activeGroup.id) return false
      session.generationAdmissionToken = undefined
      if (activeGroup.accepted) return
      session.generationRecovery = activeGroup.baseline.generationRecovery
      session.runtimeStatusKnown = activeGroup.baseline.runtimeStatusKnown
      session.idleSince = activeGroup.baseline.idleSince
    })
  }
  return {
    complete: () => settle(true),
    rollback: () => settle(false),
  }
}

function hasAuthoritativeSessionSelection(instanceId: string): boolean {
  return authoritativeSessionSelectionInstanceIds().has(instanceId)
}

function writeActiveSession(instanceId: string, sessionId: string | null): void {
  setActiveSessionId((prev) => {
    const next = new Map(prev)
    if (sessionId) {
      next.set(instanceId, sessionId)
    } else {
      next.delete(instanceId)
    }
    return next
  })
  if (sessionId) {
    // Backfill authoritative Yolo state for the now-active session so the badge
    // matches the server even on first connect / multi-client scenarios.
    ensureYoloStateSynced(instanceId, sessionId)
  }
}

function writeActiveParentSession(instanceId: string, parentSessionId: string | null): void {
  setActiveParentSessionId((prev) => {
    const next = new Map(prev)
    if (parentSessionId) {
      next.set(instanceId, parentSessionId)
    } else {
      next.delete(instanceId)
    }
    return next
  })
}

function setActiveSession(instanceId: string, sessionId: string): void {
  markSessionSelectionAuthoritative(instanceId)
  writeActiveSession(instanceId, sessionId)
}

function setActiveParentSession(instanceId: string, parentSessionId: string): void {
  markSessionSelectionAuthoritative(instanceId)
  writeActiveParentSession(instanceId, parentSessionId)
  writeActiveSession(instanceId, parentSessionId)
}

function clearActiveParentSession(instanceId: string): void {
  markSessionSelectionAuthoritative(instanceId)
  writeActiveParentSession(instanceId, null)
  writeActiveSession(instanceId, null)
}

function clearActiveSession(instanceId: string): void {
  markSessionSelectionAuthoritative(instanceId)
  writeActiveSession(instanceId, null)
}

function hydrateActiveSessionSelection(
  instanceId: string,
  parentSessionId: string | null,
  sessionId: string | null,
): void {
  if (hasAuthoritativeSessionSelection(instanceId)) return
  writeActiveParentSession(instanceId, parentSessionId)
  writeActiveSession(instanceId, sessionId)
}

function clearInstanceSessionSelection(instanceId: string): void {
  writeActiveParentSession(instanceId, null)
  writeActiveSession(instanceId, null)
  setAuthoritativeSessionSelectionInstanceIds((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Set(prev)
    next.delete(instanceId)
    return next
  })
}

function setSessionStatus(instanceId: string, sessionId: string, status: SessionStatus): void {
  let expandAncestors = false

  withSession(instanceId, sessionId, (session) => {
    const admissionPending = session.generationAdmissionToken !== undefined && status === "idle"
    const generationRecovery = admissionPending
      ? "pending"
      : resolveAuthoritativeGenerationRecovery(session.generationRecovery, status)
    if (
      session.status === status
      && session.runtimeStatusKnown === !admissionPending
      && (session.generationRecovery ?? null) === generationRecovery
    ) return false
    const previous = session.status
    session.status = status
    session.runtimeStatusKnown = !admissionPending
    session.generationRecovery = generationRecovery
    if (!admissionPending) {
      cancelSessionGenerationAdmissions(instanceId, sessionId)
      session.generationAdmissionToken = undefined
    }
    session.idleSince = getIdleSinceForStatusTransition(previous, status, session.idleSince)
    if (status !== "working") {
      session.retry = null
    }

    if (session.parentId && status === "working" && previous !== "working") {
      expandAncestors = true
    }
  })

  if (expandAncestors) ensureSessionAncestorsExpanded(instanceId, sessionId)
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

function getDescendantSessions(instanceId: string, parentId: string): Session[] {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions ? getDescendantSessionsFromMap(instanceSessions, parentId) : []
}

function getSessionFamily(instanceId: string, parentId: string): Session[] {
  const parent = sessions().get(instanceId)?.get(parentId)
  if (!parent) return []

  const children = getDescendantSessions(instanceId, parentId)
  return [parent, ...children]
}

function getSessionRoot(instanceId: string, sessionId: string): Session | null {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return null
  return getSessionRootFromMap(instanceSessions, sessionId)
}

function buildSessionThreads(instanceId: string, rootIds: string[], childIds?: Set<string>): SessionThread[] {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions ? buildSessionThreadsFromMap(instanceSessions, rootIds, childIds) : []
}

function getSessionThreads(instanceId: string): SessionThread[] {
  return buildSessionThreads(instanceId, getSessionListIds(instanceId))
}

function getSessionSearchThreads(instanceId: string): SessionThread[] {
  const resultIds = getSessionSearchResultIds(instanceId)
  if (resultIds.length === 0) return []

  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return []

  const rootIds: string[] = []
  const childIds = new Set<string>()

  for (const sessionId of resultIds) {
    const session = instanceSessions.get(sessionId)
    if (!session) continue
    if (session.parentId === null) {
      if (!rootIds.includes(session.id)) rootIds.push(session.id)
    } else {
      childIds.add(session.id)
      const root = getSessionRootFromMap(instanceSessions, session.id)
      if (root && !rootIds.includes(root.id)) rootIds.push(root.id)
    }
  }

  return buildSessionThreads(instanceId, rootIds, childIds)
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

function getSessionAncestorIds(instanceId: string, sessionId: string): string[] {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions ? getSessionAncestorIdsFromMap(instanceSessions, sessionId) : []
}

function ensureSessionAncestorsExpanded(instanceId: string, sessionId: string): void {
  const ancestorIds = getSessionAncestorIds(instanceId, sessionId)
  if (ancestorIds.length === 0) return
  setExpandedSessions((prev) => {
    const next = new Map(prev)
    const expanded = new Set(next.get(instanceId))
    let changed = false
    for (const ancestorId of ancestorIds) {
      if (expanded.has(ancestorId)) continue
      expanded.add(ancestorId)
      changed = true
    }
    if (!changed) return prev
    next.set(instanceId, expanded)
    return next
  })
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
  const root = getSessionRoot(instanceId, sessionId)
  if (!root) return

  batch(() => {
    setActiveParentSession(instanceId, root.id)
    if (session.id !== root.id) setActiveSession(instanceId, session.id)
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

function getSessionMessagesLoadError(instanceId: string, sessionId: string): string | undefined {
  return messageLoadErrors().get(instanceId)?.get(sessionId)
}

function setSessionMessagesLoadError(instanceId: string, sessionId: string, error: string | null): void {
  setMessageLoadErrors((prev) => {
    const next = new Map(prev)
    const instanceErrors = new Map(next.get(instanceId))

    if (error) {
      instanceErrors.set(sessionId, error)
      next.set(instanceId, instanceErrors)
      return next
    }

    instanceErrors.delete(sessionId)
    if (instanceErrors.size > 0) {
      next.set(instanceId, instanceErrors)
    } else {
      next.delete(instanceId)
    }
    return next
  })
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
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions?.has(sessionId)) return
  const familyIds = [...getSessionAncestorIdsFromMap(instanceSessions, sessionId), sessionId]
  for (const familyId of familyIds) updateThreadTotalsForParent(instanceId, familyId)
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
    const client = getRootClient(instanceId)
    const workspace = await getOpenCodeWorkspaceIdForSession(instanceId, session.id)
    messages = await requestData<any[]>(
      client.session.messages({ sessionID: session.id, ...(workspace ? { workspace } : {}) }),
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
  activeParentSessionId,
  agents,
  setAgents,
  providers,
  setProviders,
  loading,
  setLoading,
  messagesLoaded,
  setMessagesLoaded,
  setSessionMessagesLoadError,
  sessionInfoByInstance,
  setSessionInfoByInstance,
  threadTotalsByInstance,
  getThreadTotals,
  updateThreadTotalsForParent,
  updateThreadTotalsForSession,
  getSessionDraftPrompt,
  getSessionDraftPromptsForInstance,
  getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance,
  markSessionDeletedAuthoritative,
  clearInstanceDeletedSessionAuthority,
  hydrateSessionDraftPrompt,
  onSessionDraftHydrated,
  setSessionDraftPrompt,
  clearSessionDraftPrompt,
  clearInstanceDraftPromptValues,
  clearInstanceDraftPrompts,
  pruneDraftPrompts,
  withSession,
  setSessionPendingPermission,
  setSessionPendingQuestion,
  markSessionIdleSeen,
  markViewedSessionIdleSeen,
  hydrateSessionIdleMarkers,
  hydrateSessionGenerationRecovery,
  beginSessionGenerationAdmission,
  cancelSessionGenerationAdmissions,
  setSessionStatus,
  setActiveSession,
  setActiveParentSession,
  clearActiveSession,
  clearActiveParentSession,
  hydrateActiveSessionSelection,
  hasAuthoritativeSessionSelection,
  clearInstanceSessionSelection,
  getActiveSession,
  getActiveParentSession,
  getSessions,
  getParentSessions,
  getChildSessions,
  getDescendantSessions,
  getSessionRoot,
  getSessionFamily,
  getSessionThreads,
  getSessionSearchThreads,
  getVisibleSessionIds,
  isSessionExpanded,
  setSessionExpanded,
  toggleSessionExpanded,
  ensureSessionExpanded,
  getSessionAncestorIds,
  ensureSessionAncestorsExpanded,
  setActiveSessionFromList,
  isSessionBusy,
  isSessionMessagesLoading,
  getSessionMessagesLoadError,
  getSessionInfo,
  isBlankSession,
  cleanupBlankSessions,
  expandedSessionParents,
  isSessionParentExpanded,
  setSessionParentExpanded,
  toggleSessionParentExpanded,
  ensureSessionParentExpanded,
  SESSION_PAGE_SIZE,
  sessionPagination,
  sessionSearch,
  getSessionListIds,
  getSessionNextCursor,
  setSessionPage,
  getSessionHasMore,
  resetSessionPagination,
  prependSessionListId,
  removeSessionListId,
  beginSessionSearch,
  isLatestSessionSearch,
  setSessionSearchResults,
  clearSessionSearch,
  getSessionSearchResultIds,
  getSessionSearchQuery,
  isSessionSearchLoading,
}
