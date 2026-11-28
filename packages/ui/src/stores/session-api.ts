import { batch } from "solid-js"
import {
  getIdleSinceForStatusTransition,
  isSelectablePrimaryAgent,
  type Session,
} from "../types/session"
import type { Message } from "../types/message"
import type { Instance } from "../types/instance"
import { forkAfterMessage } from "./session-fork"
import { historyWindowCursor, historyWindowTarget, readHistoryWindow, MissingHistoryAnchorError } from "./history-window"
import { captureWorktreeMoveReconciliation, ensureWorktreesLoaded, getDirectoryOnlyWorktree, getGitRepoStatus, getWorktrees } from "./worktrees"
import { isWorkspaceServedDirectory } from "./workspace-served-directory"
import { SESSION_LOCATED_ELSEWHERE_REASON } from "../../../server/src/opencode/session-access-contract"
import { isWorkspaceSessionDirectory, selectWorkspaceSessionFamilies } from "./workspace-session-scope"
import { isSessionNotFoundError, type LocationRef, type SessionInfo as SDKSession, type SessionMessagesResponse } from "@opencode/client"

import { activeInstanceId, instances, reconcilePendingSessionIndicators, waitForInstanceReady } from "./instances"
import { prioritizedRead } from "../lib/prioritized-read"
import { preferences, setAgentModelPreference } from "./preferences"
import {
  activeSessionId,
  activeParentSessionId,
  agents,
  clearActiveSession,
  clearActiveParentSession,
  setActiveSession,
  setActiveSessionFromList,
  clearSessionDraftPrompt,
  evictSessionDraftPrompt,
  cancelSessionGenerationAdmissions,
  markSessionDeletedAuthoritative,
  markSessionMovedAway,
  forgetSessionMovedAway,
  getMovedAwaySessions,
  getAuthoritativelyDeletedSessionIdsForInstance,
  messagesLoaded,
  getSessionMessagesLoadError,
  providers,
  setAgents,
  setAgentCatalogLocations,
  setMessagesLoaded,
  advanceMessageLoadEpoch,
  finishMessageLoad,
  clearMessageLoadingFlag,
  getMessageLoadSignal,
  supersedeSessionMessageLoad,
  invalidateSessionMessageLoad,
  isCurrentMessageLoad,
  setSessionMessagesLoadError,
  setProviders,
  setSessionInfoByInstance,
  setSessions,
  sessions,
  getSessionRoot,
  withSession,
  loading,
  setLoading,
  cleanupBlankSessions,
  updateThreadTotalsForParents,
  setSessionPage,
  prependSessionListId,
  removeSessionListId,
  beginSessionSearch,
  clearSessionSearch,
  isLatestSessionSearch,
  isSessionSearchLoading,
  getSessionSearchResultIds,
  setSessionSearchResults,
  setSessionListError,
  setSessionExpanded,
  getSessionHasMore,
  getSessionNextCursor,
  getSessionListIds,
  sessionInfoByInstance,
} from "./session-state"
import { settleAbandonedSessionListRestoration, settleSessionListFirstPage } from "./session-list-restoration"
import { clearAttachments, deleteSessionAttachments } from "./attachments"
import { recoverRemovedSessionDraft } from "./session-draft-recovery"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getActiveCatalogLocation, getDefaultModel, isModelValid } from "./session-models"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2, reconcilePendingPermissionsV2 } from "./message-v2/bridge"
import { MESSAGE_STREAM_SCROLL_SCOPE, messageStoreBus } from "./message-v2/bus"
import { clearCacheForSession } from "../lib/global-cache"
import { getLogger } from "../lib/logger"
import { backendEvents } from "../lib/server-events"
import { getOpencodeErrorMessage } from "../lib/opencode-api"
import { buildProviderCatalog } from "../lib/model-catalog"
import { getRootClient } from "./opencode-client"
import { workspaceSessionPlacementHeaders } from "../lib/sdk-manager"
import { tGlobal } from "../lib/i18n"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
} from "./session-list-options"

const MAX_SESSION_LIST_PAGES = 1_000
import { getInstanceMetadata } from "./instance-metadata"
import {
  captureSessionPlacementEvidence, clearPendingSessionMove, confirmSessionPlacement, confirmedSessionListDirectory, getPendingSessionMove, isSessionMovePending, reconcileInterruptedSessionMoves,
  hasPendingSessionReturn, matchesSessionPlacement, retainConfirmedSessionPlacement, settleListedReturn,
} from "./session-events"
import { idleReadAdmissionEpoch, mergeFetchedSessionRuntimeState, reconcileFetchedSessionRuntime } from "./session-generation-recovery"
import { setPromptTranscript } from "./prompt-transcripts"
import { clearSessionSeenInterruption } from "./session-interruption-seen"
import { listMessageWindow } from "./session-message-pages"
import {
  MESSAGE_WINDOW_PAGE_SIZE,
  emptyLatestWindow,
  isLatestWindow,
  planNewerWindow,
  planOlderWindow,
  toWindowSnapshot,
  windowFromSnapshot,
  withOlderCursor,
  type MessageWindowState,
} from "./message-v2/message-window"
import { fetchCommands } from "./commands"
import { locationAuthorityKey, requestLocationOptions, toRequestLocation } from "./request-locations"
import {
  captureOpenCodeRowSnapshot, getOpenCodeInstanceGeneration, getOpenCodeMessageRevision, getOpenCodeMutationRevision,
  mergeOpenCodeLoadedPage, observeNonEventSettlement, seedOpenCodeSessionMessages,
} from "./opencode-data"
import { isSessionTranscriptVisible } from "./session-transcript-visibility"

const log = getLogger("api")
const sessionLog = getLogger("session")
const sessionListRequestIds = new Map<string, number>()
const restorePlacementReads = new Map<string, Set<() => boolean>>()
const searchMoveGuards = new Map<string, (sessionId: string) => void>()
const catalogLocations = new Map<string, string>()
const catalogRefreshes = new Map<string, { key: string; promise: Promise<void>; pending: boolean; current: () => boolean }>()
const agentRequestIds = new Map<string, number>()
const providerRequestIds = new Map<string, number>()
const agentRefreshes = new Map<string, { promise: Promise<boolean>; pending: boolean; cancelled: boolean; current: () => boolean }>()
const providerRefreshes = new Map<string, { promise: Promise<boolean>; pending: boolean; cancelled: boolean; current: () => boolean }>()
const sessionPageRequests = new Map<string, Promise<void>>()
const sessionExhaustionRequests = new Map<string, Promise<void>>()
const sessionRequestOwners = new WeakMap<Promise<void>, () => boolean>()
const sessionPageTraversals = new Map<string, { cursors: Set<string>; pages: number }>()
interface MessagePageRequest {
  controller: AbortController
  current: () => boolean
  consumers: Set<symbol>
  request: Promise<boolean>
}

const messagePageRequests = new Map<string, MessagePageRequest>()
const messageHistoryAuthorities = new Map<string, object>()
const deleteSessionAuthorities = new Map<string, { cleanup: boolean }>()
const MAX_LATEST_WINDOW_REVISION_RETRIES = 3
const LATEST_WINDOW_RETRY_DELAY_MS = 50
const MESSAGE_CURSOR_SEEK_LIMIT = 1000
type MessageWindowIntent = "open" | "older" | "newer" | "latest" | "oldest" | "around"
let nextSessionListRequestId = 0
let nextAgentRequestId = 0
let nextProviderRequestId = 0

function messagePageKey(instanceId: string, sessionId: string): string {
  return `${instanceId}\0${sessionId}`
}

function captureInstanceRequestAuthority(instanceId: string): () => boolean {
  const signal = backendEvents.signalForInstance(instanceId)
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const client = instances().get(instanceId)?.client
  return () => !signal?.aborted && getOpenCodeInstanceGeneration(instanceId) === generation
    && instances().get(instanceId)?.client === client
}

function beginMessageHistoryTraversal(instanceId: string, sessionId: string): () => void {
  const key = messagePageKey(instanceId, sessionId)
  const authority = {}
  messageHistoryAuthorities.set(key, authority)
  supersedeSessionMessageLoad(instanceId, sessionId)
  for (const requestKey of messagePageRequests.keys()) {
    if (requestKey.startsWith(`${key}\0`)) messagePageRequests.delete(requestKey)
  }
  return () => {
    if (messageHistoryAuthorities.get(key) !== authority) return
    messageHistoryAuthorities.delete(key)
    supersedeSessionMessageLoad(instanceId, sessionId)
  }
}

function invalidateMessageHistoryTraversal(instanceId: string, sessionId: string): void {
  const key = messagePageKey(instanceId, sessionId)
  messageHistoryAuthorities.delete(key)
  supersedeSessionMessageLoad(instanceId, sessionId)
  for (const requestKey of messagePageRequests.keys()) {
    if (requestKey.startsWith(`${key}\0`)) messagePageRequests.delete(requestKey)
  }
}

function catalogLocationKey(location: LocationRef): string {
  return locationAuthorityKey(location)
}

async function refreshSessionCatalog(instanceId: string, force = false): Promise<void> {
  const signal = backendEvents.signalForInstance(instanceId)
  if (signal.aborted) return
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  const client = instance.client
  const current = () => !signal.aborted && instances().get(instanceId)?.client === client
  const location = getActiveCatalogLocation(instanceId)
  const key = catalogLocationKey(location)
  if (!force && catalogLocations.get(instanceId) === key) return
  const existing = catalogRefreshes.get(instanceId)
  if (existing?.key === key && existing.current()) {
    if (force) existing.pending = true
    return existing.promise
  }
  const state = { key, promise: Promise.resolve(), pending: false, current }
  state.promise = (async () => {
    await waitForInstanceReady(instanceId)
    if (!current() || catalogRefreshes.get(instanceId) !== state
      || catalogLocationKey(getActiveCatalogLocation(instanceId)) !== key) return
    let refresh = force
    do {
      state.pending = false
      const generation = getOpenCodeInstanceGeneration(instanceId)
      const successes = await Promise.all([
        fetchAgents(instanceId, location, refresh),
        fetchProviders(instanceId, location, refresh),
        fetchCommands(instanceId, client, location),
      ])
      if (!current() || catalogRefreshes.get(instanceId) !== state) return
      if (successes.every(Boolean) && catalogLocationKey(getActiveCatalogLocation(instanceId)) === key) {
        catalogLocations.set(instanceId, key)
      }
      // The first connected marker can supersede this read without scheduling
      // reconnect recovery. Do not leave the composer with an empty catalogue.
      if (getOpenCodeInstanceGeneration(instanceId) !== generation) state.pending = true
      refresh = true
    } while (state.pending
      && current()
      && catalogRefreshes.get(instanceId) === state
      && catalogLocationKey(getActiveCatalogLocation(instanceId)) === key)
  })().finally(() => {
    if (catalogRefreshes.get(instanceId) === state) catalogRefreshes.delete(instanceId)
  })
  catalogRefreshes.set(instanceId, state)
  return state.promise
}

function beginSessionListRequest(instanceId: string): number {
  const requestId = ++nextSessionListRequestId
  sessionPageRequests.delete(instanceId)
  sessionExhaustionRequests.delete(instanceId)
  sessionListRequestIds.set(instanceId, requestId)
  return requestId
}

function isLatestSessionListRequest(instanceId: string, requestId: number): boolean {
  return sessionListRequestIds.get(instanceId) === requestId
}

function clearSessionListRequestState(instanceId: string): void {
  sessionListRequestIds.delete(instanceId)
  sessionPageRequests.delete(instanceId)
  sessionExhaustionRequests.delete(instanceId)
  sessionPageTraversals.delete(instanceId)
  setSessionListError(instanceId, null)
  setLoading((prev) => {
    if (!prev.fetchingSessions.has(instanceId)) return prev
    const fetchingSessions = new Map(prev.fetchingSessions)
    fetchingSessions.delete(instanceId)
    return { ...prev, fetchingSessions }
  })
}

function clearSessionCatalogState(instanceId: string): void {
  catalogLocations.delete(instanceId)
  catalogRefreshes.delete(instanceId)
  const prefix = `${instanceId}\0`
  for (const key of agentRequestIds.keys()) {
    if (key.startsWith(prefix)) agentRequestIds.delete(key)
  }
  for (const key of providerRequestIds.keys()) {
    if (key.startsWith(prefix)) providerRequestIds.delete(key)
  }
  for (const key of agentRefreshes.keys()) {
    if (!key.startsWith(prefix)) continue
    agentRefreshes.get(key)!.cancelled = true
    agentRefreshes.delete(key)
  }
  for (const key of providerRefreshes.keys()) {
    if (!key.startsWith(prefix)) continue
    providerRefreshes.get(key)!.cancelled = true
    providerRefreshes.delete(key)
  }
  for (const key of messagePageRequests.keys()) {
    if (key.startsWith(prefix)) messagePageRequests.delete(key)
  }
  for (const key of messageHistoryAuthorities.keys()) {
    if (key.startsWith(prefix)) messageHistoryAuthorities.delete(key)
  }
}

type V2SessionListOptions = {
  directory?: string
  search?: string
  cursor?: string
  project?: string
  subpath?: string
  parentID?: string | null
  order?: "asc" | "desc"
}

