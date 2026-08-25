import {
  getIdleSinceForStatusTransition,
  isSelectablePrimaryAgent,
  type Session,
} from "../types/session"
import type { Message } from "../types/message"
import type { Instance } from "../types/instance"
import type { LocationRef, SessionInfo as SDKSession, SessionMessagesResponse } from "@opencode-ai/client"

import { instances, reconcilePendingSessionIndicators } from "./instances"
import { preferences, setAgentModelPreference } from "./preferences"
import {
  activeSessionId,
  activeParentSessionId,
  agents,
  clearActiveSession,
  clearActiveParentSession,
  setActiveSession,
  clearSessionDraftPrompt,
  cancelSessionGenerationAdmissions,
  markSessionDeletedAuthoritative,
  getAuthoritativelyDeletedSessionIdsForInstance,
  isBlankSession,
  messagesLoaded,
  getSessionMessagesLoadError,
  providers,
  setAgents,
  setMessagesLoaded,
  advanceMessageLoadEpoch,
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
  syncInstanceSessionIndicator,
  updateThreadTotalsForParent,
  setSessionPage,
  prependSessionListId,
  removeSessionListId,
  beginSessionSearch,
  clearSessionSearch,
  isLatestSessionSearch,
  setSessionSearchResults,
  setSessionListError,
  setSessionExpanded,
  getSessionNextCursor,
  getSessionListIds,
} from "./session-state"
import { deleteSessionAttachments } from "./attachments"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getActiveCatalogLocation, getDefaultModel, isModelValid } from "./session-models"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2, reconcilePendingPermissionsV2 } from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import {
  emptyLatestWindow,
  isLatestWindow,
  planNewerWindow,
  planOlderWindow,
  toWindowSnapshot,
  windowFromSnapshot,
  withOlderCursor,
  type MessageWindowState,
} from "./message-v2/message-window"
import { clearCacheForSession } from "../lib/global-cache"
import { getLogger } from "../lib/logger"
import { getOpencodeErrorMessage } from "../lib/opencode-api"
import { getRootClient } from "./opencode-client"
import { tGlobal } from "../lib/i18n"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
} from "./session-list-options"
import { getInstanceMetadata } from "./instance-metadata"
import { mergeFetchedSessionRuntimeState, resolveAuthoritativeGenerationRecovery } from "./session-generation-recovery"
import { fetchCommands } from "./commands"
import { toRequestLocation } from "./request-locations"
import { getOpenCodeInstanceGeneration, getOpenCodeMessageRevision, getOpenCodeMutationRevision } from "./opencode-data"

const log = getLogger("api")
const sessionListRequestIds = new Map<string, number>()
const catalogLocations = new Map<string, string>()
const catalogRefreshes = new Map<string, { key: string; promise: Promise<void> }>()
const agentRequestIds = new Map<string, number>()
const providerRequestIds = new Map<string, number>()
const agentRefreshes = new Map<string, { promise: Promise<boolean>; pending: boolean; cancelled: boolean }>()
const providerRefreshes = new Map<string, { promise: Promise<boolean>; pending: boolean; cancelled: boolean }>()
const sessionPageRequests = new Map<string, Promise<void>>()
const messageNextCursors = new Map<string, string>()
const messagePageRequests = new Map<string, Promise<void>>()
const messageHistoryAuthorities = new Map<string, object>()
const MESSAGE_STREAM_SCOPE = "message-stream"
const MAX_LATEST_WINDOW_REVISION_RETRIES = 3
const LATEST_WINDOW_RETRY_DELAY_MS = 50
const MESSAGE_CURSOR_SEEK_LIMIT = 1000
type MessageWindowIntent = "open" | "older" | "newer" | "latest" | "oldest"
let nextSessionListRequestId = 0
let nextAgentRequestId = 0
let nextProviderRequestId = 0

function messagePageKey(instanceId: string, sessionId: string): string {
  return `${instanceId}\0${sessionId}`
}

function captureInstanceRequestAuthority(instanceId: string): () => boolean {
  const generation = getOpenCodeInstanceGeneration(instanceId)
  return () => getOpenCodeInstanceGeneration(instanceId) === generation
}

function beginMessageHistoryTraversal(instanceId: string, sessionId: string): () => void {
  const key = messagePageKey(instanceId, sessionId)
  const authority = {}
  messageHistoryAuthorities.set(key, authority)
  invalidateSessionMessageLoad(instanceId, sessionId)
  for (const requestKey of messagePageRequests.keys()) {
    if (requestKey.startsWith(`${key}\0`)) messagePageRequests.delete(requestKey)
  }
  return () => {
    if (messageHistoryAuthorities.get(key) !== authority) return
    messageHistoryAuthorities.delete(key)
    invalidateSessionMessageLoad(instanceId, sessionId)
  }
}

function invalidateMessageHistoryTraversal(instanceId: string, sessionId: string): void {
  const key = messagePageKey(instanceId, sessionId)
  messageHistoryAuthorities.delete(key)
  invalidateSessionMessageLoad(instanceId, sessionId)
  for (const requestKey of messagePageRequests.keys()) {
    if (requestKey.startsWith(`${key}\0`)) messagePageRequests.delete(requestKey)
  }
}

