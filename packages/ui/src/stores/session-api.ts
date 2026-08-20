import {
  getIdleSinceForStatusTransition,
  isSelectablePrimaryAgent,
  type Session,
} from "../types/session"
import type { Message } from "../types/message"
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
} from "./session-state"
import { deleteSessionAttachments } from "./attachments"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getActiveCatalogLocation, getDefaultModel, isModelValid } from "./session-models"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2, reconcilePendingPermissionsV2 } from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { clearCacheForSession } from "../lib/global-cache"
import { getLogger } from "../lib/logger"
import { getOpencodeErrorMessage } from "../lib/opencode-api"
import { getRootClient } from "./opencode-client"
import { tGlobal } from "../lib/i18n"
import {
  getWorktrees,
} from "./worktrees"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
} from "./session-list-options"
import { getInstanceMetadata } from "./instance-metadata"
import { mergeFetchedSessionRuntimeState, resolveAuthoritativeGenerationRecovery } from "./session-generation-recovery"
import { fetchCommands } from "./commands"
import { toRequestLocation } from "./request-locations"

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
let nextSessionListRequestId = 0
let nextAgentRequestId = 0
let nextProviderRequestId = 0

function messagePageKey(instanceId: string, sessionId: string): string {
  return `${instanceId}\0${sessionId}`
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
  const listOptions = { ...options, project, order: options.order ?? "desc" as const }
  if (project) delete listOptions.directory

  if (options.parentID === null && !options.search) {
    delete listOptions.parentID
  }

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
): Promise<void> {
  const client = getRootClient(instanceId)
  const pending = requestedIds.filter((id): id is string => Boolean(id) && id !== "info")
  const visited = new Set<string>()
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const sessionId = pending.shift()!
    if (visited.has(sessionId)) continue
    visited.add(sessionId)
    if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) continue

    let session = sessions().get(instanceId)?.get(sessionId)
    if (!session) {
      try {
        signal?.throwIfAborted()
        const apiSession = await client.session.get({ sessionID: sessionId }, signal ? { signal } : undefined)
        signal?.throwIfAborted()
        setSessions((prev) => {
          if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId) || signal?.aborted) return prev
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
        continue
      }
    }
    if (session?.parentId) pending.push(session.parentId)
  }
}