type ProjectSessionListResponse = {
  data: SDKSession[]
  complete: boolean
  nextCursor?: string
}

function getKnownParentId(session: SDKSession | Session): string | null | undefined {
  return (session as any).parentID ?? (session as Session).parentId
}

function hasMissingParentChain(session: SDKSession, loaded: Map<string, SDKSession | Session>): boolean {
  let current: SDKSession | Session = session
  const seen = new Set<string>()

  while (getKnownParentId(current)) {
    const parentId = getKnownParentId(current)
    if (!parentId) return false
    if (seen.has(parentId)) return false
    seen.add(parentId)
    const parent = loaded.get(parentId)
    if (!parent) return true
    current = parent
  }

  return false
}

async function fetchV2Sessions(
  instanceId: string,
  options: V2SessionListOptions,
  signal = backendEvents.signalForInstance(instanceId),
  visiblePage = false,
): Promise<ProjectSessionListResponse> {
  signal.throwIfAborted()
  const instanceClient = instances().get(instanceId)?.client
  const client = getRootClient(instanceId)
  const explicitGlobalDirectory = options.project === "global" && Boolean(options.directory)
  const project = options.project ?? (options.directory ? undefined : getInstanceMetadata(instanceId)?.project?.id)
  const scopedProject = explicitGlobalDirectory ? "global" : project === "global" ? undefined : project
  const directory = options.directory ?? instances().get(instanceId)?.folder
  const listOptions: V2SessionListOptions = options.cursor
    ? { cursor: options.cursor }
    : { ...options, project: scopedProject, directory, order: options.order ?? "desc" }
  if (scopedProject && !explicitGlobalDirectory) delete listOptions.directory

  const read = () => {
    signal.throwIfAborted()
    if (instances().get(instanceId)?.client !== instanceClient) return Promise.resolve({ data: [], cursor: {} })
    return client.session.list(buildProjectSessionListOptions(listOptions), { signal })
  }
  // Publish the visible directory/project page before secondary scans, while
  // historical cursor traversal continues within the shared background budget.
  const response = await prioritizedRead(
    () => (visiblePage || options.parentID === null) && activeInstanceId() === instanceId,
    signal ?? new AbortController().signal,
    read,
  )

  return {
    data: response.data,
    complete: !response.cursor?.next,
    nextCursor: response.cursor?.next ?? undefined,
  }
}

function getV2SessionItems(response: ProjectSessionListResponse): SDKSession[] {
  return response.data
}

async function fetchCompleteSessionInventory(
  instanceId: string,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
  publishFirstPage?: (sessions: SDKSession[]) => void,
): Promise<SDKSession[]> {
  const project = getInstanceMetadata(instanceId)?.project?.id
  if (!project) return []
  const inventory = new Map<string, SDKSession>()
  const directory = instances().get(instanceId)?.folder
  await ensureWorktreesLoaded(instanceId)
  if (!isCurrent()) return []
  signal?.throwIfAborted()
  const directoryOnly = getDirectoryOnlyWorktree(instanceId)
  if (!directoryOnly && getGitRepoStatus(instanceId) === null) throw new Error(tGlobal("sessionList.loadError.detail"))
  const listDirectory = (session: SDKSession) => confirmedSessionListDirectory(instanceId, session.id, session)
  const projectFamilies = (rows: SDKSession[]) => selectWorkspaceSessionFamilies(rows, directory ?? "", getWorktrees(instanceId), listDirectory)
  const scopes: V2SessionListOptions[] = [directoryOnly
    ? { directory: directoryOnly.serviceDirectory ?? directoryOnly.directory, order: "desc" }
    : { project, order: "desc" }]
  // V1 sessions can remain in the global project after migration while sharing this directory.
  if (!directoryOnly && project !== "global" && directory) scopes.push({ project: "global", directory, order: "desc" })

  for (const scope of scopes) {
    const seenCursors = new Set<string>()
    let pageCount = 1
    let response = await fetchV2Sessions(instanceId, scope, signal, Boolean(scope.project || directoryOnly))
    if ((scope.project || directoryOnly) && publishFirstPage) {
      await ensureWorktreesLoaded(instanceId)
      if (!isCurrent()) return []
      signal?.throwIfAborted()
      if (!getDirectoryOnlyWorktree(instanceId) && getGitRepoStatus(instanceId) === null) throw new Error(tGlobal("sessionList.loadError.detail"))
      // This is additive only. Absence/deletion is authoritative only after the
      // complete inventory; partial families still require verified membership.
      publishFirstPage(projectFamilies(response.data).filter(session =>
        listDirectory(session) || isWorkspaceServedDirectory(session.location.directory, directory ?? "", getWorktrees(instanceId))))
    }
    while (true) {
      if (!isCurrent()) return []
      for (const session of response.data) inventory.set(session.id, session)
      if (!response.nextCursor) break
      if (++pageCount > MAX_SESSION_LIST_PAGES) throw new Error("Session inventory exceeded the page limit")
      if (seenCursors.has(response.nextCursor)) throw new Error(`Repeated session cursor: ${response.nextCursor}`)
      seenCursors.add(response.nextCursor)
      response = await fetchV2Sessions(instanceId, { cursor: response.nextCursor }, signal)
    }
  }
  await ensureWorktreesLoaded(instanceId)
  if (!isCurrent()) return []
  signal?.throwIfAborted()
  if (!getDirectoryOnlyWorktree(instanceId) && getGitRepoStatus(instanceId) === null) throw new Error(tGlobal("sessionList.loadError.detail"))
  return projectFamilies(Array.from(inventory.values()))
}

function getDisconnectedCapturedSessionIds(
  captured: Map<string, Session>,
  current: Map<string, Session>,
  validRootIds: ReadonlySet<string>,
): string[] {
  const stale: string[] = []
  for (const sessionId of captured.keys()) {
    let currentId: string | null = sessionId
    const seen = new Set<string>()
    let valid = false
    while (currentId) {
      if (seen.has(currentId)) break
      seen.add(currentId)
      const session = current.get(currentId)
      if (!session) break
      if (validRootIds.has(session.id) || session.parentId === null) {
        valid = validRootIds.has(session.id)
        break
      }
      currentId = session.parentId
    }
    if (!valid) stale.push(sessionId)
  }
  return stale
}

function withActiveSessionState(
  instanceId: string,
  apiSession: SDKSession,
  existingSession: Session | undefined,
  activeSessions: Record<string, unknown> | null,
): Session {
  return withRuntimeStatus(toClientSessionV2(instanceId, apiSession, existingSession), existingSession, activeSessions)
}

function withRuntimeStatus(session: Session, existingSession: Session | undefined, activeSessions: Record<string, unknown> | null): Session {
  const reconciled = reconcileFetchedSessionRuntime(session, existingSession, activeSessions)
  return {
    ...reconciled,
    idleSince: getIdleSinceForStatusTransition(existingSession?.status, reconciled.status, existingSession?.idleSince),
  }
}

async function refreshSessionRuntimeStatus(instanceId: string, signal?: AbortSignal) {
  const attachment = backendEvents.signalForInstance(instanceId)
  signal = signal ? AbortSignal.any([attachment, signal]) : attachment
  if (signal.aborted) return
  const client = instances().get(instanceId)?.client
  if (!client) return
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  // Session maps are snapshots; retained rows protect the read across SSE.
  const captured = sessions().get(instanceId) ?? new Map<string, Session>()
  let active = await getRootClient(instanceId).session.active(signal ? { signal } : undefined)
  if (signal?.aborted || !generationCurrent() || instances().get(instanceId)?.client !== client) return
  // An active-only map cannot explain a run that settled during an SSE gap.
  // Read outcomes only for inactive rows whose completion needs reconciling,
  // with bounded concurrency so a large reconnect does not flood OpenCode.
  const pendingOutcomeIds = Array.from(captured).flatMap(([id, baseline]) =>
    Object.prototype.hasOwnProperty.call(active, id) || (baseline.status === "idle" && !baseline.generationRecovery)
      ? []
      : [id])
  const outcomes = new Map<string, SDKSession | null>()
  if (pendingOutcomeIds.length) {
    let cursor = 0
    const workerCount = Math.min(6, pendingOutcomeIds.length)
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < pendingOutcomeIds.length) {
        if (signal?.aborted || !generationCurrent() || instances().get(instanceId)?.client !== client) return
        const id = pendingOutcomeIds[cursor++]!
        try {
          const info = await getRootClient(instanceId).session.get({ sessionID: id }, signal ? { signal } : undefined)
          outcomes.set(id, info)
        } catch (error) {
          if (!signal?.aborted && generationCurrent()) log.warn("Failed to refresh session outcome", { instanceId, sessionId: id, error })
          outcomes.set(id, null)
        }
      }
    }))
  }
  if (signal?.aborted || !generationCurrent() || instances().get(instanceId)?.client !== client) return
  // Outcome is historical. Work may have restarted while its read was pending,
  // including without a delivered SSE event; the later activity read wins.
  if (outcomes.size) active = await getRootClient(instanceId).session.active(signal ? { signal } : undefined)
  if (signal?.aborted || !generationCurrent() || instances().get(instanceId)?.client !== client) return
  // A run the UI still believed working (or pending prompt admission) that the
  // final activity read does not list settled during an SSE gap; its terminal
  // event may never be delivered. The observation owes the transcript's
  // settlement read.
  const settledWithoutEvent: string[] = []
  setSessions(previous => {
    const held = previous.get(instanceId)
    if (!held) return previous
    let current: Map<string, Session> | undefined
    const update = (id: string, row: Session) => {
      current ??= new Map(held)
      current.set(id, row)
    }
    for (const [id, baseline] of captured) {
      const latest = held.get(id)
      if (!latest) continue
      const isInactive = !Object.prototype.hasOwnProperty.call(active, id)
      const info = outcomes.get(id)
      // Activity can release an acknowledged send's brief delivery hold even
      // if the historical outcome could not be read. Keep the rest of the row.
      if (outcomes.has(id) && !info && isInactive) {
        const epoch = idleReadAdmissionEpoch(baseline, latest)
        if (epoch !== latest.idleReadAdmissionEpoch) {
          update(id, { ...latest, idleReadAdmissionEpoch: epoch })
        }
        if (baseline.status === "working" && (latest === baseline || latest.status === "idle")) settledWithoutEvent.push(id)
        continue
      }
      // An unchanged, already-authoritative idle row needs neither a new
      // object nor publication. Unknown and unsettled rows still reconcile.
      if (latest === baseline && !info && isInactive
        && baseline.status === "idle" && baseline.runtimeStatusKnown && baseline.retry === null
        && baseline.generationRecovery === null && baseline.outcome !== "interrupted"
        && baseline.idleReadAdmissionEpoch === idleReadAdmissionEpoch(baseline)) continue
      const fetched = withRuntimeStatus(info ? toClientSessionV2(instanceId, info, baseline) : baseline, baseline, active)
      const merged = mergeFetchedSessionRuntimeState(fetched, baseline, latest)
      if (merged) {
        update(id, merged)
        if (isInactive && merged.status === "idle" && (
          baseline.status === "working"
          || (baseline.generationRecovery === "pending" && merged.generationRecovery !== "pending")
        )) {
          settledWithoutEvent.push(id)
        }
      }
    }
    return current ? new Map(previous).set(instanceId, current) : previous
  })
  reconcilePendingSessionIndicators(instanceId)
  for (const sessionId of settledWithoutEvent) {
    if (observeNonEventSettlement(instanceId, sessionId)) continue
    const store = messageStoreBus.getInstance(instanceId)
    const watched = activeSessionId().get(instanceId) === sessionId || isSessionTranscriptVisible(instanceId, sessionId)
    if (watched && isLatestWindow(store?.getMessageWindow(sessionId))) {
      void loadMessages(instanceId, sessionId, { force: true, signal }).catch((error) => {
        log.warn("Failed to refresh non-event settled session messages", { instanceId, sessionId, error })
      })
    } else if (messagesLoaded().get(instanceId)?.has(sessionId)) {
      invalidateSessionMessageLoad(instanceId, sessionId)
    }
  }
  return active
}

export function invalidateRestorePlacementRead(instanceId: string, sessionId: string): void {
  restorePlacementReads.delete(messagePageKey(instanceId, sessionId))
}

