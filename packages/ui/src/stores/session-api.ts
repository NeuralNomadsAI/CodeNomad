import {
  getIdleSinceForStatusTransition,
  isSelectablePrimaryAgent,
  mapSdkSessionRetry,
  mapSdkSessionStatus,
  type Session,
  type SessionStatus,
} from "../types/session"
import type { Message } from "../types/message"
import type { Session as SDKSession, SessionListResponse } from "@opencode-ai/sdk/v2/client"

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
} from "./session-state"
import { deleteSessionAttachments } from "./attachments"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getDefaultModel, isModelValid } from "./session-models"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2, reconcilePendingPermissionsV2, reconcilePendingQuestionsV2 } from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { clearCacheForSession } from "../lib/global-cache"
import { getLogger } from "../lib/logger"
import { getOpencodeErrorMessage, requestData } from "../lib/opencode-api"
import { getRootClient } from "./opencode-client"
import { tGlobal } from "../lib/i18n"
import {
  getWorktreeSlugForSession,
  getWorktreeSlugForDirectory,
  getWorktrees,
  migrateLegacyWorktreeMapToSessionMetadata,
  pruneStaleLegacyWorktreeMapEntries,
  removeLegacyParentSessionMapping,
  setWorktreeSlugForParentSession,
} from "./worktrees"
import { getOpenCodeWorkspaceIdForSession, getOpenCodeWorkspaceIdForWorktree } from "./opencode-workspaces"
import { hydrateSessionMetadataWithClient } from "./session-metadata"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
  filterProjectScopedSessions,
  getAuthoritativelyMissingSessionIds,
  isProjectSessionListComplete,
} from "./session-list-options"
import { mergeFetchedSessionRuntimeState, resolveAuthoritativeGenerationRecovery } from "./session-generation-recovery"

const log = getLogger("api")
const sessionListRequestIds = new Map<string, number>()
let nextSessionListRequestId = 0
const pendingMetadataHydrations = new Map<string, Promise<void>>()
const sessionWorkspaceHints = new Map<string, Map<string, string>>()

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

async function getSessionWorkspacePayload(instanceId: string, sessionId: string): Promise<{ workspace?: string }> {
  const hinted = sessionWorkspaceHints.get(instanceId)?.get(sessionId)
  if (hinted) return { workspace: hinted }
  const workspace = await getOpenCodeWorkspaceIdForSession(instanceId, sessionId)
  return workspace ? { workspace } : {}
}

async function getSessionWorkspaceCandidates(
  instanceId: string,
  sessionId: string,
  fallback: { workspace?: string } = {},
): Promise<Array<{ workspace?: string }>> {
  const candidates: Array<{ workspace?: string }> = []
  const seen = new Set<string>()
  const add = (candidate: { workspace?: string }) => {
    const key = candidate.workspace ?? "root"
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }
  add(await getSessionWorkspacePayload(instanceId, sessionId))
  add(fallback)
  add({})
  for (const worktree of getWorktrees(instanceId)) {
    if (!worktree.slug || worktree.slug === "root") continue
    const workspace = await getOpenCodeWorkspaceIdForWorktree(instanceId, worktree.slug)
    if (workspace) add({ workspace })
  }
  return candidates
}

function rememberSessionWorkspace(instanceId: string, sessionId: string, workspace: string | undefined): void {
  if (!workspace) return
  const hints = new Map(sessionWorkspaceHints.get(instanceId) ?? new Map())
  hints.set(sessionId, workspace)
  sessionWorkspaceHints.set(instanceId, hints)
}

async function recordSessionWorkspaceHints(instanceId: string, apiSessions: SDKSession[]): Promise<void> {
  const hints = new Map<string, string>()
  const workspaceBySlug = new Map<string, Promise<string | null>>()
  await Promise.all(apiSessions.map(async (session) => {
    const directory = (session as SDKSession & { directory?: string }).directory
    const slug = getWorktreeSlugForDirectory(instanceId, directory)
    if (!slug || slug === "root") return
    let workspace = workspaceBySlug.get(slug)
    if (!workspace) {
      workspace = getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
      workspaceBySlug.set(slug, workspace)
    }
    const workspaceId = await workspace
    if (workspaceId) hints.set(session.id, workspaceId)
  }))
  sessionWorkspaceHints.set(instanceId, hints)
}

