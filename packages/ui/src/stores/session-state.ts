import { batch, createSignal } from "solid-js"
import { carrySessionProjection, childSessionIds, sessionCheckpoint, sessionIndicatorRows, sessionTopology } from "./session-projection"
import { beginGesture, type SurfaceGesture } from "./session-surface"
import { activeSessionId, setActiveSessionId } from "./session-selection-state"

import { getIdleSinceForStatusTransition, type Session, type SessionRetryState, type SessionStatus, type Agent, type Provider } from "../types/session"
import { loadMessages, refreshSessionCatalog } from "./session-api"
import { showToastNotification } from "../lib/notifications"
import { messageStoreBus } from "./message-v2/bus"
import { instances } from "./instances"
import { showConfirmDialog } from "./alerts"
import { getLogger } from "../lib/logger"
import { captureBackendOperation } from "../lib/backend-operation"
import { tGlobal } from "../lib/i18n"
import { computeThreadTotals, type ThreadTotals } from "../lib/thread-totals"
import { applySessionPage, getDefaultSessionPaginationState, type SessionPaginationState } from "./session-pagination-model"
import { applySessionPendingState } from "./session-pending-state"
import { cleanupBlankSession } from "./blank-session-cleanup"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { flushTranscriptProjections } from "./opencode-projection-frame"
import {
  resolveAuthoritativeGenerationRecovery,
  resolveHydratedGenerationRecovery,
  type PersistedGenerationRecovery,
} from "./session-generation-recovery"
import {
  buildSessionThreadsFromMap,
  collectVisibleSessionIds,
  projectUnarchivedSessionThreads,
  getDescendantSessionsFromMap,
  getSessionAncestorIdsFromMap,
  getSessionRootFromMap,
  type SessionThread,
} from "./session-tree"

export type { SessionThread } from "./session-tree"
import { getDirectoryOnlyWorktree, getGitRepoStatus, worktreesByInstance } from "./worktrees"
import { selectWorkspaceFamilyIds } from "./workspace-session-scope"
import { confirmedSessionListDirectory, getSessionPlacementEvidence } from "./session-events"
import { resolveRestoredSessionSelection } from "./app-session-reconciliation"
import { getSessionListView } from "./session-list-view"

const log = getLogger("session")
let generationAdmissionSequence = 0
interface GenerationAdmission {
  signal: AbortSignal
  token: number
  pending: number
  accepted: boolean
  idleBoundary: number
  baseline: Pick<Session, "generationRecovery" | "runtimeStatusKnown" | "idleSince" | "outcome" | "generationAdmissionEpoch" | "generationAdmissionIdleBoundary">
}
const generationAdmissions = new Map<string, GenerationAdmission>()