function catalogLocationKey(location: LocationRef): string {
  return `${location.directory}\0${location.workspaceID ?? ""}`
}

async function refreshSessionCatalog(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance?.client) return
  const location = getActiveCatalogLocation(instanceId)
  const key = catalogLocationKey(location)
  if (catalogLocations.get(instanceId) === key) return
  const existing = catalogRefreshes.get(instanceId)
  if (existing?.key === key) return existing.promise
  const promise = Promise.all([
    fetchAgents(instanceId, location),
    fetchProviders(instanceId, location),
    fetchCommands(instanceId, instance.client, location),
  ]).then((successes) => {
    if (successes.every(Boolean) && catalogLocationKey(getActiveCatalogLocation(instanceId)) === key) {
      catalogLocations.set(instanceId, key)
    }
  }).finally(() => {
    if (catalogRefreshes.get(instanceId)?.promise === promise) catalogRefreshes.delete(instanceId)
  })
  catalogRefreshes.set(instanceId, { key, promise })
  return promise
}

function beginSessionListRequest(instanceId: string): number {
  const requestId = ++nextSessionListRequestId
  sessionListRequestIds.set(instanceId, requestId)
  return requestId
}

function isLatestSessionListRequest(instanceId: string, requestId: number): boolean {
  return sessionListRequestIds.get(instanceId) === requestId
}