/** Parent reads and saved workspace references reconcile a typed departure. */
async function hydrateRestoredSessionChain(
  instanceId: string,
  requestedIds: Array<string | null | undefined>,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
  { verifyDrafts = false, reconcileDeparture = false, resolveListPlacement = false }:
    { verifyDrafts?: boolean; reconcileDeparture?: boolean; resolveListPlacement?: boolean } = {},
): Promise<ReadonlyMap<string, () => boolean>> {
  const attachment = backendEvents.signalForInstance(instanceId)
  signal ??= attachment
  // Keep the caller's logical signal at the SDK boundary; its fetch adapter
  // binds dispatch to the attachment. Queueing and settlement retain A here.
  const cancellation = signal === attachment ? attachment : AbortSignal.any([attachment, signal])
  const client = instances().get(instanceId)?.client
  const owns = isCurrent
  isCurrent = () => !cancellation.aborted && instances().get(instanceId)?.client === client && owns()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    cancellation.throwIfAborted()
    if (!isCurrent()) return new Map()
    const generationCurrent = captureInstanceRequestAuthority(instanceId)
    const releaseReads: Array<() => void> = []
    const absent = new Map<string, () => boolean>()
    try {
      await hydrateRestoredSessionChainAttempt(instanceId, requestedIds, releaseReads, signal, () => isCurrent() && generationCurrent(),
        cancellation, reconcileDeparture || resolveListPlacement, verifyDrafts ? absent : undefined, resolveListPlacement)
    } finally {
      for (const release of releaseReads) release()
    }
    cancellation.throwIfAborted()
    if (!isCurrent()) return new Map()
    if (generationCurrent()) return absent
  }
  throw new Error("Restored session hydration was superseded by reconnect")
}

async function hydrateRestoredSessionChainAttempt(
  instanceId: string,
  requestedIds: Array<string | null | undefined>,
  releaseReads: Array<() => void>,
  signal: AbortSignal,
  isCurrent: () => boolean,
  cancellation: AbortSignal,
  reconcileInitialDeparture = false,
  absentDrafts?: Map<string, () => boolean>,
  resolveListPlacement = false,
): Promise<void> {
  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  let reconcileDeparture = reconcileInitialDeparture
  const isRequestCurrent = () => generationCurrent() && isCurrent()
  const foreground = () => activeInstanceId() === instanceId
    && requestedIds.some(id => id && (id === activeSessionId().get(instanceId) || id === activeParentSessionId().get(instanceId)))
  let pending = requestedIds.filter((id): id is string => Boolean(id) && id !== "info")
  const visited = new Set<string>()
  const departures: Array<() => void> = []
  const ownedReads = new Map<string, () => boolean>()
  let readFailure: PromiseRejectedResult | undefined
  while (pending.length > 0) {
    if (!isRequestCurrent()) return
    cancellation.throwIfAborted()
    const level = [...new Set(pending)].filter((sessionId) => !visited.has(sessionId))
    pending = []
    level.forEach((sessionId) => visited.add(sessionId))
    const readOptions = { ...(signal ? { signal } : {}), ...(reconcileDeparture ? { headers: workspaceSessionPlacementHeaders } : {}) }
    reconcileDeparture = true
    const parents = await Promise.allSettled(level.map(async (sessionId) => {
      if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return null

      let session = sessions().get(instanceId)?.get(sessionId)
      const verify = absentDrafts !== undefined && requestedIds.includes(sessionId)
      const needsListPlacement = resolveListPlacement && session && requestedIds.includes(sessionId)
        && !isWorkspaceSessionDirectory(session.location.directory, instances().get(instanceId)?.folder ?? "", getWorktrees(instanceId))
        && !confirmedSessionListDirectory(instanceId, sessionId, session)
      if (!session || session.catalogSnapshot || needsListPlacement) {
        const captured = session
        const move = getPendingSessionMove(instanceId, sessionId)
        const evidenceCurrent = captureSessionPlacementEvidence(instanceId, sessionId)
        const capturedAway = getMovedAwaySessions(instanceId).get(sessionId)
        let placementReadCurrent: (() => boolean) | undefined
        if (readOptions.headers) {
          const key = messagePageKey(instanceId, sessionId)
          const reads = restorePlacementReads.get(key) ?? new Set<() => boolean>()
          const current = () => isRequestCurrent() && !signal?.aborted
            && restorePlacementReads.get(key) === reads
            && getPendingSessionMove(instanceId, sessionId) === move
          placementReadCurrent = current
          reads.add(current)
          restorePlacementReads.set(key, reads)
          releaseReads.push(() => {
            reads.delete(current)
            if (!reads.size && restorePlacementReads.get(key) === reads) restorePlacementReads.delete(key)
          })
        }
        try {
          cancellation.throwIfAborted()
          const read = () => isRequestCurrent()
            ? client.session.get({ sessionID: sessionId }, readOptions)
            : Promise.resolve(null)
          const apiSession = await prioritizedRead(foreground, cancellation, read)
          cancellation.throwIfAborted()
          if (!apiSession || !isRequestCurrent() || (placementReadCurrent && (!placementReadCurrent() || !evidenceCurrent()))) return null
          const listWorktreeSlug = "listWorktreeSlug" in apiSession && typeof apiSession.listWorktreeSlug === "string" ? apiSession.listWorktreeSlug : undefined
          const placement = { location: apiSession.location, projectID: apiSession.projectID, subpath: apiSession.subpath, listWorktreeSlug }
          const needsPlacementEvidence = Boolean(readOptions.headers)
            && (capturedAway !== undefined || listWorktreeSlug !== undefined
              || !isWorkspaceServedDirectory(apiSession.location.directory, instances().get(instanceId)?.folder ?? "", getWorktrees(instanceId)))
          batch(() => {
            if (!isRequestCurrent() || getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId) || signal?.aborted) return
            const prev = sessions()
            const next = new Map(prev)
            const instanceSessions = new Map(next.get(instanceId) ?? new Map())
            const latest = instanceSessions.get(sessionId)
            // A concurrent event or selection owns fields changed since this
            // read began, including when replacing a restored display row.
            const merged = mergeFetchedSessionRuntimeState(toClientSessionV2(instanceId, apiSession, captured), captured, latest)
            let returning = false
            if (merged) {
              // Publish the matching proof before the row notifies sidebar readers.
              if (needsPlacementEvidence && getPendingSessionMove(instanceId, sessionId) === move && matchesSessionPlacement(merged, placement)) {
                const away = getMovedAwaySessions(instanceId)
                returning = !move && capturedAway !== undefined && away.get(sessionId) === capturedAway
                if (!away.has(sessionId) || returning) {
                  confirmSessionPlacement(instanceId, sessionId, placement, returning ? capturedAway : undefined)
                }
              }
              instanceSessions.set(sessionId, merged)
            }
            next.set(instanceId, instanceSessions)
            setSessions(next)
            if (returning) settleListedReturn(instanceId, sessionId)
          })
          session = sessions().get(instanceId)?.get(sessionId)
          const ownsPlacement = () => isRequestCurrent() && !signal?.aborted
            && getPendingSessionMove(instanceId, sessionId) === move
            && !getMovedAwaySessions(instanceId).has(sessionId)
            && !getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)
            && matchesSessionPlacement(sessions().get(instanceId)?.get(sessionId), placement)
          ownedReads.set(sessionId, ownsPlacement)
        } catch (error) {
          if (cancellation.aborted) throw error
          if (!isRequestCurrent()) return null
          const missing = isSessionNotFoundError(error)
          if (!missing && !absentDrafts) throw error
          if (missing && error.sessionID === sessionId && "reason" in error && error.reason === SESSION_LOCATED_ELSEWHERE_REASON) {
            departures.push(() => {
              // Catalogue merges are display updates, not fresh ownership evidence.
              if (!evidenceCurrent() || placementReadCurrent?.() === false
                || getPendingSessionMove(instanceId, sessionId) !== move
                || getMovedAwaySessions(instanceId).has(sessionId)
                || getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return
              clearPendingSessionMove(instanceId, sessionId)
              markSessionMovedAway(instanceId, sessionId, null)
              removeSessionProjection(instanceId, sessionId, (selectedId) => ownedReads.get(selectedId)?.() ?? false)
            })
          } else if (verify && missing && error.sessionID === sessionId) {
            const holds = () => isRequestCurrent() && !signal?.aborted && evidenceCurrent()
              && getPendingSessionMove(instanceId, sessionId) === move
              && !getMovedAwaySessions(instanceId).has(sessionId)
              && sessions().get(instanceId)?.get(sessionId) === captured
            if (placementReadCurrent?.() !== false && holds()) absentDrafts.set(sessionId, holds)
          }
          log.warn("Failed to hydrate restored session", { instanceId, sessionId, error })
          return null
        }
      }
      // In directory-only mode ancestors outside the inventory are not session
      // authority. Keep native parent metadata; local display roots are derived.
      const directoryOnly = getDirectoryOnlyWorktree(instanceId)
      if (session && (directoryOnly || session.parentId === null) && isRequestCurrent() && !signal?.aborted) {
        const root = getSessionRoot(instanceId, sessionId)
        if (root && !getSessionListIds(instanceId).includes(root.id)) prependSessionListId(instanceId, root.id)
      }
      return directoryOnly ? null : session?.parentId ?? null
    }))
    readFailure = parents.find(result => result.status === "rejected")
    if (readFailure) break
    pending = parents.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : [])
  }
  // A selected local child may finish loading after its parent's refusal.
  cancellation.throwIfAborted()
  if (!isRequestCurrent()) return
  batch(() => {
    for (const depart of departures) depart()
    // A verified return can rejoin its family once its ancestors are loaded.
    for (const id of visited) settleListedReturn(instanceId, id)
  })
  if (readFailure) throw readFailure.reason
}

async function ensureV2ParentChainsLoaded(
  instanceId: string,
  apiSessions: SDKSession[],
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return
  if (getDirectoryOnlyWorktree(instanceId)) return
  const currentSessions = sessions().get(instanceId) ?? new Map<string, Session>()
  const loaded = new Map<string, SDKSession | Session>(currentSessions)
  for (const session of apiSessions) loaded.set(session.id, session)

  const missingChains = apiSessions
    .filter((session) => hasMissingParentChain(session, loaded))
    .map((session) => session.parentID)
  if (missingChains.length > 0) await hydrateRestoredSessionChain(instanceId, missingChains, signal, isCurrent, { reconcileDeparture: true })
}

/** An exact move read owns placement even if it settles before this page returns. */
function captureCatalogMoveGuard(instanceId: string) {
  const protectedIds = new Set(reconcileInterruptedSessionMoves(instanceId))
  const protects = (id: string) => {
    if (isSessionMovePending(instanceId, id)) protectedIds.add(id)
    return protectedIds.has(id)
  }
  return protects
}