async function ensureV2ParentChainsLoaded(instanceId: string, apiSessions: SDKSession[], signal?: AbortSignal): Promise<void> {
  const currentSessions = sessions().get(instanceId) ?? new Map<string, Session>()
  const loaded = new Map<string, SDKSession | Session>(currentSessions)
  for (const session of apiSessions) loaded.set(session.id, session)

  const missingChains = apiSessions
    .filter((session) => hasMissingParentChain(session, loaded))
    .map((session) => session.parentID)
  if (missingChains.length > 0) await hydrateRestoredSessionChain(instanceId, missingChains, signal)
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

    log.info("session.list", { instanceId, limit: PROJECT_SESSION_LIST_LIMIT, directory: sessionListOptions.directory })
    const [response, activeSessions] = await Promise.all([
      fetchV2Sessions(instanceId, sessionListOptions, options?.signal),
      getRootClient(instanceId).session.active(options?.signal ? { signal: options.signal } : undefined).catch((error) => {
        log.warn("Failed to refresh active sessions", { instanceId, error })
        return null
      }),
    ])
    if (!isLatestSessionListRequest(instanceId, requestId)) {
      if (options?.strictStatus) throw new Error("Foreground session refresh was superseded")
      return
    }
    const apiSessions = getV2SessionItems(response)
    const sessionMap = new Map<string, Session>()

    for (const apiSession of getV2SessionItems(response)) {
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
    await ensureV2ParentChainsLoaded(instanceId, apiSessions, options?.signal)
    if (!isLatestSessionListRequest(instanceId, requestId)) return

    if (response.complete) {
      const fetchedIds = new Set(apiSessions.map((session) => session.id))
      for (const sessionId of existingSessions.keys()) {
        if (!fetchedIds.has(sessionId)) removeSessionRuntimeState(instanceId, sessionId, false)
      }
    }

    const rootIds: string[] = []
    const seenRootIds = new Set<string>()
    const missingRootSessionIds: string[] = []
    for (const apiSession of getV2SessionItems(response)) {
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
    log.error("Failed to fetch sessions:", error)
    if (isLatestSessionListRequest(instanceId, requestId)) {
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
  const request = loadNextSessionPage(instanceId).finally(() => sessionPageRequests.delete(instanceId))
  sessionPageRequests.set(instanceId, request)
  return request
}

async function loadNextSessionPage(instanceId: string): Promise<void> {
  const cursor = getSessionNextCursor(instanceId)
  if (!cursor) return
  const instance = instances().get(instanceId)
  if (!instance?.client) throw new Error("Instance not ready")
  const [response, activeSessions] = await Promise.all([
    fetchV2Sessions(instanceId, { directory: instance.folder, parentID: null, order: "desc", cursor }),
    getRootClient(instanceId).session.active().catch((error) => {
      log.warn("Failed to refresh active sessions", { instanceId, error })
      return null
    }),
  ])
  if (getSessionNextCursor(instanceId) !== cursor) return
  const deleted = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
  setSessions((previous) => {
    const next = new Map(previous)
    const current = new Map(next.get(instanceId) ?? [])
    for (const item of response.data) {
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
  await ensureV2ParentChainsLoaded(instanceId, response.data)
  if (getSessionNextCursor(instanceId) !== cursor) return
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

  try {
    log.info("v2.session.search", { instanceId, query: trimmedQuery, directory: instance.folder })
    const response = await fetchV2Sessions(instanceId, {
      search: trimmedQuery,
      directory: instance.folder,
    })
    if (!isLatestSessionSearch(instanceId, trimmedQuery, requestId)) return

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
    await ensureV2ParentChainsLoaded(instanceId, searchResults)

    if (!isLatestSessionSearch(instanceId, trimmedQuery, requestId)) return

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

  const instanceAgents = agents().get(instanceId) || []
  const primaryAgents = instanceAgents.filter(isSelectablePrimaryAgent)
  const selectedAgent = agent || primaryAgents[0]?.id || ""

  const defaultModel = await getDefaultModel(instanceId, selectedAgent)

  if (selectedAgent && isModelValid(instanceId, defaultModel)) {
    await setAgentModelPreference(instanceId, selectedAgent, defaultModel)
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

  const request = {
    sessionID: sourceSessionId,
    boundary: options?.messageId
      ? { type: "before" as const, messageID: options.messageId }
      : { type: "through" as const },
  }

  log.info(`[HTTP] POST /session.fork for instance ${instanceId}`, request)
  const info = await client.session.fork(request)
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

    if (agentRequestIds.get(requestKey) !== requestId || catalogLocationKey(getActiveCatalogLocation(instanceId)) !== catalogLocationKey(location)) return false
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
      models: Array.from(modelsById.values()).filter((model) => model.providerID === providerId).sort((a, b) => a.id.localeCompare(b.id)).map((model) => ({
        id: model.id,
        name: model.name,
        providerId,
        limit: model.limit,
        cost: model.cost[0],
        variantKeys: model.variants.map((variant) => variant.id),
      })),
    }))

    if (providerRequestIds.get(requestKey) !== requestId || catalogLocationKey(getActiveCatalogLocation(instanceId)) !== catalogLocationKey(location)) return false
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

async function loadMessages(
  instanceId: string,
  sessionId: string,
  options?: {
    force?: boolean
    registerInvalidation?: (invalidate: () => void) => void
    signal?: AbortSignal
  },
): Promise<void> {
  const force = options?.force ?? false

  const alreadyLoaded = messagesLoaded().get(instanceId)?.has(sessionId)
  if (alreadyLoaded && !force) {
    return
  }

  const previousError = getSessionMessagesLoadError(instanceId, sessionId)
  if (previousError && !force) {
    return
  }

  const isLoading = loading().loadingMessages.get(instanceId)?.has(sessionId)
  if (isLoading && !force) {
    return
  }

  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const loadEpoch = advanceMessageLoadEpoch(instanceId, sessionId)
  options?.registerInvalidation?.(() => {
    if (isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) invalidateSessionMessageLoad(instanceId, sessionId)
  })
  const messageRevision = messageStoreBus.getOrCreate(instanceId).getSessionRevision(sessionId)
  let retryAfterRevisionConflict = false

  setLoading((prev) => {
    const next = { ...prev }
    const loadingSet = next.loadingMessages.get(instanceId) || new Set()
    loadingSet.add(sessionId)
    next.loadingMessages.set(instanceId, loadingSet)
    return next
  })
  setSessionMessagesLoadError(instanceId, sessionId, null)

  try {
    log.info(`[HTTP] GET /session.${"messages"} for instance ${instanceId}`, { sessionId })
    const response: SessionMessagesResponse = await client.message.list({
      sessionID: sessionId,
      limit: 200,
      order: "desc",
    }, options?.signal ? { signal: options.signal } : undefined)
    const apiMessages = [...response.data].reverse()

    if (!instances().has(instanceId)
      || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)
      || !sessions().get(instanceId)?.has(sessionId)) return

    if (!Array.isArray(apiMessages)) {
      return
    }

    const latestSession = sessions().get(instanceId)?.get(sessionId)
    if (latestSession?.runtimeStatusKnown && latestSession.status === "idle") {
      messageStoreBus.getOrCreate(instanceId).retirePendingSends(sessionId)
    }

    setSessionMessagesLoadError(instanceId, sessionId, null)

    if (apiMessages.length === 0) {
      if (messageStoreBus.getOrCreate(instanceId).getSessionRevision(sessionId) !== messageRevision) {
        retryAfterRevisionConflict = true
      } else {
        // Authoritative empty snapshot: on a forced reconnect load the server
        // returned zero messages, so clear any stale records left over from
        // before the reconnect (hydrateMessages ignores empty input). Still
        // in-flight optimistic sends are preserved by the store.
        if (force) {
          messageStoreBus.getOrCreate(instanceId).reconcileEmptyAuthoritativeSnapshot(sessionId)
        }
        setMessagesLoaded((prev) => {
          const next = new Map(prev)
          const loadedSet = next.get(instanceId) || new Set()
          loadedSet.add(sessionId)
          next.set(instanceId, loadedSet)
          return next
        })
        const nextCursor = response.cursor?.next ?? undefined
        if (nextCursor) messageNextCursors.set(messagePageKey(instanceId, sessionId), nextCursor)
        else messageNextCursors.delete(messagePageKey(instanceId, sessionId))
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
        const apiMessage = authoritativeApiMessages[i]
        const info = messagesInfo.get(apiMessage.id)

        if (info?.role === "assistant") {
          agentName = info.mode || info.agent || ""
          providerID = info.providerID || ""
          modelID = info.modelID || ""
          if (agentName && providerID && modelID) break
        }
      }

      if (!agentName && !providerID && !modelID) {
        const defaultModel = await getDefaultModel(instanceId, session.agent)
        if (!instances().has(instanceId)
          || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)
          || !sessions().get(instanceId)?.has(sessionId)) return
        agentName = session.agent
        providerID = defaultModel.providerId
        modelID = defaultModel.modelId
      }

      setSessions((prev) => {
        if (!instances().has(instanceId) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return prev
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
      if (!instances().has(instanceId) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return
      if (!seedSessionMessagesV2(instanceId, sessionForV2, messages, messagesInfo, messageRevision)) {
        retryAfterRevisionConflict = true
      } else {
        setMessagesLoaded((prev) => {
          const next = new Map(prev)
          const loadedSet = next.get(instanceId) || new Set()
          loadedSet.add(sessionId)
          next.set(instanceId, loadedSet)
          return next
        })
        const nextCursor = response.cursor?.next ?? undefined
        if (nextCursor) messageNextCursors.set(messagePageKey(instanceId, sessionId), nextCursor)
        else messageNextCursors.delete(messagePageKey(instanceId, sessionId))
        reconcilePendingPermissionsV2(instanceId, sessionId)
      }
    }
  


  } catch (error) {
    log.error("Failed to load messages:", error)
    if (isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) {
      setSessionMessagesLoadError(instanceId, sessionId, getOpencodeErrorMessage(error, tGlobal("messageSection.loadError.detail")))
    }
    throw error
  } finally {
    if (isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) {
      setLoading((prev) => {
        const next = { ...prev }
        const loadingSet = next.loadingMessages.get(instanceId)
        if (loadingSet) loadingSet.delete(sessionId)
        return next
      })
    }
  }

  if (retryAfterRevisionConflict && sessions().get(instanceId)?.has(sessionId)) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return
    return loadMessages(instanceId, sessionId, {
      force: true,
      registerInvalidation: options?.registerInvalidation,
      signal: options?.signal,
    })
  }

  if (!instances().has(instanceId)
    || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)
    || !sessions().get(instanceId)?.has(sessionId)) return
  updateSessionInfo(instanceId, sessionId)
}

async function loadMoreMessages(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  const key = messagePageKey(instanceId, sessionId)
  const pending = messagePageRequests.get(key)
  if (pending) return pending
  const request = loadNextMessagePage(instanceId, sessionId, signal).finally(() => messagePageRequests.delete(key))
  messagePageRequests.set(key, request)
  return request
}

function hasMoreMessages(instanceId: string, sessionId: string): boolean {
  return messageNextCursors.has(messagePageKey(instanceId, sessionId))
}

async function loadNextMessagePage(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  const key = messagePageKey(instanceId, sessionId)
  const cursor = messageNextCursors.get(key)
  if (!cursor) return
  const instance = instances().get(instanceId)
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!instance?.client) throw new Error("Instance not ready")
  if (!session) throw new Error("Session not found")

  const loadEpoch = advanceMessageLoadEpoch(instanceId, sessionId)

  const response = await getRootClient(instanceId).message.list({
    sessionID: sessionId,
    limit: 200,
    order: "desc",
    cursor,
  }, signal ? { signal } : undefined)
  if (!instances().has(instanceId)
    || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)
    || !sessions().get(instanceId)?.has(sessionId)
    || messageNextCursors.get(key) !== cursor) return

  const store = messageStoreBus.getOrCreate(instanceId)
  const existingIds = store.getSessionMessageIds(sessionId)
  const existing = new Set(existingIds)
  const olderIds: string[] = []
  for (const apiMessage of [...response.data].reverse()) {
    const normalized = normalizeSessionMessage(sessionId, apiMessage)
    if (existing.has(normalized.message.id)) continue
    existing.add(normalized.message.id)
    olderIds.push(normalized.message.id)
    store.upsertMessage({
      id: normalized.message.id,
      sessionId,
      role: normalized.message.type,
      status: normalized.message.status,
      createdAt: normalized.message.timestamp,
      updatedAt: normalized.message.timestamp,
      parts: normalized.message.parts,
      isEphemeral: normalized.message.status === "sending"
        || (normalized.message.type === "assistant" && normalized.message.status === "streaming"),
    })
    store.setMessageInfo(normalized.info.id, normalized.info)
  }
  if (olderIds.length > 0) {
    store.addOrUpdateSession({
      id: sessionId,
      title: session.title,
      parentId: session.parentId,
      revert: session.revert,
      messageIds: [...olderIds, ...existingIds],
    })
    store.rebuildUsage(sessionId, store.getSessionMessageIds(sessionId)
      .map((id) => store.getMessageInfo(id))
      .filter((info): info is NonNullable<typeof info> => Boolean(info)))
  }
  const nextCursor = response.cursor?.next ?? undefined
  if (nextCursor) messageNextCursors.set(key, nextCursor)
  else messageNextCursors.delete(key)
  setMessagesLoaded((prev) => {
    const next = new Map(prev)
    const loadedSet = next.get(instanceId) || new Set()
    loadedSet.add(sessionId)
    next.set(instanceId, loadedSet)
    return next
  })
  reconcilePendingPermissionsV2(instanceId, sessionId)
  updateSessionInfo(instanceId, sessionId)
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
  hasMoreMessages,
  clearSessionListRequestState,
  clearSessionCatalogState,
}