function clearSessionListRequestState(instanceId: string): void {
  sessionListRequestIds.delete(instanceId)
  sessionPageRequests.delete(instanceId)
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
  for (const key of messageNextCursors.keys()) {
    if (key.startsWith(prefix)) messageNextCursors.delete(key)
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
  signal?: AbortSignal,
): Promise<ProjectSessionListResponse> {
  const client = getRootClient(instanceId)
  const project = options.project ?? getInstanceMetadata(instanceId)?.project?.id
  const scopedProject = project === "global" ? undefined : project
  const directory = options.directory ?? instances().get(instanceId)?.folder
  const listOptions: V2SessionListOptions = options.cursor
    ? { cursor: options.cursor }
    : { ...options, project: scopedProject, directory, order: options.order ?? "desc" }
  if (scopedProject) delete listOptions.directory

  const response = await client.session.list(
    buildProjectSessionListOptions(listOptions),
    signal ? { signal } : undefined,
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

async function fetchCompleteProjectSessionInventory(
  instanceId: string,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<SDKSession[]> {
  const project = getInstanceMetadata(instanceId)?.project?.id
  if (!project) return []
  const inventory = new Map<string, SDKSession>()
  const seenCursors = new Set<string>()
  let response = await fetchV2Sessions(instanceId, { project, order: "desc" }, signal)
  while (true) {
    if (!isCurrent()) return []
    for (const session of response.data) inventory.set(session.id, session)
    if (!response.nextCursor) break
    if (seenCursors.has(response.nextCursor)) throw new Error(`Repeated session cursor: ${response.nextCursor}`)
    seenCursors.add(response.nextCursor)
    response = await fetchV2Sessions(instanceId, { cursor: response.nextCursor }, signal)
  }
  return Array.from(inventory.values())
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
      if (session.parentId === null) {
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
  const existingStatus = existingSession?.status
  const active = activeSessions && Object.prototype.hasOwnProperty.call(activeSessions, apiSession.id)
  const status = activeSessions === null
    ? existingStatus ?? "idle"
    : active && existingStatus === "compacting" ? "compacting" : active ? "working" : "idle"
  return {
    ...toClientSessionV2(instanceId, apiSession, existingSession),
    status,
    retry: activeSessions === null ? existingSession?.retry ?? null : null,
    idleSince: getIdleSinceForStatusTransition(existingStatus, status, existingSession?.idleSince),
    runtimeStatusKnown: activeSessions === null ? existingSession?.runtimeStatusKnown ?? false : true,
    generationRecovery: activeSessions === null
      ? existingSession?.generationRecovery ?? null
      : resolveAuthoritativeGenerationRecovery(existingSession?.generationRecovery, status),
  }
}

async function hydrateRestoredSessionChain(
  instanceId: string,
  requestedIds: Array<string | null | undefined>,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const isRequestCurrent = () => generationCurrent() && isCurrent()
  let pending = requestedIds.filter((id): id is string => Boolean(id) && id !== "info")
  const visited = new Set<string>()
  while (pending.length > 0) {
    if (!isRequestCurrent()) return
    signal?.throwIfAborted()
    const level = [...new Set(pending)].filter((sessionId) => !visited.has(sessionId))
    pending = []
    level.forEach((sessionId) => visited.add(sessionId))
    const parents = await Promise.all(level.map(async (sessionId) => {
      if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) return null

      let session = sessions().get(instanceId)?.get(sessionId)
      if (!session) {
        try {
          signal?.throwIfAborted()
          const apiSession = await client.session.get({ sessionID: sessionId }, signal ? { signal } : undefined)
          signal?.throwIfAborted()
          if (!isRequestCurrent()) return null
          setSessions((prev) => {
            if (!isRequestCurrent() || getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId) || signal?.aborted) return prev
            const next = new Map(prev)
            const instanceSessions = new Map(next.get(instanceId) ?? new Map())
            instanceSessions.set(sessionId, toClientSessionV2(instanceId, apiSession, instanceSessions.get(sessionId)))
            next.set(instanceId, instanceSessions)
            return next
          })
          session = sessions().get(instanceId)?.get(sessionId)
          if (session?.parentId === null) prependSessionListId(instanceId, sessionId)
        } catch (error) {
          if (signal?.aborted) throw error
          log.warn("Failed to hydrate restored session", { instanceId, sessionId, error })
          return null
        }
      }
      return session?.parentId ?? null
    }))
    pending = parents.filter((id): id is string => Boolean(id))
  }
}

async function ensureV2ParentChainsLoaded(
  instanceId: string,
  apiSessions: SDKSession[],
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return
  const currentSessions = sessions().get(instanceId) ?? new Map<string, Session>()
  const loaded = new Map<string, SDKSession | Session>(currentSessions)
  for (const session of apiSessions) loaded.set(session.id, session)

  const missingChains = apiSessions
    .filter((session) => hasMissingParentChain(session, loaded))
    .map((session) => session.parentID)
  if (missingChains.length > 0) await hydrateRestoredSessionChain(instanceId, missingChains, signal, isCurrent)
}

async function fetchSessions(instanceId: string, options?: {
  reset?: boolean
  strictStatus?: boolean
  registerInvalidation?: (invalidate: () => void) => void
  signal?: AbortSignal
}): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const requestId = beginSessionListRequest(instanceId)
  const client = instance.client
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const isCurrent = () => isLatestSessionListRequest(instanceId, requestId)
    && instances().get(instanceId)?.client === client
    && generationCurrent()
  options?.registerInvalidation?.(() => {
    if (isLatestSessionListRequest(instanceId, requestId)) clearSessionListRequestState(instanceId)
  })

  setLoading((prev) => {
    const next = { ...prev }
    next.fetchingSessions.set(instanceId, true)
    return next
  })
  setSessionListError(instanceId, null)

  try {
    const sessionListOptions = { ...(instance.folder ? { directory: instance.folder } : {}), parentID: null as null, order: "desc" as const }
    const existingSessions = new Map(sessions().get(instanceId) ?? new Map<string, Session>())
    const existingCatalogIds = new Set(getSessionListIds(instanceId))

    log.info("session.list", { instanceId, limit: PROJECT_SESSION_LIST_LIMIT, directory: sessionListOptions.directory })
    const [response, activeSessions] = await Promise.all([
      fetchV2Sessions(instanceId, sessionListOptions, options?.signal),
      getRootClient(instanceId).session.active(options?.signal ? { signal: options.signal } : undefined).catch((error) => {
        log.warn("Failed to refresh active sessions", { instanceId, error })
        return null
      }),
    ])
    if (!isCurrent()) {
      if (options?.strictStatus) throw new Error("Foreground session refresh was superseded")
      return
    }
    const rootApiSessions = getV2SessionItems(response)
    const hasProjectInventory = Boolean(getInstanceMetadata(instanceId)?.project?.id)
    if (hasProjectInventory) {
      const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
      setSessions((prev) => {
        const next = new Map(prev)
        const instanceSessions = new Map(next.get(instanceId) ?? new Map())
        for (const apiSession of rootApiSessions) {
          const existingSession = existingSessions.get(apiSession.id)
          const fetched = withActiveSessionState(instanceId, apiSession, existingSession, activeSessions)
          const merged = mergeFetchedSessionRuntimeState(
            fetched,
            existingSession,
            instanceSessions.get(apiSession.id),
            deletedSessionIds.has(apiSession.id),
          )
          if (merged) instanceSessions.set(apiSession.id, merged)
        }
        next.set(instanceId, instanceSessions)
        return next
      })
      setSessionPage(
        instanceId,
        rootApiSessions.filter((session) => !session.parentID && !deletedSessionIds.has(session.id)).map((session) => session.id),
        Boolean(response.nextCursor),
        options?.reset ?? true,
        response.nextCursor,
      )
    }
    let inventory: SDKSession[] = []
    let inventoryComplete = false
    try {
      inventory = await fetchCompleteProjectSessionInventory(instanceId, options?.signal, isCurrent)
      inventoryComplete = hasProjectInventory
    } catch (error) {
      if (options?.signal?.aborted) throw error
      log.warn("Failed to enrich the session list with project descendants", { instanceId, error })
    }
    if (!isCurrent()) return
    const rootIdsFromPage = new Set(rootApiSessions.map((session) => session.id))
    const apiSessions = [...rootApiSessions, ...inventory.filter((session) => !rootIdsFromPage.has(session.id))]
    const sessionMap = new Map<string, Session>()

    for (const apiSession of apiSessions) {
      const existingSession = existingSessions?.get(apiSession.id)
      sessionMap.set(apiSession.id, withActiveSessionState(instanceId, apiSession, existingSession, activeSessions))
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
    await ensureV2ParentChainsLoaded(instanceId, apiSessions, options?.signal, isCurrent)
    if (!isCurrent()) return

    if (inventoryComplete || (!hasProjectInventory && response.complete)) {
      const authoritativeSessions = inventoryComplete ? inventory : rootApiSessions
      const fetchedRootIds = new Set(authoritativeSessions.filter((session) => !session.parentID).map((session) => session.id))
      const concurrentRootIds = new Set(Array.from(sessions().get(instanceId)?.values() ?? [])
        .filter((session) => !existingSessions.has(session.id) && session.parentId === null)
        .map((session) => session.id))
      const validRootIds = new Set([...fetchedRootIds, ...concurrentRootIds])
      const currentSessions = sessions().get(instanceId) ?? new Map()
      for (const sessionId of getDisconnectedCapturedSessionIds(existingSessions, currentSessions, validRootIds)) {
        removeSessionRuntimeState(instanceId, sessionId, false)
      }
    }
    const rootIds: string[] = []
    const seenRootIds = new Set<string>()
    const missingRootSessionIds: string[] = []
    for (const apiSession of rootApiSessions) {
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
    if (!response.complete) {
      for (const sessionId of existingCatalogIds) {
        const session = sessions().get(instanceId)?.get(sessionId)
        if (session?.parentId === null && !seenRootIds.has(sessionId)) {
          seenRootIds.add(sessionId)
          rootIds.push(sessionId)
        }
      }
    }
    const concurrentRootIds = getSessionListIds(instanceId).filter((sessionId) => {
      const session = sessions().get(instanceId)?.get(sessionId)
      return !existingCatalogIds.has(sessionId) && session?.parentId === null && !seenRootIds.has(sessionId)
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

    setSessionPage(instanceId, rootIds, Boolean(response.nextCursor), options?.reset ?? true, response.nextCursor)
    for (const rootId of rootIds) updateThreadTotalsForParent(instanceId, rootId)

    reconcilePendingSessionIndicators(instanceId)

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
    if (!aborted && isLatestSessionListRequest(instanceId, requestId)) {
      setSessionListError(instanceId, getOpencodeErrorMessage(error, tGlobal("sessionList.loadError.detail")))
    }
    throw error
  } finally {
    if (isLatestSessionListRequest(instanceId, requestId)) {
      setLoading((prev) => {
        const next = { ...prev }
        next.fetchingSessions.set(instanceId, false)
        return next
      })
    }
  }
}

async function loadMoreSessions(instanceId: string): Promise<void> {
  const pending = sessionPageRequests.get(instanceId)
  if (pending) return pending
  const request = loadNextSessionPage(instanceId).finally(() => {
    if (sessionPageRequests.get(instanceId) === request) sessionPageRequests.delete(instanceId)
  })
  sessionPageRequests.set(instanceId, request)
  return request
}

async function loadNextSessionPage(instanceId: string): Promise<void> {
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
  const [response, activeSessions] = await Promise.all([
    fetchV2Sessions(instanceId, { cursor }),
    getRootClient(instanceId).session.active().catch((error) => {
      log.warn("Failed to refresh active sessions", { instanceId, error })
      return null
    }),
  ])
  if (!isCurrent() || getSessionNextCursor(instanceId) !== cursor) return
  const pageSessions = response.data
  const deleted = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
  setSessions((previous) => {
    const next = new Map(previous)
    const current = new Map(next.get(instanceId) ?? [])
    for (const item of pageSessions) {
      if (!deleted.has(item.id)) {
        const existing = current.get(item.id)
        const fetched = withActiveSessionState(instanceId, item, existing, activeSessions)
        const merged = mergeFetchedSessionRuntimeState(fetched, existing, existing, false)
        if (merged) current.set(item.id, merged)
      }
    }
    next.set(instanceId, current)
    return next
  })
  await ensureV2ParentChainsLoaded(instanceId, pageSessions, undefined, isCurrent)
  if (!isCurrent() || getSessionNextCursor(instanceId) !== cursor) return
  const roots = response.data.filter((item) => !item.parentID).map((item) => item.id)
  for (const item of response.data) {
    const root = getSessionRoot(instanceId, item.id)
    if (root && !roots.includes(root.id)) roots.push(root.id)
  }
  setSessionPage(instanceId, roots, Boolean(response.nextCursor), false, response.nextCursor)
  for (const rootId of roots) updateThreadTotalsForParent(instanceId, rootId)
}

async function searchSessions(instanceId: string, query: string): Promise<void> {
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

  try {
    log.info("v2.session.search", { instanceId, query: trimmedQuery, directory: instance.folder })
    const response = await fetchV2Sessions(instanceId, {
      search: trimmedQuery,
      directory: instance.folder,
    })
    if (!isCurrent()) return

    const searchResults = getV2SessionItems(response)

    if (searchResults.length === 0) {
      setSessionSearchResults(instanceId, trimmedQuery, [], requestId)
      return
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(next.get(instanceId) ?? new Map())
      const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)

      for (const apiSession of searchResults) {
        if (deletedSessionIds.has(apiSession.id)) continue
        const existingSession = instanceSessions.get(apiSession.id)
        instanceSessions.set(apiSession.id, toClientSessionV2(instanceId, apiSession, existingSession))
      }

      next.set(instanceId, instanceSessions)
      return next
    })
    await ensureV2ParentChainsLoaded(instanceId, searchResults, undefined, isCurrent)

    if (!isCurrent()) return

    const hydratedSessions = sessions().get(instanceId)
    const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
    const currentSearchResults = searchResults.filter((session) => !deletedSessionIds.has(session.id))
    const hasUnrenderableChildResult = currentSearchResults.some((session) => {
      const parentId = session.parentID
      return Boolean(parentId && !hydratedSessions?.has(parentId))
    })

    if (hasUnrenderableChildResult) {
      clearSessionSearch(instanceId)
      return
    }

    syncInstanceSessionIndicator(instanceId)
    setSessionSearchResults(instanceId, trimmedQuery, currentSearchResults.map((session) => session.id), requestId)
  } catch (error) {
    log.error("Failed to search sessions:", error)
    if (isLatestSessionSearch(instanceId, trimmedQuery, requestId)) {
      clearSessionSearch(instanceId)
    }
    throw error
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
    cost: apiSession.cost,
    tokens: apiSession.tokens,
    location: apiSession.location,
    projectID: apiSession.projectID,
    subpath: apiSession.subpath,
    time: {
      ...apiSession.time,
    },
    revert: apiSession.revert ?? existingSession?.revert,
    pendingPermission: existingSession?.pendingPermission,
  }
}

async function createSession(instanceId: string, agent?: string): Promise<Session> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const activeId = activeSessionId().get(instanceId)
  const activeLocation = activeId && activeId !== "info"
    ? sessions().get(instanceId)?.get(activeId)?.location
    : undefined
  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)

  const instanceAgents = agents().get(instanceId) || []
  const primaryAgents = instanceAgents.filter(isSelectablePrimaryAgent)
  const selectedAgent = agent || primaryAgents[0]?.id || ""

  const defaultModel = await getDefaultModel(instanceId, selectedAgent)
  if (!generationCurrent()) throw new Error("Session creation was superseded by reconnect")

  if (selectedAgent && isModelValid(instanceId, defaultModel)) {
    await setAgentModelPreference(instanceId, selectedAgent, defaultModel)
    if (!generationCurrent()) throw new Error("Session creation was superseded by reconnect")
  }

  setLoading((prev) => {
    const next = { ...prev }
    next.creatingSession.set(instanceId, true)
    return next
  })

  try {
    log.info(`[HTTP] POST /session.create for instance ${instanceId}`)
    const info = await client.session.create({
      agent: selectedAgent || null,
      model: defaultModel.providerId && defaultModel.modelId
        ? { providerID: defaultModel.providerId, id: defaultModel.modelId }
        : null,
      location: activeLocation ?? { directory: instance.folder },
    })
    if (!generationCurrent()) throw new Error("Session creation was superseded by reconnect")
    const session = toClientSessionV2(instanceId, info)
    session.agent = selectedAgent
    session.model = defaultModel

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) || new Map()
      instanceSessions.set(session.id, session)
      next.set(instanceId, instanceSessions)
      return next
    })

    syncInstanceSessionIndicator(instanceId)
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
      await cleanupBlankSessions(instanceId, session.id)
    }

    return session
  } catch (error) {
    log.error("Failed to create session:", error)
    throw error
  } finally {
    setLoading((prev) => {
      const next = { ...prev }
      next.creatingSession.set(instanceId, false)
      return next
    })
  }
}