async function fetchSessions(instanceId: string, options?: {
  reset?: boolean
  strictStatus?: boolean
  projectMetadata?: Promise<void>
  registerInvalidation?: (invalidate: () => void) => void
  signal?: AbortSignal
}): Promise<void> {
  const attachment = backendEvents.signalForInstance(instanceId)
  options = { ...options, signal: options?.signal ? AbortSignal.any([attachment, options.signal]) : attachment }
  options.signal!.throwIfAborted()
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const requestId = beginSessionListRequest(instanceId)
  const capturedAway = getMovedAwaySessions(instanceId)
  const capturedSelection = [activeParentSessionId().get(instanceId), activeSessionId().get(instanceId)]
  const worktreeMoveProject = getInstanceMetadata(instanceId)?.project?.id
  const reconcileWorktreeMoves = captureWorktreeMoveReconciliation(instanceId)
  const client = instance.client
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const isCurrent = () => isLatestSessionListRequest(instanceId, requestId)
    && instances().get(instanceId)?.client === client
    && generationCurrent()
    && !options?.signal?.aborted
  options?.registerInvalidation?.(() => {
    if (!isLatestSessionListRequest(instanceId, requestId)) return
    clearSessionListRequestState(instanceId)
    // No request will write a terminal loading state now. Settle restoration
    // without claiming a loaded list, so deferred panels still start.
    if (instances().get(instanceId)?.client === client) settleAbandonedSessionListRestoration(instanceId)
  })

  setLoading((prev) => {
    const next = { ...prev }
    next.fetchingSessions.set(instanceId, true)
    return next
  })
  setSessionListError(instanceId, null)

  try {
    const sessionListOptions = { ...(instance.folder ? { directory: instance.folder } : {}), parentID: null as null, order: "desc" as const }
    const protects = captureCatalogMoveGuard(instanceId)
    const existingSessions = new Map(sessions().get(instanceId) ?? new Map<string, Session>())
    const existingCatalogIds = new Set(getSessionListIds(instanceId))

    log.info("session.list", { instanceId, limit: PROJECT_SESSION_LIST_LIMIT, directory: sessionListOptions.directory })
    // The runtime-status map must never gate list publication: it fans out to
    // per-session native reads on the server and has stalled lists for 10+s.
    // Publish the directory page as soon as it arrives, then patch statuses.
    const response = await fetchV2Sessions(instanceId, sessionListOptions, options?.signal)
    if (!isCurrent()) {
      if (options?.strictStatus) throw new Error("Foreground session refresh was superseded")
      return
    }
    const rootApiSessions = getV2SessionItems(response)
    const publishPartialPage = (page: SDKSession[]) => {
      page = page.filter(session => !protects(session.id))
      const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
      setSessions((prev) => {
        const next = new Map(prev)
        const instanceSessions = new Map(next.get(instanceId) ?? new Map())
        for (const apiSession of page) {
          const existingSession = existingSessions.get(apiSession.id)
          const fetched = withActiveSessionState(instanceId, apiSession, existingSession, null)
          const merged = mergeFetchedSessionRuntimeState(
            fetched,
            existingSession,
            instanceSessions.get(apiSession.id),
            deletedSessionIds.has(apiSession.id),
          )
          if (merged) {
            // Rows introduced by this request belong to its reconciliation
            // baseline, not to the concurrent SSE/local-creation exception.
            if (!instanceSessions.has(apiSession.id)) {
              existingSessions.set(apiSession.id, merged)
              if (merged.parentId === null) existingCatalogIds.add(apiSession.id)
            }
            instanceSessions.set(apiSession.id, merged)
          }
        }
        next.set(instanceId, instanceSessions)
        return next
      })
      // This directory page is only a partial view of the workspace. Keep
      // existing worktree rows until the project inventory can reconcile them.
      setSessionPage(
        instanceId,
        page.filter((session) => !session.parentID && !deletedSessionIds.has(session.id)).map((session) => session.id),
        Boolean(response.nextCursor),
        false,
        response.nextCursor,
      )
    }
    publishPartialPage(rootApiSessions)
    // Directory rows need neither project identity nor checkout discovery.
    // Only the complete family reconciliation depends on that metadata.
    await options?.projectMetadata
    if (!isCurrent()) {
      if (options?.strictStatus) throw new Error("Foreground session refresh was superseded")
      return
    }
    settleSessionListFirstPage(instanceId)
    const hasProjectInventory = Boolean(getInstanceMetadata(instanceId)?.project?.id)
    let inventory: SDKSession[] = []
    let inventoryComplete = false
    try {
      inventory = await fetchCompleteSessionInventory(instanceId, options?.signal, isCurrent, publishPartialPage)
      inventoryComplete = hasProjectInventory
    } catch (error) {
      if (options?.signal?.aborted) throw error
      if (options?.strictStatus) throw error
      log.warn("Failed to enrich the session list with project descendants", { instanceId, error })
    }
    if (!isCurrent()) {
      if (options?.strictStatus) throw new Error("Foreground session refresh was superseded")
      return
    }
    const rootIdsFromPage = new Set(rootApiSessions.map((session) => session.id))
    const apiSessions = [...rootApiSessions, ...inventory.filter((session) => !rootIdsFromPage.has(session.id))]
      .filter(session => !protects(session.id))
    // Read current activity after the historical outcomes, never use an earlier
    // idle map as proof that an execution with an old outcome is still idle.
    const activePromise = getRootClient(instanceId).session.active(options?.signal ? { signal: options.signal } : undefined).catch((error) => {
      log.warn("Failed to refresh active sessions", { instanceId, error })
      return null
    })
    const sessionMap = new Map<string, Session>()

    for (const apiSession of apiSessions) {
      const existingSession = existingSessions?.get(apiSession.id)
      sessionMap.set(apiSession.id, withActiveSessionState(instanceId, apiSession, existingSession, null))
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(next.get(instanceId) ?? new Map())
      const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
      for (const session of sessionMap.values()) {
        const capturedSession = existingSessions.get(session.id)
        const latestSession = instanceSessions.get(session.id)
        const merged = mergeFetchedSessionRuntimeState(
          session,
          capturedSession,
          latestSession,
          deletedSessionIds.has(session.id),
        )
        if (merged) instanceSessions.set(session.id, merged)
      }
      next.set(instanceId, instanceSessions)
      return next
    })
    // A session read at a directory this workspace serves is no longer located elsewhere.
    const currentAway = getMovedAwaySessions(instanceId)
    const worktrees = getWorktrees(instanceId)
    for (const session of apiSessions) {
      if (currentAway.has(session.id) && capturedAway.get(session.id) === currentAway.get(session.id)
        && !hasPendingSessionReturn(instanceId, session.id)
        && isWorkspaceServedDirectory(session.location.directory, instance.folder, worktrees)) {
        forgetSessionMovedAway(instanceId, session.id)
      }
    }
    await ensureV2ParentChainsLoaded(instanceId, apiSessions, options?.signal, isCurrent)
    if (!isCurrent()) {
      if (options?.strictStatus) throw new Error("Foreground session refresh was superseded")
      return
    }

    if (inventoryComplete) {
      const authoritativeSessions = apiSessions
      const fetchedRootIds = new Set(authoritativeSessions.flatMap((session) => {
        const root = getSessionRoot(instanceId, session.id)
        return root ? [root.id] : []
      }))
      const concurrentRootIds = new Set(Array.from(sessions().get(instanceId)?.values() ?? [])
        .filter((session) => !existingSessions.has(session.id) && getSessionRoot(instanceId, session.id)?.id === session.id)
        .map((session) => session.id))
      const validRootIds = new Set([...fetchedRootIds, ...concurrentRootIds])
      // Retaining a protected root also retains its held family.
      for (const id of existingSessions.keys()) {
        if (!protects(id)) continue
        const root = getSessionRoot(instanceId, id)
        if (root) validRootIds.add(root.id)
      }
      const currentSessions = sessions().get(instanceId) ?? new Map()
      const revalidations = new Map<string, () => Promise<void>>()
      const retainPlacement = (id: string, session: Session | undefined) =>
        [...(restorePlacementReads.get(messagePageKey(instanceId, id)) ?? [])].some(current => current())
          || retainConfirmedSessionPlacement(instanceId, id, session, revalidations, isCurrent, options?.signal)
      // Catalogue containment cannot settle a verified return waiting on its checkout.
      for (const { id } of apiSessions) {
        if (hasPendingSessionReturn(instanceId, id) && !protects(id)) retainPlacement(id, currentSessions.get(id))
      }
      const staleIds = new Set(getDisconnectedCapturedSessionIds(existingSessions, currentSessions, validRootIds))
      const fetchedIds = new Set(authoritativeSessions.map(session => session.id))
      // Parents may live outside the enumerated project after a native move.
      // Keep every ancestor needed to connect a verified surviving descendant.
      for (const id of [...fetchedIds]) {
        let parent = currentSessions.get(id)?.parentId
        while (parent && !fetchedIds.has(parent)) {
          fetchedIds.add(parent)
          // Family membership retains the row, not its previous placement.
          if (!protects(parent)) retainPlacement(parent, currentSessions.get(parent))
          parent = currentSessions.get(parent)?.parentId
        }
      }
      for (const [id, captured] of existingSessions) {
        // A saved child can disappear while its root survives. Only a complete
        // owned inventory can evict that display row; concurrent updates win.
        if (captured.catalogSnapshot && !fetchedIds.has(id) && currentSessions.get(id) === captured) staleIds.add(id)
      }
      for (const sessionId of staleIds) {
        const current = currentSessions.get(sessionId)
        if (current !== existingSessions.get(sessionId) || protects(sessionId)
          || retainPlacement(sessionId, current)) continue
        // An absent row may still exist in another workspace.
        removeSessionProjection(instanceId, sessionId)
      }

      // Native project IDs span clones. Let a pending move reconcile first;
      // otherwise use the merged placement, which retains newer move metadata.
      for (const { id, location } of inventory) {
        const directory = currentSessions.get(id)?.location.directory
        if (protects(id) || directory !== location.directory
          || isWorkspaceServedDirectory(directory, instance.folder, worktrees)
          || retainPlacement(id, currentSessions.get(id))) continue
        if (!getMovedAwaySessions(instanceId).has(id)) markSessionMovedAway(instanceId, id, directory)
        if (capturedSelection.includes(id) || activeParentSessionId().get(instanceId) === id || activeSessionId().get(instanceId) === id) {
          removeSessionProjection(instanceId, id)
        }
      }
      if (revalidations.size) {
        await Promise.all([...revalidations.values()].map(revalidate => revalidate()))
        if (!isCurrent()) {
          if (options?.strictStatus) throw new Error("Foreground session refresh was superseded")
          return
        }
      }
    }
    const rootIds: string[] = []
    const seenRootIds = new Set<string>()
    const missingRootSessionIds: string[] = []
    for (const apiSession of apiSessions) {
      const root = getSessionRoot(instanceId, apiSession.id)
      if (root) {
        if (!seenRootIds.has(root.id)) {
          seenRootIds.add(root.id)
          rootIds.push(root.id)
        }
      } else if (apiSession.parentID) {
        missingRootSessionIds.push(apiSession.id)
      }
    }
    // Reconciliation already evicted absent roots. Retain survivors, including
    // concurrent updates which fenced an inventory eviction.
    for (const sessionId of existingCatalogIds) {
      const session = sessions().get(instanceId)?.get(sessionId)
      if (session && getSessionRoot(instanceId, sessionId)?.id === sessionId && !seenRootIds.has(sessionId)) {
        seenRootIds.add(sessionId)
        rootIds.push(sessionId)
      }
    }
    const concurrentRootIds = getSessionListIds(instanceId).filter((sessionId) => {
      const session = sessions().get(instanceId)?.get(sessionId)
      return !existingCatalogIds.has(sessionId) && session && getSessionRoot(instanceId, sessionId)?.id === sessionId && !seenRootIds.has(sessionId)
    })
    for (let index = concurrentRootIds.length - 1; index >= 0; index -= 1) {
      const sessionId = concurrentRootIds[index]!
      seenRootIds.add(sessionId)
      rootIds.unshift(sessionId)
    }

    if (missingRootSessionIds.length > 0) {
      log.warn("Some V2 session list items could not be attached to a loaded root", {
        instanceId,
        sessionIds: missingRootSessionIds,
      })
    }

    setSessionPage(instanceId, rootIds, Boolean(response.nextCursor), inventoryComplete && (options?.reset ?? true), response.nextCursor)
    sessionPageTraversals.set(instanceId, {
      cursors: new Set(response.nextCursor ? [response.nextCursor] : []),
      pages: 1,
    })
    updateThreadTotalsForParents(instanceId, rootIds)

    reconcilePendingSessionIndicators(instanceId)

    // Patch runtime statuses without gating the published list on them.
    const statusUpdate = activePromise.then((activeSessions) => {
      if (!activeSessions || !isCurrent()) return
      setSessions((prev) => {
        const next = new Map(prev)
        const instanceSessions = new Map(next.get(instanceId) ?? new Map())
        for (const apiSession of apiSessions) {
          if (protects(apiSession.id)) continue
          const current = instanceSessions.get(apiSession.id)
          if (!current) continue
          const captured = existingSessions.get(apiSession.id)
          // Unknown rows published by this HTTP read have no earlier snapshot.
          // Rows established by SSE or a local admission already own authority.
          if (!captured && (current.runtimeStatusKnown || current.generationAdmissionToken !== undefined)) continue
          const patched = withRuntimeStatus(current, captured ?? current, activeSessions)
          const merged = mergeFetchedSessionRuntimeState(patched, captured ?? current, current)
          if (merged) instanceSessions.set(apiSession.id, merged)
        }
        next.set(instanceId, instanceSessions)
        return next
      })
      reconcilePendingSessionIndicators(instanceId)
      if (inventoryComplete && worktreeMoveProject && worktreeMoveProject !== "global" && getInstanceMetadata(instanceId)?.project?.id === worktreeMoveProject
        && !getDirectoryOnlyWorktree(instanceId)) reconcileWorktreeMoves()
    })
    if (options?.strictStatus) await statusUpdate
    if (!isCurrent()) return

    setMessagesLoaded((prev) => {
      const next = new Map(prev)
      const loadedSet = next.get(instanceId)
      if (loadedSet) {
        const filtered = new Set<string>()
        for (const id of loadedSet) {
          if (sessions().get(instanceId)?.has(id)) {
            filtered.add(id)
          }
        }
        next.set(instanceId, filtered)
      }
      return next
    })
  } catch (error) {
    const aborted = options?.signal?.aborted === true
    if (!aborted) log.error("Failed to fetch sessions:", error)
    if (!aborted && isCurrent()) {
      setSessionListError(instanceId, getOpencodeErrorMessage(error, tGlobal("sessionList.loadError.detail")))
    }
    throw error
  } finally {
    if (isLatestSessionListRequest(instanceId, requestId)) {
      // The first server.connected marker can arrive after startup began its
      // HTTP read. It advances projection authority without a disconnect, so the
      // reconnect gate will not schedule recovery. Replace that obsolete read
      // instead of leaving an empty, uninitialized catalogue spinning forever.
      // A newer request, disposal, abort or strict foreground recovery owns its
      // own outcome and must not be restarted here.
      if (!generationCurrent() && instances().get(instanceId)?.client === client
        && !options?.signal?.aborted && !options?.strictStatus) {
        return fetchSessions(instanceId, options)
      }
      setLoading((prev) => {
        const next = { ...prev }
        next.fetchingSessions.set(instanceId, false)
        return next
      })
    }
  }
}

async function loadMoreSessions(instanceId: string): Promise<void> {
  const current = captureInstanceRequestAuthority(instanceId)
  if (!current()) return
  const pending = sessionPageRequests.get(instanceId)
  if (pending && sessionRequestOwners.get(pending)?.()) return pending
  const request = loadNextSessionPage(instanceId).finally(() => {
    if (sessionPageRequests.get(instanceId) === request) sessionPageRequests.delete(instanceId)
  })
  sessionPageRequests.set(instanceId, request)
  sessionRequestOwners.set(request, current)
  return request
}

