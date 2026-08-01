import {
  getIdleSinceForStatusTransition,
  isSelectablePrimaryAgent,
  mapSdkSessionRetry,
  mapSdkSessionStatus,
  type Session,
  type SessionStatus,
} from "../types/session"
import type { Message, MessageInfo } from "../types/message"
import type { Instance } from "../types/instance"
import type { Session as SDKSession, SessionListResponse } from "@opencode-ai/sdk/v2/client"

import { clearSessionInterruptions, instances, isInstanceRuntimeCurrent, reconcilePendingSessionIndicators } from "./instances"
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
  beginSessionMessageLoad,
  finishSessionMessageLoad,
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
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { mergeCachedSessionMessagePageV2, seedSessionMessagesV2, reconcilePendingPermissionsV2, reconcilePendingQuestionsV2, setSessionRevertV2 } from "./message-v2/bridge"
import { clearPendingDeltasForMessage, clearPendingDeltasForSession, requestDeltaRecovery } from "./delta-buffer"
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
import { preferSessionMetadata, shouldReplaceSessionMetadata } from "./session-metadata-completeness"
import {
  PROJECT_SESSION_LIST_LIMIT,
  buildProjectSessionListOptions,
  filterProjectScopedSessions,
  getAuthoritativelyMissingSessionIds,
  isProjectSessionListComplete,
} from "./session-list-options"
import { mergeFetchedSessionRuntimeState, resolveAuthoritativeGenerationRecovery } from "./session-generation-recovery"
import {
  cacheAuthoritativeSessionMessages,
  cancelCachedSessionMessageRestore,
  clearCachedSessionMessageShift,
  invalidateSessionMessageCache,
  restoreCachedSessionMessagePages,
} from "./session-message-cache"
import { restorePreviousStateEnabled } from "./client-state"

const log = getLogger("api")
const sessionListRequestIds = new Map<string, number>()
let nextSessionListRequestId = 0
const pendingMetadataHydrations = new Map<string, Promise<void>>()
const sessionWorkspaceHints = new Map<string, Map<string, string>>()
messageStoreBus.onInstanceDestroyed((instanceId) => {
  sessionWorkspaceHints.delete(instanceId)
  const prefix = `${instanceId}:`
  for (const key of pendingMetadataHydrations.keys()) if (key.startsWith(prefix)) pendingMetadataHydrations.delete(key)
})

function adaptApiMessages(
  sessionId: string,
  apiMessages: any[],
  sessionStatus: SessionStatus = "idle",
): { messages: Message[]; infos: Map<string, MessageInfo> } {
  const infos = new Map<string, MessageInfo>()
  const messages = apiMessages.map((apiMessage: any, index: number) => {
    const info = (apiMessage.info || apiMessage) as MessageInfo
    const messageId = info.id || String(Date.now())
    infos.set(messageId, info)
    return {
      id: messageId,
      sessionId,
      type: info.role === "user" ? "user" as const : "assistant" as const,
      parts: (apiMessage.parts || []).map((part: any) => normalizeMessagePart(part)),
      timestamp: info.time?.created || Date.now(),
      status: (info as any).error
        ? "error" as const
        : info.role === "assistant" && index === apiMessages.length - 1 &&
            !info.time?.completed && !(info.time as { end?: number } | undefined)?.end &&
            (sessionStatus === "working" || sessionStatus === "compacting")
          ? "streaming" as const
          : "complete" as const,
      version: 0,
    }
  })
  return { messages, infos }
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
  const hints = new Map(sessionWorkspaceHints.get(instanceId) ?? new Map<string, string>())
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
      if (!session || !shouldReplaceSessionMetadata(session.metadata)) continue
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
  const instance = instances().get(instanceId)
  const hydration = (async () => {
    const candidates = await getSessionWorkspaceCandidates(instanceId, sessionId)
    let lastError: unknown
    for (const delayMs of [0, 100, 400]) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      for (const candidate of candidates) {
        try {
          await hydrateSessionMetadataWithClient(client, instanceId, sessionId, candidate, () => isInstanceRuntimeCurrent(instanceId, instance))
          if (!isInstanceRuntimeCurrent(instanceId, instance)) return
          rememberSessionWorkspace(instanceId, sessionId, candidate.workspace)
          return
        } catch (error) {
          lastError = error
        }
      }
    }
    throw lastError
  })().finally(() => {
    if (pendingMetadataHydrations.get(key) === hydration) pendingMetadataHydrations.delete(key)
  })
  pendingMetadataHydrations.set(key, hydration)
  return hydration
}