async function forkSession(
  instanceId: string,
  sourceSessionId: string,
  options?: { messageId?: string },
): Promise<Session> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)

  const request = {
    sessionID: sourceSessionId,
    boundary: options?.messageId
      ? { type: "before" as const, messageID: options.messageId }
      : { type: "through" as const },
  }

  log.info(`[HTTP] POST /session.fork for instance ${instanceId}`, request)
  const info = await client.session.fork(request)
  if (!generationCurrent()) throw new Error("Session fork was superseded by reconnect")
  const forkedSession = toClientSessionV2(instanceId, info)

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = next.get(instanceId) || new Map()
    instanceSessions.set(forkedSession.id, forkedSession)
    next.set(instanceId, instanceSessions)
    return next
  })

  syncInstanceSessionIndicator(instanceId)

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
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)
  const generationCurrent = captureInstanceRequestAuthority(instanceId)

  setLoading((prev) => {
    const next = { ...prev }
    const deleting = next.deletingSession.get(instanceId) || new Set()
    deleting.add(sessionId)
    next.deletingSession.set(instanceId, deleting)
    return next
  })

  try {
    log.info(`[HTTP] DELETE /session.remove for instance ${instanceId}`, { sessionId })
    await client.session.remove({ sessionID: sessionId })
    if (!generationCurrent()) throw new Error("Session deletion was superseded by reconnect")

    removeSessionRuntimeState(instanceId, sessionId)

  } catch (error) {
    log.error("Failed to delete session:", error)
    throw error
  } finally {
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

function removeSessionRuntimeState(instanceId: string, sessionId: string, authoritative = true): void {
  cancelSessionGenerationAdmissions(instanceId, sessionId)
  if (authoritative) markSessionDeletedAuthoritative(instanceId, sessionId)
  deleteSessionAttachments(instanceId, sessionId)
  clearSessionDraftPrompt(instanceId, sessionId)
  setSessionExpanded(instanceId, sessionId, false)

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = next.get(instanceId)
    if (instanceSessions) {
      instanceSessions.delete(sessionId)
      if (instanceSessions.size === 0) {
        next.delete(instanceId)
      }
    }
    return next
  })

  syncInstanceSessionIndicator(instanceId)
  removeSessionListId(instanceId, sessionId)

  // Drop normalized message state and caches for this session.
  const pageKey = messagePageKey(instanceId, sessionId)
  messageNextCursors.delete(pageKey)
  messagePageRequests.delete(pageKey)
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

  const selectedParentId = activeParentSessionId().get(instanceId)
  const selectedSessionId = activeSessionId().get(instanceId)
  if (selectedParentId === sessionId) {
    clearActiveParentSession(instanceId)
  } else if (selectedSessionId === sessionId) {
    if (selectedParentId && sessions().get(instanceId)?.has(selectedParentId)) {
      setActiveSession(instanceId, selectedParentId)
    } else {
      clearActiveSession(instanceId)
    }
  }
}