async function loadAllSessions(instanceId: string): Promise<void> {
  const current = captureInstanceRequestAuthority(instanceId)
  if (!current()) return
  const pending = sessionExhaustionRequests.get(instanceId)
  if (pending && sessionRequestOwners.get(pending)?.()) return pending
  const listRequestId = sessionListRequestIds.get(instanceId)
  const request = (async () => {
    setSessionListError(instanceId, null)
    try {
      while (getSessionHasMore(instanceId)) {
        if (!current()) return
        const cursor = getSessionNextCursor(instanceId)
        await loadMoreSessions(instanceId)
        if (!current()) return
        if (sessionListRequestIds.get(instanceId) !== listRequestId) return
        if (getSessionHasMore(instanceId) && getSessionNextCursor(instanceId) === cursor) {
          throw new Error("Session pagination was interrupted")
        }
      }
    } catch (error) {
      if (!current()) return
      if (sessionListRequestIds.get(instanceId) !== listRequestId) return
      setSessionListError(instanceId, getOpencodeErrorMessage(error, tGlobal("sessionList.loadError.detail")))
      throw error
    }
  })().finally(() => {
    if (sessionExhaustionRequests.get(instanceId) === request) sessionExhaustionRequests.delete(instanceId)
  })
  sessionExhaustionRequests.set(instanceId, request)
  sessionRequestOwners.set(request, current)
  return request
}

async function loadNextSessionPage(instanceId: string): Promise<void> {
  const signal = backendEvents.signalForInstance(instanceId)
  if (signal.aborted) return
  const cursor = getSessionNextCursor(instanceId)
  if (!cursor) return
  const instance = instances().get(instanceId)
  if (!instance?.client) throw new Error("Instance not ready")
  const client = instance.client
  const listRequestId = sessionListRequestIds.get(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const isCurrent = () => instances().get(instanceId)?.client === client
    && sessionListRequestIds.get(instanceId) === listRequestId
    && generationCurrent()
  const protects = captureCatalogMoveGuard(instanceId)
  const capturedSessions = new Map(sessions().get(instanceId) ?? [])
  const [response, activeSessions] = await Promise.all([
    fetchV2Sessions(instanceId, { cursor }, signal),
    getRootClient(instanceId).session.active({ signal }).catch((error) => {
      log.warn("Failed to refresh active sessions", { instanceId, error })
      return null
    }),
  ])
  if (!isCurrent() || getSessionNextCursor(instanceId) !== cursor) return
  const traversal = sessionPageTraversals.get(instanceId) ?? { cursors: new Set([cursor]), pages: 1 }
  if (traversal.pages >= MAX_SESSION_LIST_PAGES) throw new Error("Session pagination exceeded the page limit")
  if (response.nextCursor && traversal.cursors.has(response.nextCursor)) {
    throw new Error(`Repeated session cursor: ${response.nextCursor}`)
  }
  traversal.pages += 1
  if (response.nextCursor) traversal.cursors.add(response.nextCursor)
  sessionPageTraversals.set(instanceId, traversal)
  const pageSessions = response.data.filter(item => !protects(item.id))
  const deleted = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
  setSessions((previous) => {
    const next = new Map(previous)
    const current = new Map(next.get(instanceId) ?? [])
    for (const item of pageSessions) {
      if (!deleted.has(item.id)) {
        const captured = capturedSessions.get(item.id)
        const fetched = withActiveSessionState(instanceId, item, captured, activeSessions)
        const merged = mergeFetchedSessionRuntimeState(fetched, captured, current.get(item.id), false)
        if (merged) current.set(item.id, merged)
      }
    }
    next.set(instanceId, current)
    return next
  })
  await ensureV2ParentChainsLoaded(instanceId, pageSessions, signal, isCurrent)
  if (!isCurrent() || getSessionNextCursor(instanceId) !== cursor) return
  const roots = pageSessions.filter((item) => !item.parentID).map((item) => item.id)
  for (const item of pageSessions) {
    const root = getSessionRoot(instanceId, item.id)
    if (root && !roots.includes(root.id)) roots.push(root.id)
  }
  setSessionPage(instanceId, roots, Boolean(response.nextCursor), false, response.nextCursor)
  updateThreadTotalsForParents(instanceId, roots)
}

export function excludeMissingMoveFromSearch(instanceId: string, sessionId: string): void {
  searchMoveGuards.get(instanceId)?.(sessionId)
}

async function searchSessions(instanceId: string, query: string): Promise<void> {
  const signal = backendEvents.signalForInstance(instanceId)
  if (signal.aborted) return
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return

  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const requestId = beginSessionSearch(instanceId, trimmedQuery)
  const client = instance.client
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const isCurrent = () => isLatestSessionSearch(instanceId, trimmedQuery, requestId)
    && instances().get(instanceId)?.client === client
    && generationCurrent()
  // A settled move leaves the pending map, but still outranks this search.
  const missingMoves = new Set<string>()
  const excludeMissingMove = (id: string) => {
    if (isCurrent()) missingMoves.add(id)
  }
  searchMoveGuards.set(instanceId, excludeMissingMove)

  try {
    const protects = captureCatalogMoveGuard(instanceId)
    const capturedSessions = new Map(sessions().get(instanceId) ?? [])
    log.info("v2.session.search", { instanceId, query: trimmedQuery, directory: instance.folder })
    await ensureWorktreesLoaded(instanceId, signal)
    if (!isCurrent()) return
    const results = new Map<string, SDKSession>()
    const worktreeDirectories = getInstanceMetadata(instanceId)?.project?.id === "global"
      ? [] : getWorktrees(instanceId).map(entry => entry.serviceDirectory ?? entry.directory)
    const directories = new Set([instance.folder, ...worktreeDirectories])
    for (const directory of directories) {
      if (!isCurrent()) return
      let response = await fetchV2Sessions(instanceId, { search: trimmedQuery, directory }, signal)
      const cursors = new Set<string>()
      let pageCount = 1
      while (true) {
        if (!isCurrent()) return
        for (const session of getV2SessionItems(response)) results.set(session.id, session)
        if (!response.nextCursor) break
        if (++pageCount > MAX_SESSION_LIST_PAGES) throw new Error("Session search exceeded the page limit")
        if (cursors.has(response.nextCursor)) throw new Error(`Repeated session cursor: ${response.nextCursor}`)
        cursors.add(response.nextCursor)
        response = await fetchV2Sessions(instanceId, { cursor: response.nextCursor }, signal)
      }
    }
    const searchResults = Array.from(results.values())

    if (searchResults.length === 0) {
      setSessionSearchResults(instanceId, trimmedQuery, [], requestId)
      return
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(next.get(instanceId) ?? new Map())
      const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)

      for (const apiSession of searchResults) {
        if (deletedSessionIds.has(apiSession.id) || missingMoves.has(apiSession.id) || protects(apiSession.id)) continue
        const captured = capturedSessions.get(apiSession.id)
        const fetched = toClientSessionV2(instanceId, apiSession, captured)
        const merged = mergeFetchedSessionRuntimeState(fetched, captured, instanceSessions.get(apiSession.id))
        if (merged) instanceSessions.set(apiSession.id, merged)
      }

      next.set(instanceId, instanceSessions)
      return next
    })
    if (!isCurrent()) return

    const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
    const currentSessions = sessions().get(instanceId)
    const currentSearchResults = searchResults.filter(({ id }) =>
      !deletedSessionIds.has(id) && !missingMoves.has(id) && (!protects(id) || currentSessions?.has(id)))

    setSessionSearchResults(instanceId, trimmedQuery, currentSearchResults.map((session) => session.id), requestId)
  } catch (error) {
    log.error("Failed to search sessions:", error)
    if (isCurrent()) {
      clearSessionSearch(instanceId)
    }
    throw error
  } finally {
    if (searchMoveGuards.get(instanceId) === excludeMissingMove) searchMoveGuards.delete(instanceId)
    if (isLatestSessionSearch(instanceId, trimmedQuery, requestId) && isSessionSearchLoading(instanceId)) {
      setSessionSearchResults(instanceId, trimmedQuery, getSessionSearchResultIds(instanceId), requestId)
    }
  }
}

function toClientSessionV2(instanceId: string, apiSession: SDKSession, existingSession?: Session): Session {
  return {
    id: apiSession.id,
    instanceId,
    title: apiSession.title || existingSession?.title || "Untitled",
    parentId: apiSession.parentID || null,
    agent: apiSession.agent ?? existingSession?.agent ?? "",
    model: apiSession.model
      ? {
          providerId: apiSession.model.providerID,
          modelId: apiSession.model.id,
        }
      : existingSession?.model ?? { providerId: "", modelId: "" },
    status: existingSession?.status ?? "idle",
    retry: existingSession?.retry ?? null,
    idleSince: existingSession?.idleSince ?? null,
    generationRecovery: existingSession?.generationRecovery ?? null,
    runtimeStatusKnown: existingSession?.runtimeStatusKnown ?? false,
    generationAdmissionToken: existingSession?.generationAdmissionToken,
    generationAdmissionEpoch: existingSession?.generationAdmissionEpoch,
    generationAdmissionIdleBoundary: existingSession?.generationAdmissionIdleBoundary,
    idleReadAdmissionEpoch: existingSession?.idleReadAdmissionEpoch,
    outcome: apiSession.outcome,
    cost: apiSession.cost,
    tokens: apiSession.tokens,
    location: apiSession.location,
    projectID: apiSession.projectID,
    subpath: apiSession.subpath,
    metadata: apiSession.metadata ?? existingSession?.metadata,
    time: {
      ...apiSession.time,
    },
    revert: apiSession.revert,
    pendingPermission: existingSession?.pendingPermission,
    pendingForm: existingSession?.pendingForm,
  }
}

function isCreatingSession(instanceId: string): boolean {
  return loading().creatingSession.get(instanceId) === true
}

// Creations can overlap (the sidebar's and the draft composer's first send):
// the instance stays busy until the last one settles.
const creationsInFlight = new Map<string, { count: number; current: () => boolean }>()

function trackCreation(instanceId: string, current: () => boolean): () => void {
  const previous = creationsInFlight.get(instanceId)
  const state = previous?.current() ? previous : { count: 0, current }
  state.count++
  creationsInFlight.set(instanceId, state)
  setLoading((prev) => {
    const next = { ...prev }
    next.creatingSession.set(instanceId, true)
    return next
  })
  return () => {
    if (creationsInFlight.get(instanceId) !== state) return
    if (--state.count === 0) creationsInFlight.delete(instanceId)
    setLoading(prev => {
      const next = { ...prev }
      next.creatingSession.set(instanceId, state.count > 0)
      return next
    })
  }
}

async function createSession(instanceId: string, agent?: string, location?: { directory: string }): Promise<Session> {
  const attachment = backendEvents.signalForInstance(instanceId)
  attachment.throwIfAborted()
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }
  const activeId = activeSessionId().get(instanceId)
  const activeLocation = location ?? (activeId && activeId !== "info"
    ? sessions().get(instanceId)?.get(activeId)?.location
    : undefined)
  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)

  // Pending spans the whole flow — catalog/config reads included — so a slow
  // network shows feedback from the first click instead of silence. There is
  // deliberately no client-side timeout and no coalescing here: session.create
  // is not idempotent, an aborted request may still commit server-side and
  // arrive later through the session.created event, so a slow creation stays
  // visibly in progress until the request settles one way or the other, each
  // call sends its own request, and repeated UI triggers are deduplicated by
  // the startNewSession action instead.
  const creationCurrent = () => !attachment.aborted && instances().get(instanceId)?.client === instance.client
  const finishCreation = trackCreation(instanceId, creationCurrent)

  try {
    const needsAgents = !agents().has(instanceId)
    const needsProviders = !providers().has(instanceId)
    if (needsAgents || needsProviders) {
      await Promise.all([
        needsAgents && fetchAgents(instanceId),
        needsProviders && fetchProviders(instanceId),
      ])
      if (!generationCurrent()) throw new Error("Session creation was superseded by reconnect")
    }
    const selectedAgent = agent || agents().get(instanceId)?.find(isSelectablePrimaryAgent)?.id || ""
    const defaultModel = await getDefaultModel(instanceId, selectedAgent)
    if (!generationCurrent()) throw new Error("Session creation was superseded by reconnect")

    if (selectedAgent && isModelValid(instanceId, defaultModel)) {
      await setAgentModelPreference(instanceId, selectedAgent, defaultModel)
      if (!generationCurrent()) throw new Error("Session creation was superseded by reconnect")
    }

    log.info(`[HTTP] POST /session.create for instance ${instanceId}`)
    const info = await client.session.create({
      agent: selectedAgent || null,
      model: defaultModel.providerId && defaultModel.modelId
        ? { providerID: defaultModel.providerId, id: defaultModel.modelId }
        : null,
      location: { directory: activeLocation?.directory ?? instance.folder },
    }, requestLocationOptions(activeLocation))
    if (!generationCurrent()) throw new Error("Session creation was superseded by reconnect")
    const session = toClientSessionV2(instanceId, info)
    session.agent = selectedAgent
    session.model = defaultModel

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(prev.get(instanceId))
      instanceSessions.set(session.id, session)
      next.set(instanceId, instanceSessions)
      return next
    })

    prependSessionListId(instanceId, session.id)

    const instanceProviders = providers().get(instanceId) || []
    const initialProvider = instanceProviders.find((p) => p.id === session.model.providerId)
    const initialModel = initialProvider?.models.find((m) => m.id === session.model.modelId)
    const initialContextWindow = initialModel?.limit?.context ?? 0
    const initialInputLimit = initialModel?.limit?.input ?? 0
    const initialSubscriptionModel = initialModel?.cost?.input === 0 && initialModel?.cost?.output === 0
    const initialOutputLimit =
      initialModel?.limit?.output && initialModel.limit.output > 0
        ? initialModel.limit.output
        : DEFAULT_MODEL_OUTPUT_LIMIT
    const initialContextAvailable = initialInputLimit > 0 ? initialInputLimit : initialContextWindow > 0 ? initialContextWindow : null

    setSessionInfoByInstance((prev) => {
      const next = new Map(prev)
      const instanceInfo = new Map(prev.get(instanceId))
      instanceInfo.set(session.id, {
        cost: 0,
        contextWindow: initialContextWindow,
        isSubscriptionModel: Boolean(initialSubscriptionModel),
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        actualUsageTokens: 0,
        modelOutputLimit: initialOutputLimit,
        contextAvailableTokens: initialContextAvailable,
      })
      next.set(instanceId, instanceInfo)
      return next
    })

    if (preferences().autoCleanupBlankSessions) {
      // Candidate capture is synchronous, but cleanup must not delay activation
      // or the first send while unloaded historical sessions are checked.
      void cleanupBlankSessions(instanceId, session.id).catch(error => {
        log.warn("Automatic blank-session cleanup failed", error)
      })
    }

    return session
  } catch (error) {
    log.error("Failed to create session:", error)
    throw error
  } finally {
    finishCreation()
  }
}