interface SessionForkResponse {
  id: string
  title?: string
  parentID?: string | null
  agent?: string
  model?: {
    providerID?: string
    modelID?: string
  }
  metadata?: Record<string, unknown>
  time?: {
    created?: number
    updated?: number
  }
  revert?: {
    messageID?: string
    partID?: string
    snapshot?: string
    diff?: string
  }
}

type V2SessionListOptions = {
  directory?: string
  search?: string
}

type ProjectSessionListResponse = {
  data: SDKSession[]
  listedIds: Set<string>
  complete: boolean
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
  const listOptions = buildProjectSessionListOptions(options)
  const data = await requestData<SessionListResponse>(client.session.list(listOptions), "session.list")
  const allowedDirectories = [options.directory, ...getWorktrees(instanceId).map((worktree) => worktree.directory)]

  return {
    data: filterProjectScopedSessions(data, allowedDirectories),
    listedIds: new Set(data.map((session) => session.id)),
    complete: isProjectSessionListComplete(data.length),
  }
}

function getV2SessionItems(response: ProjectSessionListResponse): SDKSession[] {
  return response.data
}

async function hydrateMissingSessionMetadata(instanceId: string, sessionIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(sessionIds)).filter(Boolean)
  if (uniqueIds.length === 0) return

  const client = getRootClient(instanceId)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < uniqueIds.length) {
      const sessionId = uniqueIds[nextIndex++]!
      const session = sessions().get(instanceId)?.get(sessionId)
      if (!session || session.metadata !== undefined) continue
      try {
        await hydrateSessionMetadata(instanceId, sessionId, client)
      } catch (error) {
        log.warn("Failed to hydrate session metadata", { instanceId, sessionId, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, uniqueIds.length) }, worker))
}

function hydrateSessionMetadata(instanceId: string, sessionId: string, client = getRootClient(instanceId)): Promise<void> {
  const key = `${instanceId}:${sessionId}`
  const current = pendingMetadataHydrations.get(key)
  if (current) return current
  const hydration = (async () => {
    const candidates = await getSessionWorkspaceCandidates(instanceId, sessionId)
    let lastError: unknown
    for (const delayMs of [0, 100, 400]) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      for (const candidate of candidates) {
        try {
          await hydrateSessionMetadataWithClient(client, instanceId, sessionId, candidate)
          rememberSessionWorkspace(instanceId, sessionId, candidate.workspace)
          return
        } catch (error) {
          lastError = error
        }
      }
    }
    throw lastError
  })().finally(() => pendingMetadataHydrations.delete(key))
  pendingMetadataHydrations.set(key, hydration)
  return hydration
}