async function hydrateRestoredSessionChain(
  instanceId: string,
  requestedIds: Array<string | null | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance) throw new Error("Instance not ready")
  const client = getRootClient(instanceId)
  const isCurrentInstance = () => isInstanceRuntimeCurrent(instanceId, instance)
  const pending = requestedIds.filter((id): id is string => Boolean(id) && id !== "info")
  const visited = new Set<string>()
  let chainWorkspacePayload: { workspace?: string } = {}
  while (pending.length > 0) {
    signal?.throwIfAborted()
    if (!isCurrentInstance()) return
    const sessionId = pending.shift()!
    if (visited.has(sessionId)) continue
    visited.add(sessionId)
    if (getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId)) continue

    let session = sessions().get(instanceId)?.get(sessionId)
    if (!session) {
      try {
        const workspaceCandidates = await getSessionWorkspaceCandidates(instanceId, sessionId, chainWorkspacePayload)
        signal?.throwIfAborted()
        if (!isCurrentInstance()) return
        let apiSession: SDKSession | undefined
        let hydratedWorkspace: string | undefined
        let lastError: unknown
        for (const workspacePayload of workspaceCandidates) {
          try {
            apiSession = await requestData<SDKSession>(
              client.session.get({ sessionID: sessionId, ...workspacePayload }),
              "session.get",
            )
            if (!isCurrentInstance()) return
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
          if (!isCurrentInstance() || getAuthoritativelyDeletedSessionIdsForInstance(instanceId).has(sessionId) || signal?.aborted) return prev
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
    } else if (shouldReplaceSessionMetadata(session.metadata)) {
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

async function ensureV2ParentChainsLoaded(instanceId: string, apiSessions: SDKSession[], instance: Instance, directory?: string): Promise<void> {
  const currentSessions = sessions().get(instanceId) ?? new Map<string, Session>()
  const loaded = new Map<string, SDKSession | Session>(currentSessions)
  for (const session of apiSessions) loaded.set(session.id, session)

  if (!apiSessions.some((session) => hasMissingParentChain(session, loaded))) return

  const page = await fetchV2Sessions(instanceId, { directory })
  if (!isInstanceRuntimeCurrent(instanceId, instance)) return
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
    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isLatestSessionListRequest(instanceId, requestId)) return
    await recordSessionWorkspaceHints(instanceId, getV2SessionItems(response))
    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isLatestSessionListRequest(instanceId, requestId)) return

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
    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isLatestSessionListRequest(instanceId, requestId)) return

    const sessionMap = new Map<string, Session>()

    for (const apiSession of getV2SessionItems(response)) {
      const existingSession = existingSessions?.get(apiSession.id)
      const existingStatus = existingSession?.status
      const rawStatus = (apiSession as any)?.status ?? statusById[apiSession.id]
      const hasType = rawStatus && typeof rawStatus === "object" && typeof rawStatus.type === "string"
      const runtimeStatusKnown = Boolean(hasType || statusResponseKnown || existingSession?.runtimeStatusKnown)

      let status: SessionStatus
      let retry = existingSession?.retry ?? null
      if (existingStatus === "compacting" && !statusResponseKnown) {
        status = "compacting"
        retry = null
      } else {
        status = hasType ? mapSdkSessionStatus(rawStatus) : statusResponseKnown ? "idle" : existingStatus ?? "idle"
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
    if (isInstanceRuntimeCurrent(instanceId, instance) && isLatestSessionListRequest(instanceId, requestId)) {
      setSessionListError(instanceId, getOpencodeErrorMessage(error, tGlobal("sessionList.loadError.detail")))
    }
    throw error
  } finally {
    if (isInstanceRuntimeCurrent(instanceId, instance) && isLatestSessionListRequest(instanceId, requestId)) {
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
    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isLatestSessionSearch(instanceId, trimmedQuery, requestId)) return

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
    void hydrateMissingSessionMetadata(instanceId, searchResults.map((session) => session.id))

    await ensureV2ParentChainsLoaded(instanceId, searchResults, instance, instance.folder)

    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isLatestSessionSearch(instanceId, trimmedQuery, requestId)) return

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
    if (isInstanceRuntimeCurrent(instanceId, instance) && isLatestSessionSearch(instanceId, trimmedQuery, requestId)) {
      clearSessionSearch(instanceId)
    }
    throw error
  }
}

function toClientSessionV2(instanceId: string, apiSession: SDKSession, existingSession?: Session): Session {
  const incomingMetadata = (apiSession as SDKSession & { metadata?: Session["metadata"] }).metadata
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
    metadata: preferSessionMetadata(incomingMetadata, existingSession?.metadata),
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
  if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")

  if (selectedAgent && isModelValid(instanceId, defaultModel)) {
    await setAgentModelPreference(instanceId, selectedAgent, defaultModel)
    if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")
  }

  setLoading((prev) => {
    const next = { ...prev }
    next.creatingSession.set(instanceId, true)
    return next
  })

  try {
    log.info(`[HTTP] POST /session.create for instance ${instanceId}`)
    const response = await client.session.create()
    if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")

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

    if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")
    return session
  } catch (error) {
    log.error("Failed to create session:", error)
    throw error
  } finally {
    if (isInstanceRuntimeCurrent(instanceId, instance)) {
      setLoading((prev) => {
        const next = { ...prev }
        next.creatingSession.set(instanceId, false)
        return next
      })
    }
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
  if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")

  log.info(`[HTTP] POST /session.fork for instance ${instanceId}`, request)
  const info = await requestData<SessionForkResponse>(
    client.session.fork(request),
    "session.fork",
  )
  if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")
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
    const workspace = await getSessionWorkspacePayload(instanceId, sessionId)
    if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")
    await requestData(client.session.delete({ sessionID: sessionId, ...workspace }), "session.delete")
    if (!isInstanceRuntimeCurrent(instanceId, instance)) throw new Error("Instance no longer active")

    removeSessionRuntimeState(instanceId, sessionId)

    // Clean up mapping for deleted parent sessions.
    if (deletingSession?.parentId === null) {
      await removeLegacyParentSessionMapping(instanceId, sessionId).catch(() => undefined)
    }
  } catch (error) {
    log.error("Failed to delete session:", error)
    throw error
  } finally {
    if (isInstanceRuntimeCurrent(instanceId, instance)) {
      setLoading((prev) => {
        const next = { ...prev }
        const deleting = next.deletingSession.get(instanceId)
        if (deleting) deleting.delete(sessionId)
        return next
      })
    }
  }
}

function removeSessionRuntimeState(instanceId: string, sessionId: string): void {
  clearPendingDeltasForSession(instanceId, sessionId)
  invalidateSessionMessageCache(instanceId, sessionId)
  sessionWorkspaceHints.get(instanceId)?.delete(sessionId)
  cancelSessionGenerationAdmissions(instanceId, sessionId)
  markSessionDeletedAuthoritative(instanceId, sessionId)
  deleteSessionAttachments(instanceId, sessionId)
  clearSessionDraftPrompt(instanceId, sessionId)
  setSessionExpanded(instanceId, sessionId, false)
  clearSessionInterruptions(instanceId, sessionId)

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
    if (!isInstanceRuntimeCurrent(instanceId, instance)) return
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
    if (!isInstanceRuntimeCurrent(instanceId, instance)) return
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
  options?: { force?: boolean; revisionRetryCount?: number },
): Promise<void> {
  const force = options?.force ?? false
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

  cancelCachedSessionMessageRestore(instanceId, sessionId)
  const { epoch: loadEpoch, signal: loadSignal } = beginSessionMessageLoad(instanceId, sessionId)
  const store = messageStoreBus.getOrCreate(instanceId)
  let expectedRevision = store.getSessionRevision(sessionId)
  let retryAfterRevisionConflict = false
  const sessionForV2 = session

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
    const apiMessagesRequest = getSessionWorkspacePayload(instanceId, sessionId).then((workspacePayload) =>
      requestData<any[]>(client.session.messages({ sessionID: sessionId, ...workspacePayload }, { signal: loadSignal }), "session.messages"),
    )
    const apiOutcome = apiMessagesRequest.then(
      (messages) => ({ ok: true as const, messages }),
      (error) => ({ ok: false as const, error }),
    )
    let outcome: Awaited<typeof apiOutcome> | undefined
    let failedOutcome: Extract<Awaited<typeof apiOutcome>, { ok: false }> | undefined
    let restoredCache = false
    let restoredCacheComplete = true
    let restoredCacheFinished = false

    if (!force && restorePreviousStateEnabled() && store.getSessionMessageIds(sessionId).length === 0) {
      const pages = restoreCachedSessionMessagePages(instanceId, sessionId)
      const iterator = pages[Symbol.asyncIterator]()
      let cacheNext = iterator.next()
      try {
        while (!outcome) {
          const winner = await Promise.race([
            failedOutcome
              ? new Promise<never>(() => undefined)
              : apiOutcome.then((value) => ({ kind: "http" as const, value })),
            cacheNext.then((value) => ({ kind: "cache" as const, value })),
          ])
          if (winner.kind === "http") {
            if (!winner.value.ok) {
              failedOutcome = winner.value
              continue
            }
            outcome = winner.value
            cancelCachedSessionMessageRestore(instanceId, sessionId, { preserveShift: true })
            void iterator.return?.(undefined).catch(() => undefined)
            break
          }
          if (winner.value.done) {
            outcome = await apiOutcome
            break
          }
          cacheNext = iterator.next()
          if (!isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) {
            cancelCachedSessionMessageRestore(instanceId, sessionId)
            return
          }
          if (!isInstanceRuntimeCurrent(instanceId, instance)) return
          const cached = adaptApiMessages(sessionId, winner.value.value.messages, "idle")
          const revision = mergeCachedSessionMessagePageV2(
            instanceId,
            sessionForV2,
            cached.messages,
            cached.infos,
            expectedRevision,
          )
          if (revision === null) {
            cancelCachedSessionMessageRestore(instanceId, sessionId)
            void iterator.return?.(undefined).catch(() => undefined)
            outcome = await apiOutcome
            break
          }
          expectedRevision = revision
          restoredCache = true
          restoredCacheComplete &&= winner.value.value.complete
          restoredCacheFinished ||= winner.value.value.done
          reconcilePendingPermissionsV2(instanceId, sessionId)
          reconcilePendingQuestionsV2(instanceId, sessionId)
        }
      } catch (error) {
        log.warn("Failed to restore cached session messages", { instanceId, sessionId, error })
        invalidateSessionMessageCache(instanceId, sessionId)
      }
    }

    outcome ??= failedOutcome ?? await apiOutcome
    cancelCachedSessionMessageRestore(instanceId, sessionId, { preserveShift: true })
    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
    if (!outcome.ok && restoredCache && restoredCacheComplete && restoredCacheFinished) {
      setMessagesLoaded((prev) => {
        const next = new Map(prev)
        const loadedSet = next.get(instanceId) ?? new Set<string>()
        loadedSet.add(sessionId)
        next.set(instanceId, loadedSet)
        return next
      })
      log.warn("Using cached session messages after HTTP failure", { instanceId, sessionId, error: outcome.error })
      return
    }
    if (!outcome.ok) throw outcome.error
    const apiMessages = outcome.messages

    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return

    if (!Array.isArray(apiMessages)) {
      return
    }

    setSessionMessagesLoadError(instanceId, sessionId, null)

    const latestStatus = sessions().get(instanceId)?.get(sessionId)?.status ?? sessionForV2.status
    const adapted = adaptApiMessages(sessionId, apiMessages, latestStatus)

    if (apiMessages.length > 0) {

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
        if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
        agentName = session.agent
        providerID = defaultModel.providerId
        modelID = defaultModel.modelId
      }

      setSessions((prev) => {
        if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return prev
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

    }

    const latestSession = sessions().get(instanceId)?.get(sessionId) ?? sessionForV2
    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return
    for (const message of adapted.messages) {
      if (clearPendingDeltasForMessage(instanceId, message.id)) retryAfterRevisionConflict = true
    }
    if (!seedSessionMessagesV2(instanceId, latestSession, adapted.messages, adapted.infos, expectedRevision)) {
      retryAfterRevisionConflict = true
    } else {
      if (latestSession.revert) setSessionRevertV2(instanceId, sessionId, latestSession.revert)
      setMessagesLoaded((prev) => {
        const next = new Map(prev)
        const loadedSet = next.get(instanceId) || new Set()
        loadedSet.add(sessionId)
        next.set(instanceId, loadedSet)
        return next
      })
      reconcilePendingPermissionsV2(instanceId, sessionId)
      reconcilePendingQuestionsV2(instanceId, sessionId)
      if (restorePreviousStateEnabled() && !retryAfterRevisionConflict) {
        void cacheAuthoritativeSessionMessages(instanceId, sessionId, store.getSessionRevision(sessionId)).catch((error) =>
          log.warn("Failed to persist authoritative session messages", { instanceId, sessionId, error }),
        )
      }
    }
  


  } catch (error) {
    log.error("Failed to load messages:", error)
    if (isInstanceRuntimeCurrent(instanceId, instance) && isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) {
      setSessionMessagesLoadError(instanceId, sessionId, getOpencodeErrorMessage(error, tGlobal("messageSection.loadError.detail")))
    }
    throw error
  } finally {
    finishSessionMessageLoad(instanceId, sessionId, loadEpoch)
    if (isInstanceRuntimeCurrent(instanceId, instance) && isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) {
      const clearShift = () => {
        if (isInstanceRuntimeCurrent(instanceId, instance) && isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) clearCachedSessionMessageShift(instanceId, sessionId)
      }
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(clearShift)
      else setTimeout(clearShift, 0)
    }
    if (isInstanceRuntimeCurrent(instanceId, instance) && isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) {
      setLoading((prev) => {
        const next = { ...prev }
        const loadingSet = next.loadingMessages.get(instanceId)
        if (loadingSet) loadingSet.delete(sessionId)
        return next
      })
    }
  }

  if (retryAfterRevisionConflict && sessions().get(instanceId)?.has(sessionId)) {
    if ((options?.revisionRetryCount ?? 0) < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
      return loadMessages(instanceId, sessionId, {
        force: true,
        revisionRetryCount: (options?.revisionRetryCount ?? 0) + 1,
      })
    }
    setMessagesLoaded((prev) => {
      const next = new Map(prev)
      next.get(instanceId)?.delete(sessionId)
      return next
    })
    requestDeltaRecovery({ instanceId, sessionId, messageId: "reconcile", partId: "reconcile", field: "text" })
    return
  }

  if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
  updateSessionInfo(instanceId, sessionId)

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