async function forkSession(
  instanceId: string,
  sourceSessionId: string,
  options?: { afterMessageId?: string },
): Promise<Session> {
  backendEvents.signalForInstance(instanceId).throwIfAborted()
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }
  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)

  const request = {
    sessionID: sourceSessionId,
  }

  log.info(`[HTTP] POST /session.fork for instance ${instanceId}`, request)
  const info = options?.afterMessageId
    ? await forkAfterMessage(client, sourceSessionId, options.afterMessageId, generationCurrent)
    : await client.session.fork(request)
  if (!generationCurrent()) throw new Error("Session fork was superseded by reconnect")
  const forkedSession = toClientSessionV2(instanceId, info)

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = new Map(prev.get(instanceId))
    instanceSessions.set(forkedSession.id, forkedSession)
    next.set(instanceId, instanceSessions)
    return next
  })


  if (!forkedSession.parentId) prependSessionListId(instanceId, forkedSession.id)

  const instanceProviders = providers().get(instanceId) || []
  const forkProvider = instanceProviders.find((p) => p.id === forkedSession.model.providerId)
  const forkModel = forkProvider?.models.find((m) => m.id === forkedSession.model.modelId)
  const forkContextWindow = forkModel?.limit?.context ?? 0
  const forkInputLimit = forkModel?.limit?.input ?? 0
  const forkSubscriptionModel = forkModel?.cost?.input === 0 && forkModel?.cost?.output === 0
  const forkOutputLimit =
    forkModel?.limit?.output && forkModel.limit.output > 0 ? forkModel.limit.output : DEFAULT_MODEL_OUTPUT_LIMIT
  const forkContextAvailable = forkInputLimit > 0 ? forkInputLimit : forkContextWindow > 0 ? forkContextWindow : null

  setSessionInfoByInstance((prev) => {
    const next = new Map(prev)
    const instanceInfo = new Map(prev.get(instanceId))
    instanceInfo.set(forkedSession.id, {
      cost: 0,
      contextWindow: forkContextWindow,
      isSubscriptionModel: Boolean(forkSubscriptionModel),
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      actualUsageTokens: 0,
      modelOutputLimit: forkOutputLimit,
      contextAvailableTokens: forkContextAvailable,
    })
    next.set(instanceId, instanceInfo)
    return next
  })

  return forkedSession
}

async function deleteSession(instanceId: string, sessionId: string): Promise<void> {
  await removeSession(instanceId, sessionId, false)
}

export function deleteBlankSession(instanceId: string, sessionId: string, signal: AbortSignal): Promise<boolean> {
  return removeSession(instanceId, sessionId, true, signal)
}

async function removeSession(instanceId: string, sessionId: string, cleanup: boolean, signal?: AbortSignal): Promise<boolean> {
  const attachment = backendEvents.signalForInstance(instanceId)
  const live = signal ? AbortSignal.any([attachment, signal]) : attachment
  live.throwIfAborted()
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }
  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const loadingKey = messagePageKey(instanceId, sessionId)
  const loadingAuthority = { cleanup }
  deleteSessionAuthorities.set(loadingKey, loadingAuthority)

  setLoading((prev) => {
    const next = { ...prev }
    const deleting = next.deletingSession.get(instanceId) || new Set()
    deleting.add(sessionId)
    next.deletingSession.set(instanceId, deleting)
    return next
  })

  try {
    log.info(`[HTTP] DELETE /session.remove for instance ${instanceId}`, { sessionId })
    if (cleanup) {
      if (!(await backendOf(instanceId).api.cleanupSession(instanceId, sessionId, live)).deleted) return false
    } else {
      await client.session.remove({ sessionID: sessionId })
    }
    if (attachment.aborted || !generationCurrent()) throw new Error("Session deletion was superseded by reconnect")

    removeSessionRuntimeState(instanceId, sessionId)
    return true

  } catch (error) {
    log.error("Failed to delete session:", error)
    throw error
  } finally {
    if (deleteSessionAuthorities.get(loadingKey) === loadingAuthority) {
      deleteSessionAuthorities.delete(loadingKey)
      setLoading((prev) => {
        const next = { ...prev }
        const deleting = next.deletingSession.get(instanceId)
        if (deleting) {
          deleting.delete(sessionId)
        }
        return next
      })
    }
  }
}

/** Apply a confirmed native deletion, whether requested here or observed. */
function removeSessionRuntimeState(instanceId: string, sessionId: string, source: "request" | "observation" = "request"): void {
  const requested = deleteSessionAuthorities.get(messagePageKey(instanceId, sessionId))
  const preserve = requested?.cleanup ?? (source === "observation")
  if (preserve) recoverRemovedSessionDraft(instanceId, sessionId)
  markSessionDeletedAuthoritative(instanceId, sessionId)
  setPromptTranscript(instanceId, sessionId, undefined)
  forgetSessionMovedAway(instanceId, sessionId)
  clearPendingSessionMove(instanceId, sessionId)
  if (preserve) {
    deleteSessionAttachments(instanceId, sessionId)
    evictSessionDraftPrompt(instanceId, sessionId)
  } else {
    clearAttachments(instanceId, sessionId)
    clearSessionDraftPrompt(instanceId, sessionId)
  }
  removeSessionProjection(instanceId, sessionId)
}

/** Removes the session from this instance's list, selection and transcript
 * caches only; its draft, attachments and other per-session state stay. */
function removeSessionProjection(instanceId: string, sessionId: string, ownsSelection?: (sessionId: string) => boolean): void {
  cancelSessionGenerationAdmissions(instanceId, sessionId)
  clearSessionSeenInterruption(instanceId, sessionId)
  setSessionExpanded(instanceId, sessionId, false)
  setSessions((prev) => {
    const held = prev.get(instanceId)
    if (!held?.has(sessionId)) return prev
    const next = new Map(prev)
    const instanceSessions = new Map(held)
    instanceSessions.delete(sessionId)
    if (instanceSessions.size === 0) next.delete(instanceId)
    else next.set(instanceId, instanceSessions)
    return next
  })

  removeSessionListId(instanceId, sessionId)

  // Drop normalized message state and caches for this session.
  const pageKey = messagePageKey(instanceId, sessionId)
  for (const requestKey of messagePageRequests.keys()) {
    if (requestKey.startsWith(`${pageKey}\0`)) messagePageRequests.delete(requestKey)
  }
  messageHistoryAuthorities.delete(pageKey)
  messageStoreBus.getOrCreate(instanceId).clearSession(sessionId)
  clearCacheForSession(instanceId, sessionId)

  setSessionInfoByInstance((prev) => {
    const next = new Map(prev)
    const instanceInfo = next.get(instanceId)
    if (instanceInfo) {
      const updatedInstanceInfo = new Map(instanceInfo)
      updatedInstanceInfo.delete(sessionId)
      if (updatedInstanceInfo.size === 0) {
        next.delete(instanceId)
      } else {
        next.set(instanceId, updatedInstanceInfo)
      }
    }
    return next
  })

  const parent = activeParentSessionId().get(instanceId), active = activeSessionId().get(instanceId)
  if (sessionId === parent) {
    const selected = active && sessions().get(instanceId)?.get(active)
    const away = getMovedAwaySessions(instanceId)
    if (away.has(sessionId) && selected && !away.has(selected.id)
      && (ownsSelection?.(selected.id)
        || isWorkspaceServedDirectory(selected.location.directory, instances().get(instanceId)?.folder ?? "", getWorktrees(instanceId)))) {
      setActiveSessionFromList(instanceId, selected.id)
    } else clearActiveParentSession(instanceId)
  } else if (sessionId === active) {
    if (parent && sessions().get(instanceId)?.has(parent)) setActiveSession(instanceId, parent)
    else clearActiveSession(instanceId)
  }
}

function fetchAgents(instanceId: string, location = getActiveCatalogLocation(instanceId), refresh = false): Promise<boolean> {
  const current = captureInstanceRequestAuthority(instanceId)
  const key = `${instanceId}\0${catalogLocationKey(location)}`
  const existing = agentRefreshes.get(key)
  if (existing?.current()) {
    if (refresh) existing.pending = true
    return existing.promise
  }
  const state = { promise: Promise.resolve(false), pending: false, cancelled: false, current }
  state.promise = (async () => {
    let result: boolean
    do {
      if (!current()) return false
      state.pending = false
      result = await loadAgents(instanceId, location)
    } while (current() && state.pending && !state.cancelled)
    return result
  })().finally(() => {
    if (agentRefreshes.get(key) === state) agentRefreshes.delete(key)
  })
  agentRefreshes.set(key, state)
  return state.promise
}

async function loadAgents(instanceId: string, location: LocationRef): Promise<boolean> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }
  const rootClient = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const requestKey = `${instanceId}\0${catalogLocationKey(location)}`
  const requestId = ++nextAgentRequestId
  agentRequestIds.set(requestKey, requestId)

  try {
    log.info(`[HTTP] GET /agent.list for instance ${instanceId}`)
    const requestLocation = toRequestLocation(location)
    const response = await rootClient.agent.list({ location: requestLocation }, requestLocationOptions(location))
    if (!generationCurrent()) return false
    const agentsById = new Map((response.data ?? []).map((agent) => [agent.id, agent]))
    await Promise.all(["build", "plan"].filter((id) => !agentsById.has(id)).map(async (id) => {
      if (!generationCurrent()) return
      try {
        const result = await rootClient.agent.get({ agentID: id, location: requestLocation }, requestLocationOptions(location))
        agentsById.set(result.data.id, result.data)
      } catch (error) {
        log.warn("Failed to fetch built-in agent", { instanceId, agentId: id, error })
      }
    }))
    // Native agent.list puts the resolved default first; creation uses that order.
    const agentList = Array.from(agentsById.values()).map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description || "",
      mode: agent.mode,
      hidden: agent.hidden,
      model: agent.model?.id
        ? {
            providerId: agent.model.providerID || "",
            modelId: agent.model.id,
          }
        : undefined,
    }))

    if (!generationCurrent() || agentRequestIds.get(requestKey) !== requestId || catalogLocationKey(getActiveCatalogLocation(instanceId)) !== catalogLocationKey(location)) return false
    setAgents((prev) => {
      const next = new Map(prev)
      next.set(instanceId, agentList)
      return next
    })
    if (!generationCurrent()) return false
    setAgentCatalogLocations((prev) => new Map(prev).set(instanceId, catalogLocationKey(location)))
    return true
  } catch (error) {
    log.error("Failed to fetch agents:", error)
    return false
  }
}

function fetchProviders(instanceId: string, location = getActiveCatalogLocation(instanceId), refresh = false): Promise<boolean> {
  const current = captureInstanceRequestAuthority(instanceId)
  const key = `${instanceId}\0${catalogLocationKey(location)}`
  const existing = providerRefreshes.get(key)
  if (existing?.current()) {
    if (refresh) existing.pending = true
    return existing.promise
  }
  const state = { promise: Promise.resolve(false), pending: false, cancelled: false, current }
  state.promise = (async () => {
    let result: boolean
    do {
      if (!current()) return false
      state.pending = false
      result = await loadProviders(instanceId, location)
    } while (current() && state.pending && !state.cancelled)
    return result
  })().finally(() => {
    if (providerRefreshes.get(key) === state) providerRefreshes.delete(key)
  })
  providerRefreshes.set(key, state)
  return state.promise
}

