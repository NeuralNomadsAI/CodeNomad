import {
  getIdleSinceForStatusTransition,
  isSelectablePrimaryAgent,
  type Session,
} from "../types/session"
import type { Message } from "../types/message"
import type { SessionInfo as SDKSession, SessionMessagesResponse, SessionsResponse } from "@opencode-ai/client"

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
  getDescendantSessions,
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
} from "./session-state"
import { deleteSessionAttachments } from "./attachments"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getDefaultModel, isModelValid } from "./session-models"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2, reconcilePendingPermissionsV2, reconcilePendingQuestionsV2 } from "./message-v2/bridge"
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
  getUniqueSessionDirectories,
} from "./session-list-options"
import { mergeFetchedSessionRuntimeState, resolveAuthoritativeGenerationRecovery } from "./session-generation-recovery"

const log = getLogger("api")
const sessionListRequestIds = new Map<string, number>()
let nextSessionListRequestId = 0

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

type V2SessionListOptions = {
  directory?: string
  search?: string
}

type ProjectSessionListResponse = {
  data: SDKSession[]
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

async function fetchV2Sessions(instanceId: string, options: V2SessionListOptions): Promise<ProjectSessionListResponse> {
  const client = getRootClient(instanceId)
  const directories = getUniqueSessionDirectories([
    options.directory,
    ...getWorktrees(instanceId).map((worktree) => worktree.directory),
  ])
  const responses: SessionsResponse[] = await Promise.all(
    (directories.length ? directories : [undefined]).map((directory) => client.session.list(
      buildProjectSessionListOptions({ ...options, directory }),
    )),
  )
  const sessionsById = new Map<string, SDKSession>()
  for (const response of responses) {
    for (const session of response.data) {
      if (!sessionsById.has(session.id)) sessionsById.set(session.id, session)
    }
  }

  return {
    data: Array.from(sessionsById.values()),
  }
}

function getV2SessionItems(response: ProjectSessionListResponse): SDKSession[] {
  return response.data
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
        const apiSession = await client.session.get({ sessionID: sessionId })
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

async function ensureV2ParentChainsLoaded(instanceId: string, apiSessions: SDKSession[], directory?: string): Promise<void> {
  const currentSessions = sessions().get(instanceId) ?? new Map<string, Session>()
  const loaded = new Map<string, SDKSession | Session>(currentSessions)
  for (const session of apiSessions) loaded.set(session.id, session)

  if (!apiSessions.some((session) => hasMissingParentChain(session, loaded))) return

  const page = await fetchV2Sessions(instanceId, { directory })
  const items = getV2SessionItems(page)
  if (items.length === 0) return

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = new Map(next.get(instanceId) ?? new Map())
    const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)

    for (const apiSession of items) {
      if (deletedSessionIds.has(apiSession.id)) continue
      const existingSession = instanceSessions.get(apiSession.id)
      instanceSessions.set(apiSession.id, toClientSessionV2(instanceId, apiSession, existingSession))
      loaded.set(apiSession.id, apiSession)
    }

    next.set(instanceId, instanceSessions)
    return next
  })
}