async function hydrateRestoredSessionChain(
  instanceId: string,
  requestedIds: Array<string | null | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  const client = getRootClient(instanceId)
  const pending = requestedIds.filter((id): id is string => Boolean(id) && id !== "info")
  const visited = new Set<string>()
  let chainWorkspacePayload: { workspace?: string } = {}
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const sessionId = pending.shift()!
    if (visited.has(sessionId)) continue
    visited.add(sessionId)
    if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) continue

    let session = sessions().get(instanceId)?.get(sessionId)
    if (!session) {
      try {
        const workspaceCandidates = await getSessionWorkspaceCandidates(instanceId, sessionId, chainWorkspacePayload)
        signal?.throwIfAborted()
        let apiSession: SDKSession | undefined
        let hydratedWorkspace: string | undefined
        let lastError: unknown
        for (const workspacePayload of workspaceCandidates) {
          try {
            apiSession = await requestData<SDKSession>(
              client.session.get({ sessionID: sessionId, ...workspacePayload }),
              "session.get",
            )
            hydratedWorkspace = workspacePayload.workspace
            break
          } catch (error) {
            lastError = error
          }
        }
        if (!apiSession) throw lastError
        signal?.throwIfAborted()
        rememberSessionWorkspace(instanceId, sessionId, hydratedWorkspace)
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
    } else if (session.metadata === undefined) {
      try {
        await hydrateSessionMetadata(instanceId, sessionId, client)
      } catch (error) {
        if (signal?.aborted) throw error
        log.warn("Failed to hydrate restored session metadata", { instanceId, sessionId, error })
      }
    }
    if (session?.parentId === null) {
      const rootWorkspacePayload = await getSessionWorkspacePayload(instanceId, session.id)
      if (rootWorkspacePayload.workspace) chainWorkspacePayload = rootWorkspacePayload
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

async function fetchSessions(instanceId: string, options?: { reset?: boolean }): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const rootClient = getRootClient(instanceId)
  const requestId = beginSessionListRequest(instanceId)

  setLoading((prev) => {
    const next = { ...prev }
    next.fetchingSessions.set(instanceId, true)
    return next
  })
  setSessionListError(instanceId, null)

  try {
    const sessionListOptions = instance.folder ? { directory: instance.folder } : {}
    const existingSessions = new Map(sessions().get(instanceId) ?? new Map<string, Session>())

    log.info("session.list", { instanceId, limit: PROJECT_SESSION_LIST_LIMIT, directory: sessionListOptions.directory, scope: "project" })
    const response = await fetchV2Sessions(instanceId, sessionListOptions)
    if (!isLatestSessionListRequest(instanceId, requestId)) return
    await recordSessionWorkspaceHints(instanceId, getV2SessionItems(response))

    let statusById: Record<string, any> = {}
    let statusResponseKnown = false
    try {
      const statusResponse = await rootClient.session.status()
      if (statusResponse.data && typeof statusResponse.data === "object") {
        statusResponseKnown = true
        statusById = statusResponse.data as Record<string, any>
      }
    } catch (error) {
      log.error("Failed to fetch session status:", error)
    }
    if (!isLatestSessionListRequest(instanceId, requestId)) return

    const sessionMap = new Map<string, Session>()

    for (const apiSession of getV2SessionItems(response)) {
      const existingSession = existingSessions?.get(apiSession.id)
      const existingStatus = existingSession?.status
      const rawStatus = (apiSession as any)?.status ?? statusById[apiSession.id]
      const hasType = rawStatus && typeof rawStatus === "object" && typeof rawStatus.type === "string"
      const runtimeStatusKnown = Boolean(hasType || statusResponseKnown || existingSession?.runtimeStatusKnown)

      let status: SessionStatus
      let retry = existingSession?.retry ?? null
      if (existingStatus === "compacting") {
        status = "compacting"
        retry = null
      } else {
        status = hasType ? mapSdkSessionStatus(rawStatus) : existingStatus ?? "idle"
        retry = hasType ? mapSdkSessionRetry(rawStatus) : retry
      }
      sessionMap.set(apiSession.id, {
        ...toClientSessionV2(instanceId, apiSession, existingSession),
        status,
        retry,
        idleSince: getIdleSinceForStatusTransition(existingStatus, status, existingSession?.idleSince),
        runtimeStatusKnown,
        generationRecovery: runtimeStatusKnown
          ? resolveAuthoritativeGenerationRecovery(existingSession?.generationRecovery, status)
          : existingSession?.generationRecovery ?? null,
      })
    }

    const remotelyDeletedSessionIds = getAuthoritativelyMissingSessionIds(
      existingSessions.keys(),
      response.listedIds,
      response.complete,
    )
    for (const sessionId of remotelyDeletedSessionIds) removeSessionRuntimeState(instanceId, sessionId)

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


    void (async () => {
      await hydrateMissingSessionMetadata(instanceId, rootIds)
      await migrateLegacyWorktreeMapToSessionMetadata(instanceId)
      await pruneStaleLegacyWorktreeMapEntries(instanceId)
    })().catch((error) => {
      log.warn("Failed to finish legacy worktree map migration", { instanceId, error })
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
    version: existingSession?.version || "0",
    time: {
      ...apiSession.time,
    },
    metadata: (apiSession as SDKSession & { metadata?: Session["metadata"] }).metadata ?? existingSession?.metadata,
    revert: existingSession?.revert,
    pendingPermission: existingSession?.pendingPermission,
    pendingQuestion: existingSession?.pendingQuestion,
  }
}

async function createSession(instanceId: string, agent?: string): Promise<Session> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  // New parent sessions inherit the currently active session's worktree.
  // If no session is active (fresh instance), fall back to root.
  const activeId = activeSessionId().get(instanceId)
  const worktreeSlug = activeId && activeId !== "info" ? getWorktreeSlugForSession(instanceId, activeId) : "root"
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
    const response = await client.session.create()

    if (!response.data) {
      throw new Error("Failed to create session: No data returned")
    }

    const session: Session = {
      id: response.data.id,
      instanceId,
      title: response.data.title || "New Session",
      parentId: null,
      agent: selectedAgent,
      model: defaultModel,
      status: "idle",
      idleSince: null,
      version: response.data.version,
      time: {
        ...response.data.time,
      },
      metadata: (response.data as any).metadata,
      revert: response.data.revert
        ? {
            messageID: response.data.revert.messageID,
            partID: response.data.revert.partID,
            snapshot: response.data.revert.snapshot,
            diff: response.data.revert.diff,
          }
        : undefined,
    }

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

    // Persist mapping for this *parent* session (best-effort).
    await setWorktreeSlugForParentSession(instanceId, session.id, worktreeSlug, { currentSlug: worktreeSlug }).catch((error) => {
      log.warn("Failed to persist session worktree mapping", { instanceId, sessionId: session.id, worktreeSlug, error })
    })

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

  const request: { sessionID: string; messageID?: string } = {
    sessionID: sourceSessionId,
    ...(await getSessionWorkspacePayload(instanceId, sourceSessionId)),
    messageID: options?.messageId,
  }

  log.info(`[HTTP] POST /session.fork for instance ${instanceId}`, request)
  const info = await requestData<SessionForkResponse>(
    client.session.fork(request),
    "session.fork",
  )
  const forkedSession = {
    id: info.id,
    instanceId,
    title: info.title || "Forked Session",
    parentId: info.parentID || null,
    agent: info.agent || "",
    model: {
      providerId: info.model?.providerID || "",
      modelId: info.model?.modelID || "",
    },
    status: "idle",
    idleSince: null,
    version: "0",
    metadata: info.metadata,
    time: info.time ? { ...info.time } : { created: Date.now(), updated: Date.now() },
    revert: info.revert
      ? {
          messageID: info.revert.messageID,
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
          diff: info.revert.diff,
        }
      : undefined,
  } as unknown as Session

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

  const deletingSession = sessions().get(instanceId)?.get(sessionId)

  setLoading((prev) => {
    const next = { ...prev }
    const deleting = next.deletingSession.get(instanceId) || new Set()
    deleting.add(sessionId)
    next.deletingSession.set(instanceId, deleting)
    return next
  })

  try {
    log.info(`[HTTP] DELETE /session.delete for instance ${instanceId}`, { sessionId })
    await requestData(client.session.delete({ sessionID: sessionId, ...(await getSessionWorkspacePayload(instanceId, sessionId)) }), "session.delete")

    removeSessionRuntimeState(instanceId, sessionId)

    // Clean up mapping for deleted parent sessions.
    if (deletingSession?.parentId === null) {
      await removeLegacyParentSessionMapping(instanceId, sessionId).catch(() => undefined)
    }
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
    log.info(`[HTTP] GET /app.agents for instance ${instanceId}`)
    const response = await rootClient.app.agents()
    const agentList = (response.data ?? []).map((agent) => ({
      name: agent.name,
      description: agent.description || "",
      mode: agent.mode,
      hidden: agent.hidden,
      model: agent.model?.modelID
        ? {
            providerId: agent.model.providerID || "",
            modelId: agent.model.modelID,
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
    log.info(`[HTTP] GET /config.providers for instance ${instanceId}`)
    const response = await rootClient.config.providers()
    if (!response.data) return

    const providerList = response.data.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      defaultModelId: response.data?.default?.[provider.id],
      models: Object.entries(provider.models).map(([id, model]) => ({
        id,
        name: model.name,
        providerId: provider.id,
        limit: model.limit,
        cost: model.cost,
        variantKeys: Object.keys(model.variants ?? {}),
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
  options?: { force?: boolean; skipChildren?: boolean },
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
    const apiMessages = await requestData<any[]>(
      client.session.messages({ sessionID: sessionId, ...(await getSessionWorkspacePayload(instanceId, sessionId)) }),
      "session.messages",
    )

    if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return

    if (!Array.isArray(apiMessages)) {
      return
    }

    setSessionMessagesLoadError(instanceId, sessionId, null)

    // Treat empty sessions as loaded to avoid re-fetch loops.
    setMessagesLoaded((prev) => {
      const next = new Map(prev)
      const loadedSet = next.get(instanceId) || new Set()
      loadedSet.add(sessionId)
      next.set(instanceId, loadedSet)
      return next
    })

    if (apiMessages.length === 0) {
      return
    }

    const messagesInfo = new Map<string, any>()
    const messages: Message[] = apiMessages.map((apiMessage: any) => {
      const info = apiMessage.info || apiMessage
      const role = info.role || "assistant"
      const messageId = info.id || String(Date.now())

      messagesInfo.set(messageId, info)

      const parts: any[] = (apiMessage.parts || []).map((part: any) => normalizeMessagePart(part))

      const message: Message = {
        id: messageId,
        sessionId,
        type: role === "user" ? "user" : "assistant",
        parts,
        timestamp: info.time?.created || Date.now(),
        status: "complete" as const,
        version: 0,
      }

      return message
    })

    let agentName = ""
    let providerID = ""
    let modelID = ""

    for (let i = apiMessages.length - 1; i >= 0; i--) {
      const apiMessage = apiMessages[i]
      const info = apiMessage.info || apiMessage

      if (info.role === "assistant") {
        agentName = (info as any).mode || (info as any).agent || ""
        providerID = (info as any).providerID || ""
        modelID = (info as any).modelID || ""
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
      if (!nextInstanceSessions) {
        return next
      }

      const existingSession = nextInstanceSessions.get(sessionId)
      if (!existingSession) {
        return next
      }

      const updatedSession = {
        ...existingSession,
        agent: agentName || existingSession.agent,
        model: providerID && modelID ? { providerId: providerID, modelId: modelID } : existingSession.model,
      }

      nextInstanceSessions.set(sessionId, updatedSession)
      next.set(instanceId, nextInstanceSessions)
      return next
    })

    setMessagesLoaded((prev) => {
      const next = new Map(prev)
      const loadedSet = next.get(instanceId) || new Set()
      loadedSet.add(sessionId)
      next.set(instanceId, loadedSet)
      return next
    })

    const sessionForV2 = sessions().get(instanceId)?.get(sessionId) ?? {
      id: sessionId,
      title: session?.title,
      parentId: session?.parentId ?? null,
      revert: session?.revert,
    }
    if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return
    seedSessionMessagesV2(instanceId, sessionForV2, messages, messagesInfo)

    // Permissions can be hydrated before messages/tool parts exist in the store.
    // After message hydration, try to attach any pending permissions to tool-call part ids.
    reconcilePendingPermissionsV2(instanceId, sessionId)
    reconcilePendingQuestionsV2(instanceId, sessionId)
  


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