async function loadProviders(instanceId: string, location: LocationRef): Promise<boolean> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }
  const rootClient = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const requestKey = `${instanceId}\0${catalogLocationKey(location)}`
  const requestId = ++nextProviderRequestId
  providerRequestIds.set(requestKey, requestId)

  try {
    log.info(`[HTTP] GET /provider.list for instance ${instanceId}`)
    const request = { location: toRequestLocation(location) }
    const [response, models, defaultModel] = await Promise.all([
      rootClient.provider.list(request, requestLocationOptions(location)),
      rootClient.model.list(request, requestLocationOptions(location)),
      rootClient.model.default(request, requestLocationOptions(location)),
    ])
    const providerList = buildProviderCatalog(response.data, models.data, defaultModel.data)

    if (!generationCurrent() || providerRequestIds.get(requestKey) !== requestId || catalogLocationKey(getActiveCatalogLocation(instanceId)) !== catalogLocationKey(location)) return false
    setProviders((prev) => {
      const next = new Map(prev)
      next.set(instanceId, providerList)
      return next
    })
    return true
  } catch (error) {
    log.error("Failed to fetch providers:", error)
    return false
  }
}

function currentMessageWindow(instanceId: string, sessionId: string): MessageWindowState {
  const store = messageStoreBus.getOrCreate(instanceId)
  return store.getMessageWindow(sessionId) ?? windowFromSnapshot(store.getScrollSnapshot(sessionId, MESSAGE_STREAM_SCROLL_SCOPE))
}

function planMessageWindowLoad(
  current: MessageWindowState,
  intent: MessageWindowIntent,
): { cursor?: string; order?: "asc" | "desc"; next: MessageWindowState; forward?: boolean; seekNewer?: string } | null {
  if (intent === "older") return planOlderWindow(current)
  if (intent === "newer") return planNewerWindow(current)
  if (intent === "latest") return { next: emptyLatestWindow() }
  if (intent === "oldest") {
    return { order: "asc", next: { kind: "history", newerCursors: [] } }
  }
  if (current.kind !== "history") return { next: emptyLatestWindow() }
  const forward = !current.newerCursors.includes(null)
  return { cursor: current.resumeCursor, next: { ...current }, ...(forward ? { forward: true } : {}) }
}

function commitMessageWindow(
  instanceId: string,
  sessionId: string,
  window: MessageWindowState,
  intent: MessageWindowIntent,
  anchorMessageId?: string,
) {
  const store = messageStoreBus.getOrCreate(instanceId)
  store.setMessageWindow(sessionId, window)
  const existing = store.getScrollSnapshot(sessionId, MESSAGE_STREAM_SCROLL_SCOPE)
  const preservePosition = intent === "open"
  const atBottom = intent === "older" || intent === "latest"
  store.setScrollSnapshot(sessionId, MESSAGE_STREAM_SCROLL_SCOPE, {
    scrollTop: preservePosition ? existing?.scrollTop ?? 0 : 0,
    atBottom: preservePosition ? existing?.atBottom ?? window.kind === "latest" : atBottom,
    scrollRatio: preservePosition ? existing?.scrollRatio : undefined,
    maxScrollTop: preservePosition ? existing?.maxScrollTop : undefined,
    anchorKey: anchorMessageId ?? (preservePosition ? existing?.anchorKey : undefined),
    anchorOffset: anchorMessageId ? 0 : preservePosition ? existing?.anchorOffset : undefined,
    followModeType: preservePosition ? existing?.followModeType : intent === "latest" ? "following" : "escaped",
    ...toWindowSnapshot(window),
  })
}

function markSessionMessagesLoaded(instanceId: string, sessionId: string) {
  setMessagesLoaded((prev) => {
    const next = new Map(prev)
    const loadedSet = next.get(instanceId) || new Set()
    loadedSet.add(sessionId)
    next.set(instanceId, loadedSet)
    return next
  })
}

type MessageLoadOptions = {
  force?: boolean
  intent?: MessageWindowIntent
  registerInvalidation?: (invalidate: () => void) => void
  signal?: AbortSignal
  revisionRetry?: number
  anchorMessageId?: string
}

async function loadMessages(
  instanceId: string,
  sessionId: string,
  options?: MessageLoadOptions,
): Promise<boolean> {
  const attachment = backendEvents.signalForInstance(instanceId)
  if (attachment.aborted) return false
  options = { ...options, signal: options?.signal ? AbortSignal.any([attachment, options.signal]) : attachment }
  const force = options?.force ?? false
  const intent = options?.intent ?? "open"
  const revisionRetry = options?.revisionRetry ?? 0
  const store = messageStoreBus.getOrCreate(instanceId)
  const storedWindow = store.getMessageWindow(sessionId)
  let expectedWindow = storedWindow
  const snapshot = store.getScrollSnapshot(sessionId, MESSAGE_STREAM_SCROLL_SCOPE)
  const currentWindow = storedWindow ?? windowFromSnapshot(snapshot)
  const planned: ReturnType<typeof planMessageWindowLoad> = options?.anchorMessageId
    ? { cursor: historyWindowCursor({ kind: "around", messageID: options.anchorMessageId }), next: currentWindow }
    : planMessageWindowLoad(currentWindow, intent)
  if (!planned) return false

  const alreadyLoaded = messagesLoaded().get(instanceId)?.has(sessionId)
  if (alreadyLoaded && !force) {
    if (!sessionInfoByInstance().get(instanceId)?.has(sessionId)) updateSessionInfo(instanceId, sessionId)
    return false
  }

  const previousError = getSessionMessagesLoadError(instanceId, sessionId)
  if (previousError && !force) return false

  const isLoading = loading().loadingMessages.get(instanceId)?.has(sessionId)
  if (isLoading && !force) return false

  const instance = instances().get(instanceId)
  if (!instance || !instance.client) throw new Error("Instance not ready")

  const instanceClient = instance.client
  const client = getRootClient(instanceId)
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) throw new Error("Session not found")

  const loadEpoch = advanceMessageLoadEpoch(instanceId, sessionId)
  const loadSignal = getMessageLoadSignal(instanceId, sessionId)!
  const signal = options?.signal ? AbortSignal.any([loadSignal, options.signal]) : loadSignal
  const historyAuthority = messageHistoryAuthorities.get(messagePageKey(instanceId, sessionId))
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const mutationRevision = getOpenCodeMutationRevision(instanceId, sessionId)
  const ownsLoadState = () => instances().get(instanceId)?.client === instanceClient
    && isCurrentMessageLoad(instanceId, sessionId, loadEpoch)
    && sessions().get(instanceId)?.has(sessionId) === true
    && generationCurrent()
    && (!historyAuthority || messageHistoryAuthorities.get(messagePageKey(instanceId, sessionId)) === historyAuthority)
  const isCurrentLoad = () => ownsLoadState() && options?.signal?.aborted !== true
  const isCurrent = () => isCurrentLoad()
    && getOpenCodeMutationRevision(instanceId, sessionId) === mutationRevision
    && store.getMessageWindow(sessionId) === expectedWindow
  const commitCurrentWindow = (window: MessageWindowState, windowIntent: MessageWindowIntent) => {
    commitMessageWindow(instanceId, sessionId, window, windowIntent, options?.anchorMessageId)
    expectedWindow = store.getMessageWindow(sessionId)
  }
  options?.registerInvalidation?.(() => {
    if (isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) invalidateSessionMessageLoad(instanceId, sessionId)
  })
  const messageRevision = store.getSessionRevision(sessionId)
  const liveMessageRevision = getOpenCodeMessageRevision(instanceId, sessionId)
  // A first latest-window load has no resident rows a mid-stream page could
  // rewind: it merges its page with the rows streamed during the fetch instead
  // of retrying on revision conflicts. Reloads and history windows keep them.
  const initialSeed = !storedWindow && currentWindow.kind === "latest" && planned.next.kind === "latest"
    && !planned.cursor && store.getSessionMessageIds(sessionId).length === 0
  const rowSnapshot = initialSeed ? captureOpenCodeRowSnapshot(instanceId, sessionId) : undefined
  let retryAfterRevisionConflict = false
  let committed = false
  let deferRelease = false
  const showLoading = intent === "open" || intent === "latest"
  // The loading flag belongs to the session's current load epoch, not to the
  // identities that make a result current: a discarded result still releases
  // it unless a newer load has taken over, so the view can load the session
  // again. A non-spinner load that superseded a spinner load owns it too.
  const releaseLoadingFlag = () => {
    if (isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) clearMessageLoadingFlag(instanceId, sessionId)
  }
  attachment.addEventListener("abort", releaseLoadingFlag, { once: true })
  const staleReason = () => {
    if (options?.signal?.aborted) return undefined
    if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return "superseded"
    if (instances().get(instanceId)?.client !== instanceClient) return "client"
    if (sessions().get(instanceId)?.has(sessionId) !== true) return "session"
    if (!generationCurrent()) return "generation"
    if (historyAuthority && messageHistoryAuthorities.get(messagePageKey(instanceId, sessionId)) !== historyAuthority) return "history"
    if (getOpenCodeMutationRevision(instanceId, sessionId) !== mutationRevision) return "mutation"
    if (store.getMessageWindow(sessionId) !== expectedWindow) return "window"
    return undefined
  }

  if (showLoading) {
    setLoading((prev) => {
      const next = { ...prev }
      const loadingSet = next.loadingMessages.get(instanceId) || new Set()
      loadingSet.add(sessionId)
      next.loadingMessages.set(instanceId, loadingSet)
      return next
    })
  }
  setSessionMessagesLoadError(instanceId, sessionId, null)

  try {
    log.info(`[HTTP] GET /session.${"messages"} for instance ${instanceId}`, { sessionId })
    let response: SessionMessagesResponse
    let directWindow: MessageWindowState | undefined
    let resolvedNext = planned.next
    let responseAscending = planned.order === "asc" || planned.forward
    const lastResident = planned.seekNewer ? store.getSessionMessageIds(sessionId).at(-1) : undefined
    const directTarget = historyWindowTarget(planned.cursor)
      ?? (lastResident ? { kind: "after" as const, messageID: lastResident } : undefined)
    if (directTarget) {
      const direct = await readHistoryWindow(instanceId, sessionId, directTarget, signal)
      response = direct.response
      directWindow = direct.window
      responseAscending = true
    } else if (planned.seekNewer) {
      const seen = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; ; page += 1) {
        if (page >= MESSAGE_CURSOR_SEEK_LIMIT) throw new Error(tGlobal("messageSection.loadError.detail"))
        response = await client.message.list({
          sessionID: sessionId,
          limit: MESSAGE_WINDOW_PAGE_SIZE,
          ...(cursor ? { cursor } : { order: "desc" }),
        }, { signal })
        if (!isCurrent()) return false
        if (response.cursor?.next === planned.seekNewer) {
          resolvedNext = cursor
            ? { kind: "history", resumeCursor: cursor, newerCursors: [null, null] }
            : emptyLatestWindow()
          break
        }
        const next = response.cursor?.next
        if (!next || seen.has(next)) throw new Error(tGlobal("messageSection.loadError.detail"))
        seen.add(next)
        cursor = next
      }
      responseAscending = false
    } else if (intent === "open" && snapshot && planned.order !== "asc") {
      const page = await listMessageWindow(client, sessionId, {
        limit: MESSAGE_WINDOW_PAGE_SIZE,
        cursor: planned.cursor,
        forward: planned.forward,
        signal,
        isAuthoritative: isCurrent,
      })
      if (!page) return false
      response = {
        data: page.messages,
        cursor: { previous: page.olderCursor, next: page.newerCursor },
      } as SessionMessagesResponse
      responseAscending = true
    } else {
      response = await client.message.list({
        sessionID: sessionId,
        limit: MESSAGE_WINDOW_PAGE_SIZE,
        ...(planned.cursor ? { cursor: planned.cursor } : { order: planned.order ?? "desc" }),
      }, { signal })
    }
    // A staged undo leaves its tail in the native transcript until commit.
    // On opening/latest, seek the latest *visible* page rather than treating
    // a page consisting entirely of that hidden tail as an empty session.
    if (!isCurrent()) return false
    if (!directWindow && (intent === "open" || intent === "latest") && !planned.cursor && session.revert?.messageID) {
      const boundary = session.revert.messageID
      const seen = new Set<string>()
      while (response.data.length > 0 && response.data.every((message) => message.id >= boundary)) {
        // Saved-window refill normalizes to ascending order; raw native seek
        // pages retain the descending order encoded in their older cursor.
        const cursor = responseAscending ? response.cursor?.previous : response.cursor?.next
        if (!cursor) break
        if (seen.has(cursor) || seen.size >= MESSAGE_CURSOR_SEEK_LIMIT) {
          throw new Error(tGlobal("messageSection.loadError.detail"))
        }
        seen.add(cursor)
        response = await client.message.list({ sessionID: sessionId, limit: MESSAGE_WINDOW_PAGE_SIZE, cursor }, { signal })
        responseAscending = false
        if (!isCurrent()) return false
      }
    }
    // The first ascending page is the oldest: its boundary cursor promises no older page.
    const olderCursor = intent === "oldest"
      ? undefined
      : (responseAscending ? response.cursor?.previous : response.cursor?.next) ?? undefined
    const newerCursor = (responseAscending ? response.cursor?.next : response.cursor?.previous) ?? undefined
    const responseCursor = intent === "oldest" || planned.forward ? newerCursor : olderCursor
    if (planned.cursor && responseCursor === planned.cursor) {
      throw new Error("Repeated message cursor")
    }
    if (!isCurrent()) return false

    const forwardPage = intent === "oldest" || planned.forward
    const nextWindow = directWindow ?? (forwardPage
      ? newerCursor
        ? { ...resolvedNext, olderCursor, newerCursors: [newerCursor] }
        : withOlderCursor(emptyLatestWindow(), olderCursor)
      : withOlderCursor(resolvedNext, olderCursor))
    const hasLatestRevisionConflict = () => nextWindow.kind === "latest"
      && getOpenCodeMessageRevision(instanceId, sessionId) !== liveMessageRevision
    let apiMessages = responseAscending ? [...response.data] : [...response.data].reverse()
    // The reducer seed records which fragments the page itself installed.
    const fetchedMessages = [...apiMessages]
    if (rowSnapshot) {
      apiMessages = mergeOpenCodeLoadedPage(instanceId, sessionId, apiMessages.reverse(), rowSnapshot).reverse()
    }
    if (apiMessages.length === 0) {
      if (intent === "older") {
        // V2 boundary cursors do not guarantee another page. An exhausted
        // history request says nothing about the messages already resident.
        // Keep their window identity (including live/latest authority) and
        // scroll anchor; only retire the cursor that reached the boundary.
        commitCurrentWindow(withOlderCursor(currentWindow, undefined), "open")
      } else if (!initialSeed && (hasLatestRevisionConflict() || (intent === "open" && planned.cursor))) {
        retryAfterRevisionConflict = true
      } else if (!initialSeed && store.getSessionRevision(sessionId) !== messageRevision) {
        retryAfterRevisionConflict = true
      } else {
        store.reconcileEmptyAuthoritativeSnapshot(sessionId)
        // Seeking past a fully staged transcript can end on an empty native
        // page. It still carries session metadata authority: late projections
        // must retain the boundary, and a cleared boundary must not linger.
        store.setSessionRevert(sessionId, sessions().get(instanceId)?.get(sessionId)?.revert ?? null)
        commitCurrentWindow(nextWindow, intent)
        markSessionMessagesLoaded(instanceId, sessionId)
        committed = true
      }
    } else {
      const seenMessageIds = new Set<string>()
      const authoritativeApiMessages = apiMessages.filter((apiMessage) => {
        const id = apiMessage.id
        if (typeof id !== "string") return true
        if (seenMessageIds.has(id)) return false
        seenMessageIds.add(id)
        return true
      })
      const messagesInfo = new Map<string, import("../types/message").MessageInfo>()
      const messages: Message[] = authoritativeApiMessages.map((apiMessage) => {
        const normalized = normalizeSessionMessage(sessionId, apiMessage)
        messagesInfo.set(normalized.info.id, normalized.info)
        return normalized.message
      })

      let agentName = ""
      let providerID = ""
      let modelID = ""
      for (let i = authoritativeApiMessages.length - 1; i >= 0; i--) {
        const info = messagesInfo.get(authoritativeApiMessages[i].id)
        if (info?.role !== "assistant") continue
        agentName = info.mode || info.agent || ""
        providerID = info.providerID || ""
        modelID = info.modelID || ""
        if (agentName && providerID && modelID) break
      }

      if (!agentName && !providerID && !modelID && (!session.model.providerId || !session.model.modelId)) {
        const defaultModel = await getDefaultModel(instanceId, session.agent)
        if (!isCurrent()) return false
        agentName = session.agent
        providerID = defaultModel.providerId
        modelID = defaultModel.modelId
      }

      if (nextWindow.kind === "latest") withSession(instanceId, sessionId, (existingSession) => {
        if (!isCurrent()) return false
        // Transcript metadata describes past execution. Only fill initially missing values.
        const agent = existingSession.agent || agentName
        const model = (!existingSession.model.providerId || !existingSession.model.modelId) && providerID && modelID
          ? { providerId: providerID, modelId: modelID } : existingSession.model
        if (agent === existingSession.agent && model === existingSession.model) return false
        existingSession.agent = agent
        existingSession.model = model
      })

      const sessionForV2 = sessions().get(instanceId)?.get(sessionId) ?? {
        id: sessionId, title: session?.title, parentId: session?.parentId ?? null, revert: session?.revert,
      }
      if (!isCurrent()) return false
      const expectedRevision = nextWindow.kind === "latest" && !initialSeed ? messageRevision : undefined
      // Short-circuit: a load already raced by a native event must not seed
      // its stale snapshot at all (the retry re-fetches instead).
      if (!initialSeed && hasLatestRevisionConflict()) {
        retryAfterRevisionConflict = true
      } else if (!(await seedSessionMessagesV2(instanceId, sessionForV2, messages, messagesInfo, expectedRevision, false, true, true,
        // A load that lost its authority while the chunked seed computed (a
        // cancelled or superseded jump) must not publish; ordinary streaming
        // keeps it, with the finalize pass deciding rows by freshness.
        () => isCurrent(),
        nextWindow.kind === "latest"))) {
        retryAfterRevisionConflict = true
      } else {
        // The chunked seed awaited across task boundaries: the load's
        // authority may have ended while its chunks computed. A cancelled or
        // superseded load must not install its window.
        if (!isCurrent()) return false
        store.trimSessionMessages(sessionId, MESSAGE_WINDOW_PAGE_SIZE)
        commitCurrentWindow(nextWindow, intent)
        markSessionMessagesLoaded(instanceId, sessionId)
        reconcilePendingPermissionsV2(instanceId, sessionId)
        committed = true
        // Streamed events reach the display only through the session reducer,
        // which ignores them for messages it does not hold: every committed
        // latest page offers it a seed. A first load's page is merged with the
        // rows streamed during its fetch; any other latest commit passed the
        // revision check, so no event changed the transcript during its fetch.
        const current = sessions().get(instanceId)?.get(sessionId)
        if (nextWindow.kind === "latest") {
          void seedOpenCodeSessionMessages(instanceId, sessionId, current?.location.directory ?? instance.folder, authoritativeApiMessages,
            current?.status === "idle" && current.runtimeStatusKnown === true, fetchedMessages)
        }
      }
    }
    // A revision conflict keeps the flag through its bounded, backed-off retry.
    deferRelease = retryAfterRevisionConflict
  } catch (error) {
    if (signal.aborted || !isCurrentLoad()) return false
    if (error instanceof MissingHistoryAnchorError && intent === "open" && isCurrent()) {
      // A persisted window can outlive its anchor (deletion, compaction, undo).
      // Recover once through a fresh visible latest page; its successful commit
      // replaces the stale snapshot. Explicit navigation must still fail visibly.
      return loadMessages(instanceId, sessionId, { force: true, intent: "latest",
        signal: options?.signal, registerInvalidation: options?.registerInvalidation })
    }
    log.error("Failed to load messages:", error)
    const message = error instanceof Error ? error.message : String(error)
    if (isCurrent() && !message.includes("Stale read from")) {
      setSessionMessagesLoadError(instanceId, sessionId, getOpencodeErrorMessage(error, tGlobal("messageSection.loadError.detail")))
    }
    throw error
  } finally {
    attachment.removeEventListener("abort", releaseLoadingFlag)
    if (!committed && !deferRelease) {
      // Diagnostic only (session logger): names the identity that discarded a result.
      const reason = staleReason()
      if (reason) sessionLog.warn("Discarded stale message load", { instanceId, sessionId, reason })
    }
    if (!deferRelease) releaseLoadingFlag()
    finishMessageLoad(instanceId, sessionId, loadEpoch)
  }

  if (retryAfterRevisionConflict) {
    try {
      if (sessions().get(instanceId)?.has(sessionId)) {
        if (revisionRetry >= MAX_LATEST_WINDOW_REVISION_RETRIES) {
          // A load that lost its authority on its final attempt (cancelled or
          // superseded between the retry's backoff and this check) fails
          // silently: publishing a load error for a window nobody awaits
          // would strand an error surface with no retry left.
          if (!isCurrent()) return false
          const error = new Error(tGlobal("messageSection.loadError.detail"))
          setSessionMessagesLoadError(instanceId, sessionId, getOpencodeErrorMessage(error, tGlobal("messageSection.loadError.detail")))
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, LATEST_WINDOW_RETRY_DELAY_MS * (2 ** revisionRetry)))
        signal.throwIfAborted()
        if (!isCurrent()) return false
        return await loadMessages(instanceId, sessionId, {
          force: true,
          intent: intent === "open" && planned.cursor ? "latest" : intent,
          registerInvalidation: options?.registerInvalidation,
          signal: options?.signal,
          revisionRetry: revisionRetry + 1,
          anchorMessageId: options?.anchorMessageId,
        })
      }
    } finally {
      // No-op once the retry has started its own load; otherwise this exit owns the flag.
      releaseLoadingFlag()
    }
  }

  if (!isCurrent()) return false
  updateSessionInfo(instanceId, sessionId)
  return committed
}