function fetchAgents(instanceId: string, location = getActiveCatalogLocation(instanceId), refresh = false): Promise<boolean> {
  const key = `${instanceId}\0${catalogLocationKey(location)}`
  const existing = agentRefreshes.get(key)
  if (existing) {
    if (refresh) existing.pending = true
    return existing.promise
  }
  const state = { promise: Promise.resolve(false), pending: false, cancelled: false }
  state.promise = (async () => {
    let result: boolean
    do {
      state.pending = false
      result = await loadAgents(instanceId, location)
    } while (state.pending && !state.cancelled)
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
    const response = await rootClient.agent.list({ location: requestLocation })
    const agentsById = new Map((response.data ?? []).map((agent) => [agent.id, agent]))
    await Promise.all(["build", "plan"].filter((id) => !agentsById.has(id)).map(async (id) => {
      try {
        const result = await rootClient.agent.get({ agentID: id, location: requestLocation })
        agentsById.set(result.data.id, result.data)
      } catch (error) {
        log.warn("Failed to fetch built-in agent", { instanceId, agentId: id, error })
      }
    }))
    const agentList = Array.from(agentsById.values()).sort((a, b) => a.id.localeCompare(b.id)).map((agent) => ({
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
    return true
  } catch (error) {
    log.error("Failed to fetch agents:", error)
    return false
  }
}

function fetchProviders(instanceId: string, location = getActiveCatalogLocation(instanceId), refresh = false): Promise<boolean> {
  const key = `${instanceId}\0${catalogLocationKey(location)}`
  const existing = providerRefreshes.get(key)
  if (existing) {
    if (refresh) existing.pending = true
    return existing.promise
  }
  const state = { promise: Promise.resolve(false), pending: false, cancelled: false }
  state.promise = (async () => {
    let result: boolean
    do {
      state.pending = false
      result = await loadProviders(instanceId, location)
    } while (state.pending && !state.cancelled)
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
      rootClient.provider.list(request),
      rootClient.model.list(request),
      rootClient.model.default(request),
    ])
    const providersById = new Map(response.data.map((provider) => [provider.id, provider]))
    const modelsById = new Map(models.data.map((model) => [`${model.providerID}:${model.id}`, model]))
    if (defaultModel.data) modelsById.set(`${defaultModel.data.providerID}:${defaultModel.data.id}`, defaultModel.data)
    const providerIds = new Set([...providersById.keys(), ...Array.from(modelsById.values(), (model) => model.providerID)])
    const providerList = Array.from(providerIds).sort().map((providerId) => ({
      id: providerId,
      name: providersById.get(providerId)?.name ?? providerId,
      defaultModelId: defaultModel.data?.providerID === providerId ? defaultModel.data.id : undefined,
      models: Array.from(modelsById.values()).filter((model) => model.providerID === providerId && model.status !== "deprecated").sort((a, b) => a.id.localeCompare(b.id)).map((model) => ({
        id: model.id,
        name: model.name,
        providerId,
        limit: model.limit,
        cost: model.cost[0],
        variantKeys: model.variants.map((variant) => variant.id),
      })),
    }))

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
  return store.getMessageWindow(sessionId) ?? windowFromSnapshot(store.getScrollSnapshot(sessionId, MESSAGE_STREAM_SCOPE))
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
  return {
    cursor: current.kind === "history" ? current.resumeCursor : undefined,
    next: current.kind === "history" ? { ...current } : emptyLatestWindow(),
  }
}

function commitMessageWindow(
  instanceId: string,
  sessionId: string,
  window: MessageWindowState,
) {
  const store = messageStoreBus.getOrCreate(instanceId)
  store.setMessageWindow(sessionId, window)
  const existing = store.getScrollSnapshot(sessionId, MESSAGE_STREAM_SCOPE)
  store.setScrollSnapshot(sessionId, MESSAGE_STREAM_SCOPE, {
    scrollTop: existing?.scrollTop ?? 0,
    atBottom: existing?.atBottom ?? window.kind === "latest",
    scrollRatio: existing?.scrollRatio,
    maxScrollTop: existing?.maxScrollTop,
    anchorKey: existing?.anchorKey,
    anchorOffset: existing?.anchorOffset,
    followModeType: existing?.followModeType,
    ...toWindowSnapshot(window),
  })
  const key = messagePageKey(instanceId, sessionId)
  if (window.olderCursor) messageNextCursors.set(key, window.olderCursor)
  else messageNextCursors.delete(key)
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

async function loadMessages(
  instanceId: string,
  sessionId: string,
  options?: {
    force?: boolean
    intent?: MessageWindowIntent
    registerInvalidation?: (invalidate: () => void) => void
    signal?: AbortSignal
    revisionRetry?: number
  },
): Promise<void> {
  const force = options?.force ?? false
  const intent = options?.intent ?? "open"
  const revisionRetry = options?.revisionRetry ?? 0
  const store = messageStoreBus.getOrCreate(instanceId)
  const storedWindow = store.getMessageWindow(sessionId)
  const currentWindow = storedWindow ?? windowFromSnapshot(store.getScrollSnapshot(sessionId, MESSAGE_STREAM_SCOPE))
  const planned = planMessageWindowLoad(currentWindow, intent)
  if (!planned) return

  const alreadyLoaded = messagesLoaded().get(instanceId)?.has(sessionId)
  if (alreadyLoaded && !force) return

  const previousError = getSessionMessagesLoadError(instanceId, sessionId)
  if (previousError && !force) return

  const isLoading = loading().loadingMessages.get(instanceId)?.has(sessionId)
  if (isLoading && !force) return

  const instance = instances().get(instanceId)
  if (!instance || !instance.client) throw new Error("Instance not ready")

  const instanceClient = instance.client
  const client = getRootClient(instanceId)
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) throw new Error("Session not found")

  const loadEpoch = advanceMessageLoadEpoch(instanceId, sessionId)
  const historyAuthority = messageHistoryAuthorities.get(messagePageKey(instanceId, sessionId))
  const generationCurrent = captureInstanceRequestAuthority(instanceId)
  const mutationRevision = getOpenCodeMutationRevision(instanceId, sessionId)
  const isCurrentLoad = () => instances().get(instanceId)?.client === instanceClient
    && isCurrentMessageLoad(instanceId, sessionId, loadEpoch)
    && sessions().get(instanceId)?.has(sessionId)
    && generationCurrent()
    && (!historyAuthority || messageHistoryAuthorities.get(messagePageKey(instanceId, sessionId)) === historyAuthority)
  const isCurrent = () => isCurrentLoad()
    && getOpenCodeMutationRevision(instanceId, sessionId) === mutationRevision
    && store.getMessageWindow(sessionId) === storedWindow
  options?.registerInvalidation?.(() => {
    if (isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) invalidateSessionMessageLoad(instanceId, sessionId)
  })
  const messageRevision = store.getSessionRevision(sessionId)
  const liveMessageRevision = getOpenCodeMessageRevision(instanceId, sessionId)
  let retryAfterRevisionConflict = false
  const showLoading = intent === "open" || intent === "latest"

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
    let resolvedNext = planned.next
    let responseAscending = planned.order === "asc" || planned.forward
    if (planned.seekNewer) {
      const seen = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; ; page += 1) {
        if (page >= MESSAGE_CURSOR_SEEK_LIMIT) throw new Error(tGlobal("messageSection.loadError.detail"))
        response = await client.message.list({
          sessionID: sessionId,
          limit: 200,
          ...(cursor ? { cursor } : { order: "desc" }),
        }, options?.signal ? { signal: options.signal } : undefined)
        if (!isCurrent()) return
        if (response.cursor?.previous === planned.seekNewer) {
          resolvedNext = cursor
            ? { kind: "history", resumeCursor: cursor, newerCursors: [null, null] }
            : emptyLatestWindow()
          break
        }
        const previous = response.cursor?.previous
        if (!previous || seen.has(previous)) throw new Error(tGlobal("messageSection.loadError.detail"))
        seen.add(previous)
        cursor = previous
      }
      responseAscending = false
    } else {
      response = await client.message.list({
        sessionID: sessionId,
        limit: 200,
        ...(planned.cursor ? { cursor: planned.cursor } : { order: planned.order ?? "desc" }),
      }, options?.signal ? { signal: options.signal } : undefined)
    }
    const olderCursor = response.cursor?.previous ?? undefined
    const newerCursor = response.cursor?.next ?? undefined
    const responseCursor = intent === "oldest" || planned.forward ? newerCursor : olderCursor
    if (planned.cursor && responseCursor === planned.cursor) {
      throw new Error("Repeated message cursor")
    }
    if (!isCurrent()) return

    const forwardPage = intent === "oldest" || planned.forward
    const nextWindow = forwardPage
      ? newerCursor
        ? { ...resolvedNext, olderCursor: undefined, newerCursors: [newerCursor] }
        : emptyLatestWindow()
      : withOlderCursor(resolvedNext, olderCursor)
    const hasLatestRevisionConflict = () => nextWindow.kind === "latest"
      && getOpenCodeMessageRevision(instanceId, sessionId) !== liveMessageRevision
    const apiMessages = responseAscending ? [...response.data] : [...response.data].reverse()
    if (apiMessages.length === 0) {
      if (hasLatestRevisionConflict() || (intent === "open" && planned.cursor)) {
        retryAfterRevisionConflict = true
      } else if (store.getSessionRevision(sessionId) !== messageRevision) {
        retryAfterRevisionConflict = true
      } else {
        store.reconcileEmptyAuthoritativeSnapshot(sessionId)
        commitMessageWindow(instanceId, sessionId, nextWindow)
        markSessionMessagesLoaded(instanceId, sessionId)
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

      if (!agentName && !providerID && !modelID) {
        const defaultModel = await getDefaultModel(instanceId, session.agent)
        if (!isCurrent()) return
        agentName = session.agent
        providerID = defaultModel.providerId
        modelID = defaultModel.modelId
      }

      setSessions((prev) => {
        if (!isCurrent()) return prev
        const next = new Map(prev)
        const nextInstanceSessions = next.get(instanceId)
        if (!nextInstanceSessions) return next
        const existingSession = nextInstanceSessions.get(sessionId)
        if (!existingSession) return next
        nextInstanceSessions.set(sessionId, {
          ...existingSession,
          agent: agentName || existingSession.agent,
          model: providerID && modelID ? { providerId: providerID, modelId: modelID } : existingSession.model,
        })
        next.set(instanceId, nextInstanceSessions)
        return next
      })

      const sessionForV2 = sessions().get(instanceId)?.get(sessionId) ?? {
        id: sessionId, title: session?.title, parentId: session?.parentId ?? null, revert: session?.revert,
      }
      if (!isCurrent()) return
      const expectedRevision = nextWindow.kind === "latest" ? messageRevision : undefined
      if (hasLatestRevisionConflict() || !seedSessionMessagesV2(instanceId, sessionForV2, messages, messagesInfo, expectedRevision, false)) {
        retryAfterRevisionConflict = true
      } else {
        commitMessageWindow(instanceId, sessionId, nextWindow)
        markSessionMessagesLoaded(instanceId, sessionId)
        reconcilePendingPermissionsV2(instanceId, sessionId)
      }
    }
  } catch (error) {
    log.error("Failed to load messages:", error)
    const message = error instanceof Error ? error.message : String(error)
    if (isCurrent() && !message.includes("Stale read from")) {
      setSessionMessagesLoadError(instanceId, sessionId, getOpencodeErrorMessage(error, tGlobal("messageSection.loadError.detail")))
    }
    throw error
  } finally {
    if (showLoading && isCurrentLoad()) {
      setLoading((prev) => {
        const next = { ...prev }
        const loadingSet = next.loadingMessages.get(instanceId)
        if (loadingSet) loadingSet.delete(sessionId)
        return next
      })
    }
  }

  if (retryAfterRevisionConflict && sessions().get(instanceId)?.has(sessionId)) {
    if (revisionRetry >= MAX_LATEST_WINDOW_REVISION_RETRIES) {
      const error = new Error(tGlobal("messageSection.loadError.detail"))
      setSessionMessagesLoadError(instanceId, sessionId, getOpencodeErrorMessage(error, tGlobal("messageSection.loadError.detail")))
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, LATEST_WINDOW_RETRY_DELAY_MS * (2 ** revisionRetry)))
    options?.signal?.throwIfAborted()
    if (!isCurrent()) return
    return loadMessages(instanceId, sessionId, {
      force: true,
      intent: intent === "open" && planned.cursor ? "latest" : intent,
      registerInvalidation: options?.registerInvalidation,
      signal: options?.signal,
      revisionRetry: revisionRetry + 1,
    })
  }

  if (!isCurrent()) return
  updateSessionInfo(instanceId, sessionId)
}

function enqueueMessageWindowLoad(
  instanceId: string,
  sessionId: string,
  intent: Exclude<MessageWindowIntent, "open">,
  signal?: AbortSignal,
): Promise<void> {
  const key = `${messagePageKey(instanceId, sessionId)}\0${intent}`
  const pending = messagePageRequests.get(key)
  if (pending) return pending
  let request!: Promise<void>
  request = loadMessages(instanceId, sessionId, { force: true, intent, signal }).then(
    () => { if (messagePageRequests.get(key) === request) messagePageRequests.delete(key) },
    (error) => {
      if (messagePageRequests.get(key) === request) messagePageRequests.delete(key)
      throw error
    },
  )
  messagePageRequests.set(key, request)
  return request
}

function loadMoreMessages(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "older", signal)
}

function loadOlderMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "older", signal)
}

function loadNewerMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "newer", signal)
}

function loadLatestMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "latest", signal)
}

function loadOldestMessageWindow(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  return enqueueMessageWindowLoad(instanceId, sessionId, "oldest", signal)
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
  deleteSession,
  removeSessionRuntimeState,
  fetchAgents,
  fetchProviders,
  getActiveCatalogLocation,
  refreshSessionCatalog,

  fetchSessions,
  hydrateRestoredSessionChain,
  loadMoreSessions,
  searchSessions,
  forkSession,
  loadMessages,
  loadMoreMessages,
  loadOlderMessageWindow,
  loadNewerMessageWindow,
  loadLatestMessageWindow,
  loadOldestMessageWindow,
  hasMoreMessages,
  getMessageNextCursor,
  isLatestMessageWindow,
  beginMessageHistoryTraversal,
  invalidateMessageHistoryTraversal,
  clearSessionListRequestState,
  clearSessionCatalogState,
}