async function fetchSessions(instanceId: string, options?: {
  reset?: boolean
  strictStatus?: boolean
  registerInvalidation?: (invalidate: () => void) => void
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
    const sessionListOptions = instance.folder ? { directory: instance.folder } : {}
    const existingSessions = new Map(sessions().get(instanceId) ?? new Map<string, Session>())

    log.info("session.list", { instanceId, limit: PROJECT_SESSION_LIST_LIMIT, directory: sessionListOptions.directory })
    const [response, activeSessions] = await Promise.all([
      fetchV2Sessions(instanceId, sessionListOptions),
      getRootClient(instanceId).session.active().catch((error) => {
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
      const existingStatus = existingSession?.status
      const active = activeSessions && Object.prototype.hasOwnProperty.call(activeSessions, apiSession.id)
      const status = activeSessions === null
        ? existingStatus ?? "idle"
        : active && existingStatus === "compacting" ? "compacting" : active ? "working" : "idle"
      const runtimeStatusKnown = activeSessions === null ? existingSession?.runtimeStatusKnown ?? false : true
      sessionMap.set(apiSession.id, {
        ...toClientSessionV2(instanceId, apiSession, existingSession),
        status,
        retry: activeSessions === null ? existingSession?.retry ?? null : null,
        idleSince: getIdleSinceForStatusTransition(existingStatus, status, existingSession?.idleSince),
        runtimeStatusKnown,
        generationRecovery: activeSessions === null
          ? existingSession?.generationRecovery ?? null
          : runtimeStatusKnown
          ? resolveAuthoritativeGenerationRecovery(existingSession?.generationRecovery, status)
          : existingSession?.generationRecovery ?? null,
      })
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

    setSessionPage(instanceId, rootIds, false, options?.reset ?? true)

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
  return
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
    await ensureV2ParentChainsLoaded(instanceId, searchResults, instance.folder)

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
    pendingQuestion: existingSession?.pendingQuestion,
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
  const selectedAgent = agent || (primaryAgents.length > 0 ? primaryAgents[0].name : "")

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

function removeSessionRuntimeState(instanceId: string, sessionId: string): void {
  cancelSessionGenerationAdmissions(instanceId, sessionId)
  markSessionDeletedAuthoritative(instanceId, sessionId)
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

async function fetchAgents(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const rootClient = getRootClient(instanceId)

  try {
    log.info(`[HTTP] GET /agent.list for instance ${instanceId}`)
    const response = await rootClient.agent.list({ location: { directory: instance.folder } })
    const agentList = (response.data ?? []).map((agent) => ({
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

    setAgents((prev) => {
      const next = new Map(prev)
      next.set(instanceId, agentList)
      return next
    })
  } catch (error) {
    log.error("Failed to fetch agents:", error)
  }
}

async function fetchProviders(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const rootClient = getRootClient(instanceId)

  try {
    log.info(`[HTTP] GET /provider.list for instance ${instanceId}`)
    const response = await rootClient.provider.list({ location: { directory: instance.folder } })
    const models = await rootClient.model.list({ location: { directory: instance.folder } })
    const providerList = response.data.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: models.data.filter((model) => model.providerID === provider.id).map((model) => ({
        id: model.id,
        name: model.name,
        providerId: provider.id,
        limit: model.limit,
        cost: model.cost[0],
        variantKeys: model.variants.map((variant) => variant.id),
      })),
    }))

    setProviders((prev) => {
      const next = new Map(prev)
      next.set(instanceId, providerList)
      return next
    })
  } catch (error) {
    log.error("Failed to fetch providers:", error)
  }
}

async function loadMessages(
  instanceId: string,
  sessionId: string,
  options?: {
    force?: boolean
    skipChildren?: boolean
    registerInvalidation?: (invalidate: () => void) => void
  },
): Promise<void> {
  const force = options?.force ?? false
  const skipChildren = options?.skipChildren ?? false

  if (force) {
    setMessagesLoaded((prev) => {
      const next = new Map(prev)
      const loadedSet = next.get(instanceId)
      if (loadedSet) {
        loadedSet.delete(sessionId)
      }
      return next
    })
  }

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
    const response: SessionMessagesResponse = await client.message.list({ sessionID: sessionId })
    const apiMessages = response.data

    if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return

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
        if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
        agentName = session.agent
        providerID = defaultModel.providerId
        modelID = defaultModel.modelId
      }

      setSessions((prev) => {
        if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return prev
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
      if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return
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
        reconcilePendingPermissionsV2(instanceId, sessionId)
        reconcilePendingQuestionsV2(instanceId, sessionId)
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
      skipChildren,
      registerInvalidation: options?.registerInvalidation,
    })
  }

  if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
  updateSessionInfo(instanceId, sessionId)

  if (!skipChildren && session.parentId === null) {
    for (const child of getDescendantSessions(instanceId, sessionId)) {
      void loadMessages(instanceId, child.id, { skipChildren: true }).catch((error) =>
        log.error("Failed to load child session messages", {
          instanceId,
          sessionId: child.id,
          parentSessionId: sessionId,
          error,
        }),
      )
    }
  }
}

export {
  createSession,
  deleteSession,
  removeSessionRuntimeState,
  fetchAgents,
  fetchProviders,

  fetchSessions,
  hydrateRestoredSessionChain,
  loadMoreSessions,
  searchSessions,
  forkSession,
  loadMessages,
  clearSessionListRequestState,
}