function enqueueMessageWindowLoad(
  instanceId: string,
  sessionId: string,
  intent: Exclude<MessageWindowIntent, "open">,
  signal?: AbortSignal,
): Promise<boolean> {
  const current = captureInstanceRequestAuthority(instanceId)
  if (!current()) return Promise.resolve(false)
  const key = `${messagePageKey(instanceId, sessionId)}\0${intent}`
  let pending = messagePageRequests.get(key)
  if (!pending?.current()) {
    const controller = new AbortController()
    pending = { controller, current, consumers: new Set(), request: undefined as unknown as Promise<boolean> }
    const entry = pending
    entry.request = loadMessages(instanceId, sessionId, { force: true, intent, signal: controller.signal }).then(
      (committed) => {
        if (messagePageRequests.get(key) === entry) messagePageRequests.delete(key)
        return committed
      },
      (error) => {
        if (messagePageRequests.get(key) === entry) messagePageRequests.delete(key)
        throw error
      },
    )
    messagePageRequests.set(key, entry)
  }

  const consumer = Symbol()
  pending.consumers.add(consumer)
  if (signal?.aborted) {
    pending.consumers.delete(consumer)
    if (pending.consumers.size === 0) {
      if (messagePageRequests.get(key) === pending) messagePageRequests.delete(key)
      pending.controller.abort()
    }
    return Promise.resolve(false)
  }

  const entry = pending
  return new Promise<boolean>((resolve, reject) => {
    let finished = false
    const finish = (committed: boolean, error?: unknown) => {
      if (finished) return
      finished = true
      signal?.removeEventListener("abort", handleAbort)
      entry.consumers.delete(consumer)
      if (error === undefined) resolve(committed)
      else reject(error)
    }
    const handleAbort = () => {
      finish(false)
      if (entry.consumers.size === 0) {
        if (messagePageRequests.get(key) === entry) messagePageRequests.delete(key)
        entry.controller.abort()
      }
    }
    signal?.addEventListener("abort", handleAbort, { once: true })
    entry.request.then(
      (committed) => finish(committed),
      (error) => {
        if (signal?.aborted) finish(false)
        else finish(false, error)
      },
    )
  })
}

function loadMoreMessages(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "older", signal)
}

function loadOlderMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "older", signal)
}

function loadNewerMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "newer", signal)
}

function loadLatestMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "latest", signal)
}

function loadOldestMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "oldest", signal)
}

function loadMessageAnchor(instanceId: string, sessionId: string, messageId: string, signal?: AbortSignal): Promise<boolean> {
  return loadMessages(instanceId, sessionId, { force: true, intent: "around", anchorMessageId: messageId, signal })
}

function hasMoreMessages(instanceId: string, sessionId: string): boolean {
  return Boolean(currentMessageWindow(instanceId, sessionId).olderCursor)
}

function getMessageNextCursor(instanceId: string, sessionId: string): string | undefined {
  return currentMessageWindow(instanceId, sessionId).olderCursor
}

function isLatestMessageWindow(instanceId: string, sessionId: string): boolean {
  return isLatestWindow(currentMessageWindow(instanceId, sessionId))
}

export {
  createSession,
  isCreatingSession,
  deleteSession,
  removeSessionRuntimeState,
  removeSessionProjection,
  fetchAgents,
  fetchProviders,
  getActiveCatalogLocation,
  refreshSessionCatalog,
  refreshSessionRuntimeStatus,

  fetchSessions,
  hydrateRestoredSessionChain,
  loadMoreSessions,
  loadAllSessions,
  searchSessions,
  forkSession,
  loadMessages,
  loadMoreMessages,
  loadOlderMessageWindow,
  loadNewerMessageWindow,
  loadLatestMessageWindow,
  loadOldestMessageWindow,
  loadMessageAnchor,
  hasMoreMessages,
  getMessageNextCursor,
  isLatestMessageWindow,
  beginMessageHistoryTraversal,
  invalidateMessageHistoryTraversal,
  clearSessionListRequestState,
  clearSessionCatalogState,
}
import { backendOf } from "../lib/backend-client"