function cancelSessionGenerationAdmissions(instanceId: string, sessionId: string): void {
  generationAdmissions.delete(`${instanceId}:${sessionId}`)
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

// Published workspace maps are snapshots. Replace every changed map.
const [sessions, setSessions] = createSignal<Map<string, Map<string, Session>>>(new Map())
const [activeParentSessionId, setActiveParentSessionId] = createSignal<Map<string, string>>(new Map())
const [agents, setAgents] = createSignal<Map<string, Agent[]>>(new Map())
// The Location authority key each instance's `agents` list was read for.
const [agentCatalogLocations, setAgentCatalogLocations] = createSignal<Map<string, string>>(new Map())
const [providers, setProviders] = createSignal<Map<string, Provider[]>>(new Map())
const [sessionDraftPrompts, setSessionDraftPrompts] = createSignal<Map<string, string>>(new Map())
const [authoritativeDraftKeys, setAuthoritativeDraftKeys] = createSignal<Set<string>>(new Set())
const [authoritativeSessionSelectionInstanceIds, setAuthoritativeSessionSelectionInstanceIds] = createSignal<Set<string>>(new Set())
const [authoritativelyDeletedSessionKeys, setAuthoritativelyDeletedSessionKeys] = createSignal<Set<string>>(new Set())
const [authoritativeSessionExpansionKeys, setAuthoritativeSessionExpansionKeys] = createSignal<Set<string>>(new Set())
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
const [sessionListErrors, setSessionListErrors] = createSignal<Map<string, string>>(new Map())
const messageLoadEpochs = new Map<string, number>()
const messageLoadControllers = new Map<string, AbortController>()
let nextMessageLoadEpoch = 0
const [sessionInfoByInstance, setSessionInfoByInstance] = createSignal<Map<string, Map<string, SessionInfo>>>(new Map())
const [threadTotalsByInstance, setThreadTotalsByInstance] = createSignal<Map<string, Map<string, ThreadTotals>>>(new Map())

// Track expansion state for ANY session that has children (not just top-level parents)
const [expandedSessions, setExpandedSessions] = createSignal<Map<string, Set<string>>>(new Map())

export type InstanceSessionIndicatorStatus = "permission" | SessionStatus

const SESSION_PAGE_SIZE = 200

type SessionSearchState = {
  query: string
  ids: string[]
  loading: boolean
  requestId: number
}

const [sessionPagination, setSessionPagination] = createSignal<Map<string, SessionPaginationState>>(new Map())
const [sessionSearch, setSessionSearch] = createSignal<Map<string, SessionSearchState>>(new Map())

function updateSessionPagination(
  instanceId: string,
  update: (current: SessionPaginationState | undefined) => SessionPaginationState,
): void {
  setSessionPagination((prev) => new Map(prev).set(instanceId, update(prev.get(instanceId))))
}

function getSessionPaginationState(instanceId: string): SessionPaginationState {
  return sessionPagination().get(instanceId) ?? getDefaultSessionPaginationState()
}

function getSessionListIds(instanceId: string): string[] {
  const ids = getSessionPaginationState(instanceId).ids
  const current = sessions().get(instanceId)
  if (!current) return ids
  const directoryOnly = getDirectoryOnlyWorktree(instanceId)
  return projectSessionListIds(ids, current, directoryOnly?.serviceDirectory ?? directoryOnly?.directory)
}

function projectSessionListIds(ids: string[], current: ReadonlyMap<string, Session>, directory?: string): string[] {
  // Restored catalogs retain all candidates before worktree scope is known.
  // Match the thread builder's root projection without rewriting native parents.
  return ids.filter(id => !current.has(id) || getSessionRootFromMap(current, id, directory)?.id === id)
}

function getSessionNextCursor(instanceId: string): string | undefined {
  return getSessionPaginationState(instanceId).nextCursor
}

function setSessionPage(instanceId: string, ids: string[], hasMore: boolean, reset = false, nextCursor?: string): void {
  updateSessionPagination(instanceId, (current) => applySessionPage(current, ids, hasMore, reset, nextCursor))
}

function getSessionHasMore(instanceId: string): boolean {
  return getSessionPaginationState(instanceId).hasMore
}

function resetSessionPagination(instanceId: string): void {
  updateSessionPagination(instanceId, getDefaultSessionPaginationState)
}

function prependSessionListId(instanceId: string, sessionId: string): void {
  updateSessionPagination(instanceId, (value) => {
    const current = value ?? { ids: [], hasMore: true }
    return { ...current, ids: [sessionId, ...current.ids.filter((id) => id !== sessionId)] }
  })
}

function removeSessionListId(instanceId: string, sessionId: string): void {
  updateSessionPagination(instanceId, (value) => {
    const current = value ?? { ids: [], hasMore: true }
    return { ...current, ids: current.ids.filter((id) => id !== sessionId) }
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

// A workspace also holds sessions of nested checkouts of other repositories it
// owns (an opened parent folder receives their live events). Its list,
// indicators and notices show the inventory's scope: complete families with a
// member in the opened folder or a registered worktree. Without a read
// inventory, and for Git-unavailable folders (which project their own
// directory), every held session is in scope. The active session's family is
// always in scope: a session opened explicitly is shown where it was opened.
// A session a move located elsewhere (`markSessionMovedAway`) is never in scope.
const NO_SESSIONS: ReadonlyMap<string, Session> = new Map()
const workspaceScopes = new WeakMap<object, {
  worktrees: unknown; active?: string; away: unknown; scope: ReadonlySet<string>; unscoped: boolean; folder: string; client: unknown; evidence: unknown
}>()

function getWorkspaceSessionScope(instanceId: string): ReadonlySet<string> | null {
  const held = sessions().get(instanceId) ?? NO_SESSIONS
  const worktrees = worktreesByInstance().get(instanceId)
  const away = getMovedAwaySessions(instanceId)
  const unscoped = !worktrees || getGitRepoStatus(instanceId) === null || Boolean(getDirectoryOnlyWorktree(instanceId))
  if (unscoped && !away.size) return null
  const active = activeSessionId().get(instanceId)
  const instance = instances().get(instanceId)
  const folder = instance?.folder ?? ""
  const client = instance?.client
  const evidence = getSessionPlacementEvidence(instanceId)
  const topology = sessionTopology(held)
  const cached = workspaceScopes.get(topology)
  if (cached && cached.worktrees === worktrees && cached.active === active && cached.away === away
    && cached.unscoped === unscoped && cached.folder === folder && cached.client === client && cached.evidence === evidence) return cached.scope
  const scope = unscoped ? new Set(held.keys())
    : selectWorkspaceFamilyIds([...held.values()].map((session) => ({
      id: session.id, parentId: session.parentId, directory: confirmedSessionListDirectory(instanceId, session.id, session) ?? session.location?.directory })),
    folder, worktrees!, active ? [active] : [])
  for (const id of away.keys()) scope.delete(id)
  workspaceScopes.set(topology, { worktrees, active, away, scope, unscoped, folder, client, evidence })
  return scope
}

function isSessionInWorkspaceScope(instanceId: string, sessionId: string): boolean {
  return getWorkspaceSessionScope(instanceId)?.has(sessionId) ?? true
}

/** Evaluate a verified return without its departure marker or a selected-family override. */
export function canRelistReturnedSession(instanceId: string, sessionId: string): boolean {
  const worktrees = worktreesByInstance().get(instanceId)
  if (!worktrees || getGitRepoStatus(instanceId) === null) return false
  const away = getMovedAwaySessions(instanceId)
  const members = new Map([...(sessions().get(instanceId) ?? [])].filter(([id]) => id === sessionId || !away.has(id)))
  const directoryOnly = getDirectoryOnlyWorktree(instanceId)
  const scope = selectWorkspaceFamilyIds([...members.values()].map(session => ({
    id: session.id, parentId: session.parentId,
    directory: confirmedSessionListDirectory(instanceId, session.id, session) ?? session.location.directory,
  })), instances().get(instanceId)?.folder ?? "", worktrees)
  return scope.has(sessionId) && getSessionRootFromMap(members, sessionId, directoryOnly?.serviceDirectory ?? directoryOnly?.directory) !== null
}

const listedSessionMaps = new WeakMap<ReadonlyMap<string, Session>, { scope: unknown; directory?: string; listed: ReadonlyMap<string, Session> }>()

/** The held sessions the list shows: in scope and connected to a listed root.
 * Its rows, its parents' subsession activity and the tab indicator all derive
 * from this one map, so a session outside it never renders, connects rows or
 * contributes activity; a row under an ancestor outside the scope is left out
 * as a child whose parent is missing is. */
function getListedSessionMap(instanceId: string): ReadonlyMap<string, Session> {
  const held = sessions().get(instanceId) ?? NO_SESSIONS
  const scope = getWorkspaceSessionScope(instanceId)
  if (!scope) return held
  const directoryOnly = getDirectoryOnlyWorktree(instanceId)
  const directory = directoryOnly?.serviceDirectory ?? directoryOnly?.directory
  const cached = listedSessionMaps.get(held)
  if (cached && cached.scope === scope && cached.directory === directory) return cached.listed
  const scoped = new Map([...held].filter(([id]) => scope.has(id)))
  const listed = new Map([...scoped].filter(([id]) => getSessionRootFromMap(scoped, id, directory) !== null))
  const result = listed.size === held.size ? held : listed
  listedSessionMaps.set(held, { scope, directory, listed: result })
  return result
}

const indicatorStatuses = new WeakMap<ReadonlyMap<string, Session>, InstanceSessionIndicatorStatus>()

export function getInstanceSessionIndicatorStatusCached(instanceId: string): InstanceSessionIndicatorStatus {
  const listed = getListedSessionMap(instanceId)
  const cached = indicatorStatuses.get(listed)
  if (cached !== undefined) return cached
  let status: InstanceSessionIndicatorStatus = "idle"
  for (const session of sessionIndicatorRows(listed).values()) {
    if (session.pendingPermission || session.pendingForm) {
      status = "permission"
      break
    }
    if (session.status === "compacting") status = "compacting"
    else if (session.status === "working" && status === "idle") status = "working"
  }
  indicatorStatuses.set(listed, status)
  return status
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

function advanceMessageLoadEpoch(instanceId: string, sessionId: string): number {
  const key = getDraftKey(instanceId, sessionId)
  messageLoadControllers.get(key)?.abort()
  const epoch = ++nextMessageLoadEpoch
  messageLoadEpochs.set(key, epoch)
  messageLoadControllers.set(key, new AbortController())
  return epoch
}

function isCurrentMessageLoad(instanceId: string, sessionId: string, epoch: number): boolean {
  return messageLoadEpochs.get(getDraftKey(instanceId, sessionId)) === epoch
}

function getMessageLoadSignal(instanceId: string, sessionId: string): AbortSignal | undefined {
  return messageLoadControllers.get(getDraftKey(instanceId, sessionId))?.signal
}

function finishMessageLoad(instanceId: string, sessionId: string, epoch: number): void {
  if (!isCurrentMessageLoad(instanceId, sessionId, epoch)) return
  messageLoadControllers.delete(getDraftKey(instanceId, sessionId))
}

function clearMessageLoadingFlag(instanceId: string, sessionId: string): void {
  setLoading((prev) => {
    const existing = prev.loadingMessages.get(instanceId)
    if (!existing?.has(sessionId)) return prev
    const loadingMessages = new Map(prev.loadingMessages)
    const updated = new Set(existing)
    updated.delete(sessionId)
    if (updated.size === 0) loadingMessages.delete(instanceId)
    else loadingMessages.set(instanceId, updated)
    return { ...prev, loadingMessages }
  })
}

function supersedeSessionMessageLoad(instanceId: string, sessionId: string): void {
  const key = getDraftKey(instanceId, sessionId)
  messageLoadControllers.get(key)?.abort()
  messageLoadControllers.delete(key)
  messageLoadEpochs.set(key, ++nextMessageLoadEpoch)
  clearMessageLoadingFlag(instanceId, sessionId)
}

function invalidateSessionMessageLoad(instanceId: string, sessionId: string): void {
  supersedeSessionMessageLoad(instanceId, sessionId)
  clearLoadedFlag(instanceId, sessionId)
}

messageStoreBus.onSessionCleared(invalidateSessionMessageLoad)

function clearInstanceMessageLoads(instanceId: string): void {
  const prefix = `${instanceId}:`
  for (const [key, controller] of messageLoadControllers) {
    if (!key.startsWith(prefix)) continue
    controller.abort()
    messageLoadControllers.delete(key)
  }
  for (const key of messageLoadEpochs.keys()) {
    if (key.startsWith(prefix)) messageLoadEpochs.delete(key)
  }
  setMessagesLoaded((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setMessageLoadErrors((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setLoading((prev) => {
    if (!prev.loadingMessages.has(instanceId)) return prev
    const loadingMessages = new Map(prev.loadingMessages)
    loadingMessages.delete(instanceId)
    return { ...prev, loadingMessages }
  })
}

messageStoreBus.onInstanceDestroyed(clearInstanceMessageLoads)

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
    if ((prev.get(key) ?? "") === value) return prev
    const next = new Map(prev)
    if (!value) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    return next
  })
}

function addAuthoritativeKey(setter: typeof setAuthoritativeDraftKeys, key: string): void {
  setter((prev) => {
    if (prev.has(key)) return prev
    const next = new Set(prev)
    next.add(key)
    return next
  })
}

function markSessionDraftAuthoritative(instanceId: string, sessionId: string) {
  addAuthoritativeKey(setAuthoritativeDraftKeys, getDraftKey(instanceId, sessionId))
}

function setSessionDraftPrompt(instanceId: string, sessionId: string, value: string) {
  markSessionDraftAuthoritative(instanceId, sessionId)
  writeSessionDraftPrompt(instanceId, sessionId, value)
}

function hydrateSessionDraftPrompt(instanceId: string, sessionId: string, value: string): void {
  writeSessionDraftPrompt(instanceId, sessionId, value)
  for (const listener of sessionDraftHydratedListeners) listener(instanceId, sessionId, value)
}

export function replaceSessionDraftPrompt(instanceId: string, sessionId: string, value: string): void {
  markSessionDraftAuthoritative(instanceId, sessionId)
  hydrateSessionDraftPrompt(instanceId, sessionId, value)
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

export function trackSessionDraftChanges(): void {
  sessionDraftPrompts()
  authoritativeDraftKeys()
}

function getAuthoritativeSessionIds(keys: ReadonlySet<string>, instanceId: string): ReadonlySet<string> {
  if (!instanceId) return new Set()
  const prefix = `${instanceId}:`
  return new Set(
    [...keys]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  )
}

function getAuthoritativeDraftSessionIdsForInstance(instanceId: string): ReadonlySet<string> {
  return getAuthoritativeSessionIds(authoritativeDraftKeys(), instanceId)
}

function getAuthoritativelyDeletedSessionIdsForInstance(instanceId: string): ReadonlySet<string> {
  return getAuthoritativeSessionIds(authoritativelyDeletedSessionKeys(), instanceId)
}

function getAuthoritativeSessionExpansionIdsForInstance(instanceId: string): ReadonlySet<string> {
  return getAuthoritativeSessionIds(authoritativeSessionExpansionKeys(), instanceId)
}

function markSessionDeletedAuthoritative(instanceId: string, sessionId: string): void {
  addAuthoritativeKey(setAuthoritativelyDeletedSessionKeys, getDraftKey(instanceId, sessionId))
}

/** Per instance, the destination of each session located elsewhere (null if
 * the proxy refused a parent read without revealing its directory). It is never
 * listed there, whatever path brings it; a later inventory serving that
 * destination lists it again. Released when a refresh lists it at a served
 * directory, it is deleted or moves again, or the instance closes. */
const [movedAwaySessions, setMovedAwaySessions] = createSignal<ReadonlyMap<string, ReadonlyMap<string, string | null>>>(new Map())
const NO_MOVED_AWAY: ReadonlyMap<string, string | null> = new Map()

function updateMovedAwaySessions(instanceId: string, update: (away: Map<string, string | null>) => void): void {
  setMovedAwaySessions((previous) => {
    const away = new Map(previous.get(instanceId) ?? NO_MOVED_AWAY)
    update(away)
    const next = new Map(previous)
    if (away.size) next.set(instanceId, away)
    else next.delete(instanceId)
    return next
  })
}

function markSessionMovedAway(instanceId: string, sessionId: string, directory: string | null): void {
  if (movedAwaySessions().get(instanceId)?.get(sessionId) === directory) return
  updateMovedAwaySessions(instanceId, (away) => { away.set(sessionId, directory) })
}

function forgetSessionMovedAway(instanceId: string, sessionId: string): void {
  if (!movedAwaySessions().get(instanceId)?.has(sessionId)) return
  updateMovedAwaySessions(instanceId, (away) => { away.delete(sessionId) })
}

function getMovedAwaySessions(instanceId: string): ReadonlyMap<string, string | null> {
  return movedAwaySessions().get(instanceId) ?? NO_MOVED_AWAY
}

function getMovedAwaySessionIds(instanceId: string): string[] {
  return [...getMovedAwaySessions(instanceId).keys()]
}

function clearInstanceMovedAwaySessions(instanceId: string): void {
  if (!movedAwaySessions().has(instanceId)) return
  setMovedAwaySessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
}

function clearInstanceDeletedSessionAuthority(instanceId: string): void {
  if (!instanceId) return
  const prefix = `${instanceId}:`
  for (const key of messageLoadEpochs.keys()) {
    if (key.startsWith(prefix)) messageLoadEpochs.delete(key)
  }
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

/** A passive eviction clears the live value, not an unhydrated saved draft. */
export function evictSessionDraftPrompt(instanceId: string, sessionId: string) {
  if (getSessionDraftPrompt(instanceId, sessionId)) writeSessionDraftPrompt(instanceId, sessionId, "")
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

function withSession(instanceId: string, sessionId: string, updater: (session: Session, previous: Readonly<Session>) => void | boolean) {
  setSessions((prev) => {
    const instanceSessions = prev.get(instanceId)
    if (!instanceSessions) return prev

    const current = instanceSessions.get(sessionId)
    if (!current) return prev

    const time = { ...current.time }
    const location = current.location && { ...current.location }
    const model = current.model && { ...current.model }
    const tokens = current.tokens && { ...current.tokens, cache: { ...current.tokens.cache } }
    const retry = current.retry && { ...current.retry }
    const updatedSession: Session = { ...current, time, location, model, tokens, retry }
    const result = updater(updatedSession, current)
    if (result === false) {
      return prev
    }

    // Preserve unchanged nested identities, including a model object
    // deliberately replaced by an authoritative selection.
    if (updatedSession.time === time && shallowFieldsEqual(current.time, time)) updatedSession.time = current.time
    if (updatedSession.location === location && shallowFieldsEqual(current.location, location)) updatedSession.location = current.location
    if (updatedSession.model === model && shallowFieldsEqual(current.model, model)) updatedSession.model = current.model
    if (updatedSession.retry === retry && current.retry && retry && shallowFieldsEqual(current.retry, retry)) updatedSession.retry = current.retry
    if (updatedSession.tokens === tokens && tokens && current.tokens) {
      if (shallowFieldsEqual(current.tokens.cache, tokens.cache)) tokens.cache = current.tokens.cache
      if (shallowFieldsEqual(current.tokens, tokens)) updatedSession.tokens = current.tokens
    }
    return replaceSessionRow(prev, instanceId, updatedSession)
  })
}

function shallowFieldsEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]))
}

/** Publish one row while retaining projections that it cannot affect. */
export function replaceSessionRow(previous: Map<string, Map<string, Session>>, instanceId: string, session: Session) {
  const instanceSessions = previous.get(instanceId)
  const sessionId = session.id
  const updated = new Map(instanceSessions).set(sessionId, session)
  if (!instanceSessions) return new Map(previous).set(instanceId, updated)
  const current = instanceSessions.get(sessionId)
  carrySessionProjection(instanceSessions, updated, current, session)
  const projection = listedSessionMaps.get(instanceSessions)
  const previousTopology = sessionTopology(instanceSessions)
  const nextTopology = sessionTopology(updated)
  const parent = !current && session.parentId ? instanceSessions.get(session.parentId) : undefined
  const scope = parent ? workspaceScopes.get(previousTopology) : undefined
  const sameLocationLeaf = scope && parent && !childSessionIds(instanceSessions, sessionId).length
    && !getMovedAwaySessions(instanceId).has(sessionId)
    && (confirmedSessionListDirectory(instanceId, parent.id, parent) ?? parent.location.directory)
      === (confirmedSessionListDirectory(instanceId, sessionId, session) ?? session.location.directory)
    && parent.location.directory === session.location.directory
    && scope.scope.has(parent.id)
  const extendedScope = sameLocationLeaf && new Set(scope.scope).add(sessionId)
  if (extendedScope && scope) workspaceScopes.set(nextTopology, { ...scope, scope: extendedScope })
  if (projection && (previousTopology === nextTopology || (extendedScope && projection.scope === scope?.scope))) {
    const before = projection.listed
    const include = before.has(sessionId) || Boolean(extendedScope && parent && before.has(parent.id))
    const listed = before === instanceSessions ? updated : include ? new Map(before).set(sessionId, session) : before
    if (listed !== before && listed !== updated) carrySessionProjection(before, listed, current, session)
    listedSessionMaps.set(updated, { ...projection, scope: extendedScope || projection.scope, listed })
  }
  return new Map(previous).set(instanceId, updated)
}

function setSessionPending(
  instanceId: string,
  sessionId: string,
  field: "pendingPermission" | "pendingForm",
  pending: boolean,
): void {
  if (pending) cancelSessionGenerationAdmissions(instanceId, sessionId)
  withSession(instanceId, sessionId, (session) => {
    if (session[field] === pending && (!pending || !session.generationRecovery)) return false
    session[field] = pending
    if (pending) {
      session.generationRecovery = null
      session.generationAdmissionToken = undefined
    }
  })
}

function setSessionPendingPermission(instanceId: string, sessionId: string, pending: boolean): void {
  setSessionPending(instanceId, sessionId, "pendingPermission", pending)
}

function setSessionPendingForm(instanceId: string, sessionId: string, pending: boolean): void {
  setSessionPending(instanceId, sessionId, "pendingForm", pending)
}

function reconcileSessionPendingState(
  instanceId: string,
  permissionSessionIds: ReadonlySet<string>,
  formSessionIds: ReadonlySet<string> = new Set(),
): void {
  setSessions((prev) => {
    const instanceSessions = prev.get(instanceId)
    if (!instanceSessions) return prev

    const reconciled = applySessionPendingState(instanceSessions, permissionSessionIds, formSessionIds)
    if (reconciled === instanceSessions) return prev

    const next = new Map(prev)
    next.set(instanceId, reconciled)
    return next
  })
}

function markSessionIdleSeen(instanceId: string, sessionId: string): void {
  const current = sessions().get(instanceId)?.get(sessionId)
  if (!current || current.status !== "idle" || current.pendingPermission || current.pendingForm || current.retry) return
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
  const instanceSessions = sessions().get(instanceId)
  const viewedSession = instanceSessions?.get(sessionId)
  if (!instanceSessions || !viewedSession) return
  const ids = viewedSession.parentId === null && !keepUnseenSubagentIdleStatus
    ? [sessionId, ...getDescendantSessionsFromMap(instanceSessions, sessionId).map((session) => session.id)]
    : [sessionId]
  batch(() => ids.forEach((id) => markSessionIdleSeen(instanceId, id)))
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
  for (const [sessionId, idleSince] of Object.entries(markers)) {
    withSession(instanceId, sessionId, (session) => {
      if (session.status !== "idle" || typeof session.idleSince === "number") return false
      session.idleSince = idleSince
    })
  }
}

function hydrateSessionGenerationRecovery(
  instanceId: string,
  markers: Readonly<Record<string, PersistedGenerationRecovery>>,
): void {
  for (const [sessionId, persisted] of Object.entries(markers)) {
    withSession(instanceId, sessionId, (session) => {
      const recovery = session.pendingPermission || session.pendingForm
        ? null
        : resolveHydratedGenerationRecovery(persisted, session.status, session.runtimeStatusKnown === true, session.outcome)
      if ((session.generationRecovery ?? null) === recovery) return false
      session.generationRecovery = recovery
    })
  }
}

function beginSessionGenerationAdmission(instanceId: string, sessionId: string): {
  complete: () => void
  rollback: () => void
} {
  const { signal } = captureBackendOperation(instanceId)
  if (signal.aborted) return { complete: () => {}, rollback: () => {} }
  const key = `${instanceId}:${sessionId}`
  let admission = generationAdmissions.get(key)
  if (!admission || admission.signal !== signal) {
    const session = sessions().get(instanceId)?.get(sessionId)
    if (!session) return { complete: () => {}, rollback: () => {} }
    admission = {
      signal,
      token: ++generationAdmissionSequence,
      pending: 0,
      accepted: false,
      idleBoundary: session.time.idle ?? 0,
      baseline: {
        generationRecovery: session.generationRecovery,
        runtimeStatusKnown: session.runtimeStatusKnown,
        idleSince: session.idleSince,
        outcome: session.outcome,
        generationAdmissionEpoch: session.generationAdmissionEpoch,
        generationAdmissionIdleBoundary: session.generationAdmissionIdleBoundary,
      },
    }
    generationAdmissions.set(key, admission)
  }
  admission.pending += 1
  withSession(instanceId, sessionId, (session) => {
    session.generationRecovery = "pending"
    session.runtimeStatusKnown = false
    session.idleSince = null
    session.generationAdmissionToken = admission!.token
    session.generationAdmissionEpoch = admission!.token
    session.generationAdmissionIdleBoundary = admission!.idleBoundary
    session.outcome = undefined
  })

  let settled = false
  const settle = (accepted: boolean) => {
    if (settled || generationAdmissions.get(key) !== admission) return
    settled = true
    admission.accepted ||= accepted
    if (--admission.pending > 0) return
    generationAdmissions.delete(key)
    withSession(instanceId, sessionId, (session) => {
      if (session.generationAdmissionToken !== admission.token) return false
      session.generationAdmissionToken = undefined
      if (admission.accepted) return
      Object.assign(session, admission.baseline)
    })
  }
  return { complete: () => settle(true), rollback: () => settle(false) }
}

function hasAuthoritativeSessionSelection(instanceId: string): boolean {
  return authoritativeSessionSelectionInstanceIds().has(instanceId)
}

function writeSessionSelection(
  setter: typeof setActiveSessionId,
  instanceId: string,
  sessionId: string | null,
): void {
  // A coalesced transcript page admitted under the previous selection lands
  // before the gates move; nothing pending may cross a selection change.
  flushTranscriptProjections()
  setter((prev) => {
    const next = new Map(prev)
    if (sessionId) next.set(instanceId, sessionId)
    else next.delete(instanceId)
    return next
  })
}

function writeActiveSession(instanceId: string, sessionId: string | null): void {
  writeSessionSelection(setActiveSessionId, instanceId, sessionId)
  void refreshSessionCatalog(instanceId).catch((error) => log.warn("Failed to refresh session catalog", { instanceId, error }))
}

function writeActiveParentSession(instanceId: string, parentSessionId: string | null): void {
  writeSessionSelection(setActiveParentSessionId, instanceId, parentSessionId)
}

function setActiveSession(instanceId: string, sessionId: string, gesture?: SurfaceGesture): void {
  if (gesture && !gesture.current()) return
  markSessionSelectionAuthoritative(instanceId)
  writeActiveSession(instanceId, sessionId)
}

function setActiveParentSession(instanceId: string, parentSessionId: string, gesture?: SurfaceGesture): void {
  if (gesture && !gesture.current()) return
  batch(() => {
    markSessionSelectionAuthoritative(instanceId)
    writeActiveParentSession(instanceId, parentSessionId)
    writeActiveSession(instanceId, parentSessionId)
  })
}

export function selectActiveSession(instanceId: string, sessionId: string, gesture = beginGesture({ instanceId, sessionId })): void {
  setActiveSession(instanceId, sessionId, gesture)
}

export function selectActiveParentSession(instanceId: string, sessionId: string, gesture = beginGesture({ instanceId, sessionId })): void {
  setActiveParentSession(instanceId, sessionId, gesture)
}

function clearActiveParentSession(instanceId: string, gesture?: SurfaceGesture): void {
  if (gesture && !gesture.current()) return
  batch(() => {
    markSessionSelectionAuthoritative(instanceId)
    writeActiveParentSession(instanceId, null)
    writeActiveSession(instanceId, null)
  })
}

export function clearSelectedSession(instanceId: string): void {
  clearActiveParentSession(instanceId, beginGesture({ instanceId, sessionId: null }))
}

function clearActiveSession(instanceId: string): void {
  markSessionSelectionAuthoritative(instanceId)
  writeActiveSession(instanceId, null)
}

function hydrateActiveSessionSelection(
  instanceId: string,
  parentSessionId: string | null,
  sessionId: string | null,
  isCurrent: () => boolean = () => true,
): void {
  if (hasAuthoritativeSessionSelection(instanceId)) return
  batch(() => {
    if (!isCurrent()) return
    const selection = resolveRestoredSessionSelection(getSessions(instanceId), parentSessionId, sessionId)
    writeActiveParentSession(instanceId, selection?.parentSessionId ?? null)
    writeActiveSession(instanceId, sessionId === "info" && !parentSessionId ? "info" : selection?.activeSessionId ?? null)
  })
}

// Restore selection identity before HTTP hydration, without starting any
// session-scoped effects until the native session has actually been resolved.
function seedRestoredSessionSelection(instanceId: string, parentSessionId: string | null, sessionId: string | null): void {
  if (hasAuthoritativeSessionSelection(instanceId)) return
  batch(() => {
    const deleted = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
    const parent = parentSessionId && !deleted.has(parentSessionId) ? parentSessionId : null
    const active = parentSessionId && !parent || sessionId && deleted.has(sessionId) ? parent : sessionId
    writeActiveParentSession(instanceId, parent)
    writeSessionSelection(setActiveSessionId, instanceId, active)
  })
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

function setSessionStatus(
  instanceId: string,
  sessionId: string,
  status: SessionStatus,
  options: { retry?: SessionRetryState | null; force?: boolean } = {},
): void {
  withSession(instanceId, sessionId, (session) => {
    const admissionPending = session.generationAdmissionToken !== undefined && status === "idle"
    const generationRecovery = admissionPending
      ? "pending"
      : resolveAuthoritativeGenerationRecovery(session.generationRecovery, status)
    const retry = status === "working" ? options.retry ?? null : null
    const sameRetry = session.retry?.attempt === retry?.attempt
      && session.retry?.message === retry?.message
      && session.retry?.next === retry?.next
    if (
      session.status === status
      && sameRetry
      && session.runtimeStatusKnown === !admissionPending
      && (session.generationRecovery ?? null) === generationRecovery
      && (status === "idle" || session.outcome === undefined)
    ) return false
    if (session.status === "compacting" && status !== "compacting" && !options.force) return false
    const previous = session.status
    session.status = status
    session.runtimeStatusKnown = !admissionPending
    session.generationRecovery = generationRecovery
    if (status !== "idle") session.outcome = undefined
    if (!admissionPending) {
      cancelSessionGenerationAdmissions(instanceId, sessionId)
      session.generationAdmissionToken = undefined
    }
    session.idleSince = getIdleSinceForStatusTransition(previous, status, session.idleSince)
    session.retry = retry
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

export function getSessionCheckpoint(instanceId: string): object {
  return sessionCheckpoint(sessions().get(instanceId) ?? NO_SESSIONS)
}

export function getSessionTopology(instanceId: string): object {
  return sessionTopology(sessions().get(instanceId) ?? NO_SESSIONS)
}

function getParentSessions(instanceId: string): Session[] {
  const allSessions = getSessions(instanceId)
  return allSessions.filter((s) => getSessionRoot(instanceId, s.id)?.id === s.id)
}

function getChildSessions(instanceId: string, parentId: string): Session[] {
  const rows = sessions().get(instanceId)
  return rows ? childSessionIds(rows, parentId).map(id => rows.get(id)!) : []
}

function getDescendantSessions(instanceId: string, parentId: string): Session[] {
  const instanceSessions = sessions().get(instanceId)
  return instanceSessions ? getDescendantSessionsFromMap(instanceSessions, parentId) : []
}

function getSessionFamily(instanceId: string, parentId: string, held = sessions().get(instanceId)): Session[] {
  const parent = held?.get(parentId)
  if (!held || !parent) return []

  const children = getDescendantSessionsFromMap(held, parentId)
  return [parent, ...children]
}

function getSessionRoot(instanceId: string, sessionId: string): Session | null {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return null
  const directoryOnly = getDirectoryOnlyWorktree(instanceId)
  return getSessionRootFromMap(instanceSessions, sessionId, directoryOnly?.serviceDirectory ?? directoryOnly?.directory)
}

function buildSessionThreads(instanceId: string, rootIds: string[], childIds?: Set<string>): SessionThread[] {
  const instanceSessions = sessions().get(instanceId)
  const directoryOnly = getDirectoryOnlyWorktree(instanceId)
  return instanceSessions ? buildSessionThreadsFromMap(instanceSessions, rootIds, childIds, directoryOnly?.serviceDirectory ?? directoryOnly?.directory) : []
}

const sessionThreadProjections = new WeakMap<ReadonlyMap<string, Session>, {
  listed: ReadonlyMap<string, Session>; ids: string[]; directory?: string; threads: SessionThread[]
}>()
const sessionThreadRoots = new WeakMap<object, {
  listedTopology: object; ids: string[]; directory?: string; roots: string[]
}>()
const EMPTY_SESSION_THREADS: SessionThread[] = []

function getSessionThreads(instanceId: string): SessionThread[] {
  // A row under an ancestor outside the listed map is shown as a child whose
  // parent is missing is: not at all.
  const held = sessions().get(instanceId)
  const listed = getListedSessionMap(instanceId)
  if (!held?.size || !listed.size) return EMPTY_SESSION_THREADS
  const ids = sessionPagination().get(instanceId)?.ids
  if (!ids?.length) return EMPTY_SESSION_THREADS
  const directoryOnly = getDirectoryOnlyWorktree(instanceId)
  const directory = directoryOnly?.serviceDirectory ?? directoryOnly?.directory
  const cached = sessionThreadProjections.get(held)
  if (cached && cached.listed === listed && cached.ids === ids && cached.directory === directory) return cached.threads
  const topology = sessionTopology(held)
  const listedTopology = sessionTopology(listed)
  let rootProjection = sessionThreadRoots.get(topology)
  if (rootProjection?.listedTopology !== listedTopology || rootProjection.ids !== ids || rootProjection.directory !== directory) {
    rootProjection = { listedTopology, ids, directory, roots: projectSessionListIds(ids, held, directory).filter(id => listed.has(id)) }
    sessionThreadRoots.set(topology, rootProjection)
  }
  const threads = buildSessionThreadsFromMap(listed, rootProjection.roots, undefined, directory, true)
  sessionThreadProjections.set(held, { listed, ids, directory, threads })
  return threads
}

function getSessionSearchSessions(instanceId: string): Session[] {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return []
  const away = getMovedAwaySessions(instanceId)
  return getSessionSearchResultIds(instanceId).flatMap(id => {
    if (away.has(id)) return []
    const session = instanceSessions.get(id)
    return session ? [session] : []
  })
}

function isSessionExpanded(instanceId: string, sessionId: string): boolean {
  return Boolean(expandedSessions().get(instanceId)?.has(sessionId))
}

function setSessionExpanded(instanceId: string, sessionId: string, expanded: boolean): void {
  addAuthoritativeKey(setAuthoritativeSessionExpansionKeys, getDraftKey(instanceId, sessionId))
  setExpandedSessions((prev) => {
    const next = new Map(prev)
    const currentSet = next.get(instanceId) ?? new Set<string>()
    const updated = expanded ? new Set([sessionId, ...currentSet]) : new Set(currentSet)

    if (!expanded) {
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

function clearInstanceSessionExpansionState(instanceId: string): void {
  if (!instanceId) return
  const prefix = `${instanceId}:`
  setExpandedSessions((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setAuthoritativeSessionExpansionKeys((prev) => {
    const next = new Set([...prev].filter((key) => !key.startsWith(prefix)))
    return next.size === prev.size ? prev : next
  })
}

function hydrateSessionExpansion(instanceId: string, sessionIds: readonly string[]): void {
  const authoritative = getAuthoritativeSessionExpansionIdsForInstance(instanceId)
  const deleted = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
  const restored = sessionIds.filter((id) => !authoritative.has(id) && !deleted.has(id))
  setExpandedSessions((prev) => {
    const current = prev.get(instanceId)
    const expanded = new Set(restored)
    for (const id of current ?? []) if (authoritative.has(id) && !deleted.has(id)) expanded.add(id)
    if (current?.size === expanded.size && [...expanded].every((id) => current.has(id))) return prev
    const next = new Map(prev)
    if (expanded.size) next.set(instanceId, expanded)
    else next.delete(instanceId)
    return next
  })
  setAuthoritativeSessionExpansionKeys((prev) => {
    const next = new Set(prev)
    for (const id of sessions().get(instanceId)?.keys() ?? []) next.add(getDraftKey(instanceId, id))
    return next
  })
}

function toggleSessionExpanded(instanceId: string, sessionId: string): void {
  setSessionExpanded(instanceId, sessionId, !isSessionExpanded(instanceId, sessionId))
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
  for (const ancestorId of ancestorIds) {
    addAuthoritativeKey(setAuthoritativeSessionExpansionKeys, getDraftKey(instanceId, ancestorId))
  }
  setExpandedSessions((prev) => {
    const next = new Map(prev)
    const current = next.get(instanceId) ?? new Set<string>()
    const missing = ancestorIds.filter((ancestorId) => !current.has(ancestorId))
    if (missing.length === 0) return prev
    const expanded = new Set([...missing, ...current])
    next.set(instanceId, expanded)
    return next
  })
}

/**
 * Reveal a descendant's path below the conversation this instance is showing.
 * The list decides whether the visible row's activity transition warrants a reveal.
 */
function revealSubsession(instanceId: string, sessionId: string): void {
  const active = activeSessionId().get(instanceId)
  if (!active) return
  const ancestors = getSessionAncestorIds(instanceId, sessionId)
  const start = ancestors.indexOf(active)
  if (start < 0) return
  const path = ancestors.slice(start)
  const current = expandedSessions().get(instanceId)
  const missing = path.filter((id) => !current?.has(id))
  if (missing.length === 0) return
  for (const id of missing) addAuthoritativeKey(setAuthoritativeSessionExpansionKeys, getDraftKey(instanceId, id))
  setExpandedSessions((prev) => {
    const next = new Map(prev)
    next.set(instanceId, new Set([...missing, ...(prev.get(instanceId) ?? [])]))
    return next
  })
}

/** All expanded rows are restorable, whether opened manually or by activity. */
function getPersistentExpandedSessionIds(instanceId: string): string[] {
  return [...(expandedSessions().get(instanceId) ?? [])]
}

function getVisibleSessionIds(instanceId: string): string[] {
  const view = getSessionListView(instanceId)
  if (view.projected) {
    const known = sessions().get(instanceId)
    const scope = getWorkspaceSessionScope(instanceId)
    return view.ids.filter(id => known?.has(id) && (!scope || scope.has(id)))
  }
  const threads = projectUnarchivedSessionThreads(getSessionThreads(instanceId), activeSessionId().get(instanceId))
  if (threads.length === 0) return []

  const expanded = expandedSessions().get(instanceId)
  return collectVisibleSessionIds(threads, expanded)
}

function setActiveSessionFromList(instanceId: string, sessionId: string, gesture?: SurfaceGesture): void {
  if (gesture && !gesture.current()) return
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return
  const root = getSessionRoot(instanceId, sessionId) ?? session
  ensureSessionAncestorsExpanded(instanceId, sessionId)
  batch(() => {
    markSessionSelectionAuthoritative(instanceId)
    writeActiveParentSession(instanceId, root.id)
    writeActiveSession(instanceId, session.id)
  })
}

export function selectSessionFromList(instanceId: string, sessionId: string, gesture = beginGesture({ instanceId, sessionId })): void {
  setActiveSessionFromList(instanceId, sessionId, gesture)
}

function isSessionMessagesLoading(instanceId: string, sessionId: string): boolean {
  return Boolean(loading().loadingMessages.get(instanceId)?.has(sessionId))
}

/** The active view must start a load: neither loaded nor being loaded by anyone. */
function sessionMessagesNeedLoad(instanceId: string, sessionId: string): boolean {
  return !messagesLoaded().get(instanceId)?.has(sessionId) && !isSessionMessagesLoading(instanceId, sessionId)
}

function getSessionMessagesLoadError(instanceId: string, sessionId: string): string | undefined {
  return messageLoadErrors().get(instanceId)?.get(sessionId)
}

function getSessionListError(instanceId: string): string | undefined {
  return sessionListErrors().get(instanceId)
}

function setSessionListError(instanceId: string, error: string | null): void {
  setSessionListErrors((prev) => {
    const next = new Map(prev)
    if (error) {
      next.set(instanceId, error)
    } else {
      next.delete(instanceId)
    }
    return next
  })
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

function updateThreadTotalsForParents(instanceId: string, parentIds: Iterable<string>): void {
  const info = sessionInfoByInstance().get(instanceId)
  setThreadTotalsByInstance((prev) => {
    const instanceTotals = new Map(prev.get(instanceId))
    for (const parentId of parentIds) {
      instanceTotals.set(parentId, computeThreadTotals(getSessionFamily(instanceId, parentId), info))
    }
    return new Map(prev).set(instanceId, instanceTotals)
  })
}

function updateThreadTotalsForSession(instanceId: string, sessionId: string): void {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions?.has(sessionId)) return
  const familyIds = [...getSessionAncestorIdsFromMap(instanceSessions, sessionId), sessionId]
  updateThreadTotalsForParents(instanceId, familyIds)
}

const automaticCleanupRequests = new Map<string, {
  client: unknown
  generation: number
  signal: AbortSignal
  promise: Promise<void>
}>()

function cleanupBlankSessions(instanceId: string, excludeSessionId?: string, fetchIfNeeded = false): Promise<void> {
  const operation = captureBackendOperation(instanceId)
  if (fetchIfNeeded) return runSessionCleanup(instanceId, excludeSessionId, true)
  const client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const pending = automaticCleanupRequests.get(instanceId)
  if (pending?.client === client && pending?.generation === generation && pending.signal === operation.signal) return pending.promise

  // One bounded sweep per connection. Later creations are outside the captured
  // candidate set; they do not enqueue another full historical scan.
  const request = { client, generation, signal: operation.signal, promise: Promise.resolve() }
  request.promise = runSessionCleanup(instanceId, excludeSessionId, false).finally(() => {
    if (automaticCleanupRequests.get(instanceId) === request) automaticCleanupRequests.delete(instanceId)
  })
  automaticCleanupRequests.set(instanceId, request)
  return request.promise
}

async function runSessionCleanup(instanceId: string, excludeSessionId: string | undefined, fetchIfNeeded: boolean): Promise<void> {
  const operation = captureBackendOperation(instanceId)
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return
  const client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const candidates = Array.from(instanceSessions)
  const current = () => operation.current() && instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation

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
    if (!confirmed || !current()) return
  }

  // Bound native checks instead of fanning out one read per historical session.
  // Snapshot candidates so a concurrently created session is not swept up.
  let deletedCount = 0
  for (const [sessionId, session] of candidates) {
    if (!current()) break
    if (sessionId === excludeSessionId) continue
    if (sessions().get(instanceId)?.get(sessionId) !== session) continue
    if (await cleanupBlankSession(instanceId, sessionId)) deletedCount++
  }

  if (current() && deletedCount > 0) {
    showToastNotification({ category: "sessions",
      message: deletedCount === 1
        ? tGlobal("sessionState.cleanup.toast.one", { count: deletedCount })
        : tGlobal("sessionState.cleanup.toast.other", { count: deletedCount }),
      variant: "info"
    })
  }
}

export {
  sessions,
  setSessions,
  isSessionInWorkspaceScope,
  getListedSessionMap,
  activeSessionId,
  activeParentSessionId,
  agents,
  setAgents,
  agentCatalogLocations,
  setAgentCatalogLocations,
  providers,
  setProviders,
  loading,
  setLoading,
  messagesLoaded,
  setMessagesLoaded,
  getSessionListError,
  setSessionListError,
  advanceMessageLoadEpoch,
  isCurrentMessageLoad,
  getMessageLoadSignal,
  finishMessageLoad,
  clearMessageLoadingFlag,
  supersedeSessionMessageLoad,
  invalidateSessionMessageLoad,
  clearInstanceMessageLoads,
  setSessionMessagesLoadError,
  sessionInfoByInstance,
  setSessionInfoByInstance,
  threadTotalsByInstance,
  getThreadTotals,
  updateThreadTotalsForParents,
  updateThreadTotalsForSession,
  getSessionDraftPrompt,
  getSessionDraftPromptsForInstance,
  getAuthoritativeDraftSessionIdsForInstance,
  getAuthoritativelyDeletedSessionIdsForInstance,
  getAuthoritativeSessionExpansionIdsForInstance,
  markSessionDeletedAuthoritative,
  markSessionMovedAway,
  forgetSessionMovedAway,
  getMovedAwaySessions,
  getMovedAwaySessionIds,
  clearInstanceMovedAwaySessions,
  clearInstanceDeletedSessionAuthority,
  clearInstanceSessionExpansionState,
  hydrateSessionDraftPrompt,
  onSessionDraftHydrated,
  setSessionDraftPrompt,
  clearSessionDraftPrompt,
  clearInstanceDraftPromptValues,
  clearInstanceDraftPrompts,
  pruneDraftPrompts,
  withSession,
  setSessionPendingPermission,
  setSessionPendingForm,
  reconcileSessionPendingState,
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
  seedRestoredSessionSelection,
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
  getSessionSearchSessions,
  getVisibleSessionIds,
  expandedSessions,
  isSessionExpanded,
  setSessionExpanded,
  hydrateSessionExpansion,
  toggleSessionExpanded,
  ensureSessionExpanded,
  getSessionAncestorIds,
  ensureSessionAncestorsExpanded,
  revealSubsession,
  getPersistentExpandedSessionIds,
  setActiveSessionFromList,
  isSessionMessagesLoading,
  sessionMessagesNeedLoad,
  getSessionMessagesLoadError,
  getSessionInfo,
  cleanupBlankSessions,
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
