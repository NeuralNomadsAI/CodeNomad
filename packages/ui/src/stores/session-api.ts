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
  clearSessionSearch as clearSessionSearchState,
  isLatestSessionSearch,
  setSessionSearchResults,
  setSessionListError,
  setSessionExpanded,
  markSessionMetadataMutation,
  snapshotSessionMetadataMutationVersion,
  wasSessionMetadataMutatedAfter,
} from "./session-state"
import { deleteSessionAttachments } from "./attachments"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getDefaultModel, isModelValid } from "./session-models"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2, reconcilePendingPermissionsV2, reconcilePendingQuestionsV2, setSessionRevertV2 } from "./message-v2/bridge"
import { clearPendingDeltasForSession, getPendingDeltasForMessage, hasPendingDeltasForMessage, requestDeltaRecovery } from "./delta-buffer"
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

const log = getLogger("api")
const sessionListRequestIds = new Map<string, number>()
let nextSessionListRequestId = 0
const pendingMetadataHydrations = new Map<string, { runtimeToken: symbol | undefined; promise: Promise<void> }>()
const pendingSessionSearches = new Map<string, AbortController>()
const sessionWorkspaceHints = new Map<string, Map<string, string>>()
type BufferedDeltaExpectation = { partId: string; field: string; value: string; staleSnapshotsRemaining: number }
const bufferedDeltaSnapshotFences = new Map<string, Map<string, BufferedDeltaExpectation[]>>()
// ponytail: tolerate one settled stale snapshot; repeated omission/replacement is authoritative.
const BUFFERED_DELTA_STALE_SNAPSHOT_LIMIT = 1

class SessionMessageLoadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Session message load timed out after ${timeoutMs}ms`)
    this.name = "SessionMessageLoadTimeoutError"
  }
}

function clearBufferedDeltaSnapshotFence(instanceId: string, sessionId: string, messageId: string, partId: string): void {
  const key = `${instanceId}:${sessionId}`
  const fence = bufferedDeltaSnapshotFences.get(key)
  const expectations = fence?.get(messageId)
  if (!fence || !expectations) return
  const remaining = expectations.filter((expectation) => expectation.partId !== partId)
  if (remaining.length > 0) fence.set(messageId, remaining)
  else fence.delete(messageId)
  if (fence.size === 0) bufferedDeltaSnapshotFences.delete(key)
}

messageStoreBus.onInstanceDestroyed((instanceId) => {
  pendingSessionSearches.get(instanceId)?.abort()
  pendingSessionSearches.delete(instanceId)
  sessionWorkspaceHints.delete(instanceId)
  const prefix = `${instanceId}:`
  for (const key of pendingMetadataHydrations.keys()) if (key.startsWith(prefix)) pendingMetadataHydrations.delete(key)
  for (const key of bufferedDeltaSnapshotFences.keys()) if (key.startsWith(prefix)) bufferedDeltaSnapshotFences.delete(key)
})
messageStoreBus.onSessionCleared((instanceId, sessionId) => bufferedDeltaSnapshotFences.delete(`${instanceId}:${sessionId}`))

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

async function recordSessionWorkspaceHints(
  instanceId: string,
  apiSessions: SDKSession[],
  hasCommitAuthority: () => boolean,
): Promise<void> {
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
  if (!hasCommitAuthority()) return
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

async function fetchV2Sessions(instanceId: string, options: V2SessionListOptions, signal?: AbortSignal): Promise<ProjectSessionListResponse> {
  const client = getRootClient(instanceId)
  const listOptions = buildProjectSessionListOptions(options)
  const data = await requestData<SessionListResponse>((client.session.list as any)(listOptions, signal ? { signal } : undefined), "session.list")
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
  const instance = instances().get(instanceId)
  const current = pendingMetadataHydrations.get(key)
  if (current && current.runtimeToken === instance?.runtimeToken) return current.promise
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
    if (pendingMetadataHydrations.get(key)?.promise === hydration) pendingMetadataHydrations.delete(key)
  })
  pendingMetadataHydrations.set(key, { runtimeToken: instance?.runtimeToken, promise: hydration })
  return hydration
}

async function hydrateRestoredSessionChain(
  instanceId: string,
  requestedIds: Array<string | null | undefined>,
  signal?: AbortSignal,
  options?: { hasCommitAuthority?: () => boolean; hydrateKnownMetadata?: boolean },
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance) throw new Error("Instance not ready")
  const client = getRootClient(instanceId)
  const isCurrentInstance = () => isInstanceRuntimeCurrent(instanceId, instance) &&
    !signal?.aborted && (options?.hasCommitAuthority?.() ?? true)
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
        const metadataMutationFence = snapshotSessionMetadataMutationVersion()
        const workspaceCandidates = await getSessionWorkspaceCandidates(instanceId, sessionId, chainWorkspacePayload)
        signal?.throwIfAborted()
        if (!isCurrentInstance()) return
        let apiSession: SDKSession | undefined
        let hydratedWorkspace: string | undefined
        let lastError: unknown
        for (const workspacePayload of workspaceCandidates) {
          try {
            apiSession = await requestData<SDKSession>(
              (client.session.get as any)(
                { sessionID: sessionId, ...workspacePayload },
                signal ? { signal } : undefined,
              ),
              "session.get",
            )
            if (!isCurrentInstance()) return
            hydratedWorkspace = workspacePayload.workspace
            break
          } catch (error) {
            if (signal?.aborted) throw error
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
          if (instanceSessions.has(sessionId) && wasSessionMetadataMutatedAfter(instanceId, sessionId, metadataMutationFence)) return prev
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
    } else if (options?.hydrateKnownMetadata !== false && shouldReplaceSessionMetadata(session.metadata)) {
      try {
        await hydrateSessionMetadata(instanceId, sessionId, client)
      } catch (error) {
        if (signal?.aborted) throw error
        log.warn("Failed to hydrate restored session metadata", { instanceId, sessionId, error })
      }
    }
    session = sessions().get(instanceId)?.get(sessionId)
    if (session?.parentId === null) {
      const rootWorkspacePayload = await getSessionWorkspacePayload(instanceId, session.id)
      if (rootWorkspacePayload.workspace) chainWorkspacePayload = rootWorkspacePayload
    }
    if (session?.parentId) pending.push(session.parentId)
  }
}

async function ensureV2ParentChainsLoaded(
  instanceId: string,
  apiSessions: SDKSession[],
  hasCommitAuthority: () => boolean,
  directory?: string,
  signal?: AbortSignal,
): Promise<void> {
  const currentSessions = sessions().get(instanceId) ?? new Map<string, Session>()
  const loaded = new Map<string, SDKSession | Session>(currentSessions)
  for (const session of apiSessions) loaded.set(session.id, session)

  if (!hasCommitAuthority() || !apiSessions.some((session) => hasMissingParentChain(session, loaded))) return

  const metadataMutationFence = snapshotSessionMetadataMutationVersion()
  const page = await fetchV2Sessions(instanceId, { directory }, signal)
  if (!hasCommitAuthority()) return
  const items = getV2SessionItems(page)
  const supplementalById = new Map(items.map((session) => [session.id, session]))
  const missingAncestorIds = new Set<string>()
  for (const apiSession of apiSessions) {
    let current: SDKSession | Session = apiSession
    const seen = new Set<string>()
    while (getKnownParentId(current)) {
      const parentId = getKnownParentId(current)
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)
      const existingParent = loaded.get(parentId)
      if (existingParent) {
        current = existingParent
        continue
      }
      const supplementalParent = supplementalById.get(parentId)
      if (!supplementalParent) break
      missingAncestorIds.add(parentId)
      loaded.set(parentId, supplementalParent)
      current = supplementalParent
    }
  }
  if (missingAncestorIds.size > 0) {
    setSessions((prev) => {
      if (!hasCommitAuthority()) return prev
      const next = new Map(prev)
      const instanceSessions = new Map(next.get(instanceId) ?? new Map())
      const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)

      for (const sessionId of missingAncestorIds) {
        if (deletedSessionIds.has(sessionId)) continue
        const apiSession = supplementalById.get(sessionId)
        if (!apiSession) continue
        const existingSession = instanceSessions.get(sessionId)
        if (existingSession && wasSessionMetadataMutatedAfter(instanceId, sessionId, metadataMutationFence)) continue
        instanceSessions.set(sessionId, toClientSessionV2(instanceId, apiSession, existingSession))
      }

      next.set(instanceId, instanceSessions)
      return next
    })
  }

  await hydrateRestoredSessionChain(instanceId, apiSessions.map((session) => session.id), signal, {
    hasCommitAuthority,
    hydrateKnownMetadata: false,
  })
}

async function fetchSessions(
  instanceId: string,
  options?: { reset?: boolean; authoritativeDeletes?: boolean; signal?: AbortSignal; hasCommitAuthority?: () => boolean },
): Promise<Set<string>> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const rootClient = getRootClient(instanceId)
  const requestId = beginSessionListRequest(instanceId)
  const metadataMutationFence = snapshotSessionMetadataMutationVersion()
  const hasCommitAuthority = () => !options?.signal?.aborted &&
    (options?.hasCommitAuthority?.() ?? true) &&
    isInstanceRuntimeCurrent(instanceId, instance) &&
    isLatestSessionListRequest(instanceId, requestId)

  setLoading((prev) => {
    const next = { ...prev }
    next.fetchingSessions.set(instanceId, true)
    return next
  })
  setSessionListError(instanceId, null)

  try {
    const sessionListOptions = instance.folder ? { directory: instance.folder } : {}
    const existingSessions = new Map(sessions().get(instanceId) ?? new Map<string, Session>())
    const store = messageStoreBus.getOrCreate(instanceId)
    const residentSessionIds = new Set(store.getResidentSessionIds())
    const revertReloadIds = new Set<string>()

    log.info("session.list", { instanceId, limit: PROJECT_SESSION_LIST_LIMIT, directory: sessionListOptions.directory, scope: "project" })
    const response = await fetchV2Sessions(instanceId, sessionListOptions, options?.signal)
    if (!hasCommitAuthority()) return new Set()
    await recordSessionWorkspaceHints(instanceId, getV2SessionItems(response), hasCommitAuthority)
    if (!hasCommitAuthority()) return new Set()

    let statusById: Record<string, any> = {}
    let statusResponseKnown = false
    try {
      const statusResponse = await (rootClient.session.status as any)(undefined, options?.signal ? { signal: options.signal } : undefined)
      if (statusResponse.data && typeof statusResponse.data === "object") {
        statusResponseKnown = true
        statusById = statusResponse.data as Record<string, any>
      }
    } catch (error) {
      log.error("Failed to fetch session status:", error)
    }
    if (!hasCommitAuthority()) return new Set()

    const sessionMap = new Map<string, Session>()
    const refreshedSessionIds = new Set<string>()

    for (const apiSession of getV2SessionItems(response)) {
      const existingSession = existingSessions?.get(apiSession.id)
      const latestSession = sessions().get(instanceId)?.get(apiSession.id)
      const metadataMutated = wasSessionMetadataMutatedAfter(instanceId, apiSession.id, metadataMutationFence)
      const statusBase = metadataMutated && latestSession ? latestSession : existingSession
      const existingStatus = statusBase?.status
      const rawStatus = statusResponseKnown ? statusById[apiSession.id] : (apiSession as any)?.status ?? statusById[apiSession.id]
      const hasType = rawStatus && typeof rawStatus === "object" && typeof rawStatus.type === "string"
      const runtimeStatusKnown = Boolean(hasType || statusResponseKnown || statusBase?.runtimeStatusKnown)

      let status: SessionStatus
      let retry = statusBase?.retry ?? null
      if (existingStatus === "compacting" && !statusResponseKnown) {
        status = "compacting"
        retry = null
      } else {
        status = hasType ? mapSdkSessionStatus(rawStatus) : statusResponseKnown ? "idle" : existingStatus ?? "idle"
        retry = hasType ? mapSdkSessionRetry(rawStatus) : retry
      }

      if (metadataMutated && latestSession) {
        refreshedSessionIds.add(apiSession.id)
        if (hasType || statusResponseKnown) {
          sessionMap.set(apiSession.id, {
            ...latestSession,
            status,
            retry,
            idleSince: getIdleSinceForStatusTransition(existingStatus, status, latestSession.idleSince),
            runtimeStatusKnown,
            generationRecovery: resolveAuthoritativeGenerationRecovery(latestSession.generationRecovery, status),
          })
        }
        continue
      }

      const incomingRevert = apiSession.revert ?? null
      if (residentSessionIds.has(apiSession.id) && (
        !sameSessionRevert(existingSession?.revert, incomingRevert) ||
        !sameSessionRevert(store.getSessionRevert(apiSession.id), incomingRevert)
      )) {
        revertReloadIds.add(apiSession.id)
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
      response.complete && options?.authoritativeDeletes !== false,
    )
    for (const sessionId of remotelyDeletedSessionIds) {
      if (wasSessionMetadataMutatedAfter(instanceId, sessionId, metadataMutationFence)) continue
      removeSessionRuntimeState(instanceId, sessionId)
    }

    const committedSessionIds: string[] = []
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
        if (merged) {
          instanceSessions.set(session.id, merged)
          committedSessionIds.push(session.id)
        }
      }
      next.set(instanceId, instanceSessions)
      return next
    })
    for (const sessionId of committedSessionIds) {
      markSessionMetadataMutation(instanceId, sessionId)
      refreshedSessionIds.add(sessionId)
    }
    await Promise.all([...revertReloadIds]
      .filter((sessionId) => refreshedSessionIds.has(sessionId))
      .map(async (sessionId) => {
        invalidateSessionMessageLoad(instanceId, sessionId)
        await loadMessages(instanceId, sessionId, { force: true, signal: options?.signal })
      }))
    if (!hasCommitAuthority()) return new Set()

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
    const currentSessions = sessions().get(instanceId)
    return new Set([...refreshedSessionIds].filter((sessionId) => currentSessions?.has(sessionId)))
  } catch (error) {
    log.error("Failed to fetch sessions:", error)
    if (hasCommitAuthority()) {
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

function clearSessionSearch(instanceId: string): void {
  pendingSessionSearches.get(instanceId)?.abort()
  pendingSessionSearches.delete(instanceId)
  clearSessionSearchState(instanceId)
}

type ComparableSessionRevert = { messageID?: string; partID?: string; snapshot?: string; diff?: string }

function sameSessionRevert(left: ComparableSessionRevert | null | undefined, right: ComparableSessionRevert | null | undefined): boolean {
  return left?.messageID === right?.messageID && left?.partID === right?.partID &&
    left?.snapshot === right?.snapshot && left?.diff === right?.diff
}

async function searchSessions(instanceId: string, query: string): Promise<void> {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return

  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  pendingSessionSearches.get(instanceId)?.abort()
  const controller = new AbortController()
  pendingSessionSearches.set(instanceId, controller)
  const requestId = beginSessionSearch(instanceId, trimmedQuery)
  const metadataMutationFence = snapshotSessionMetadataMutationVersion()
  const hasCommitAuthority = () => !controller.signal.aborted && pendingSessionSearches.get(instanceId) === controller &&
    isInstanceRuntimeCurrent(instanceId, instance) && isLatestSessionSearch(instanceId, trimmedQuery, requestId)

  try {
    log.info("v2.session.search", { instanceId, query: trimmedQuery, directory: instance.folder })
    const response = await fetchV2Sessions(instanceId, {
      search: trimmedQuery,
      directory: instance.folder,
    }, controller.signal)
    if (!hasCommitAuthority()) return

    const searchResults = getV2SessionItems(response)

    if (searchResults.length === 0) {
      setSessionSearchResults(instanceId, trimmedQuery, [], requestId)
      return
    }

    const revertReloadIds = new Set<string>()
    const committedSessionIds: string[] = []
    const residentSessionIds = new Set(messageStoreBus.getOrCreate(instanceId).getResidentSessionIds())
    setSessions((prev) => {
      if (!hasCommitAuthority()) return prev
      const next = new Map(prev)
      const instanceSessions = new Map(next.get(instanceId) ?? new Map())
      const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)

      for (const apiSession of searchResults) {
        if (deletedSessionIds.has(apiSession.id)) continue
        const existingSession = instanceSessions.get(apiSession.id)
        if (existingSession && wasSessionMetadataMutatedAfter(instanceId, apiSession.id, metadataMutationFence)) continue
        const incomingRevert = apiSession.revert ?? null
        const storeRevert = messageStoreBus.getOrCreate(instanceId).getSessionRevert(apiSession.id)
        if ((existingSession && !sameSessionRevert(existingSession.revert, incomingRevert)) ||
          (residentSessionIds.has(apiSession.id) && !sameSessionRevert(storeRevert, incomingRevert))) {
          revertReloadIds.add(apiSession.id)
        }
        instanceSessions.set(apiSession.id, toClientSessionV2(instanceId, apiSession, existingSession))
        committedSessionIds.push(apiSession.id)
      }

      next.set(instanceId, instanceSessions)
      return next
    })
    for (const sessionId of committedSessionIds) markSessionMetadataMutation(instanceId, sessionId)

    await ensureV2ParentChainsLoaded(
      instanceId,
      searchResults,
      hasCommitAuthority,
      instance.folder,
      controller.signal,
    )

    if (!hasCommitAuthority()) return

    await Promise.all([...revertReloadIds].map(async (sessionId) => {
      invalidateSessionMessageLoad(instanceId, sessionId)
      await loadMessages(instanceId, sessionId, { force: true, signal: controller.signal })
    }))
    if (!hasCommitAuthority()) return

    const deletedSessionIds = getAuthoritativelyDeletedSessionIdsForInstance(instanceId)
    const currentSearchResults = searchResults.filter((session) =>
      !deletedSessionIds.has(session.id) && Boolean(getSessionRoot(instanceId, session.id)))

    syncInstanceSessionIndicator(instanceId)
    setSessionSearchResults(instanceId, trimmedQuery, currentSearchResults.map((session) => session.id), requestId)
  } catch (error) {
    if (controller.signal.aborted) return
    log.error("Failed to search sessions:", error)
    if (hasCommitAuthority()) {
      clearSessionSearchState(instanceId)
    }
    throw error
  } finally {
    if (pendingSessionSearches.get(instanceId) === controller) pendingSessionSearches.delete(instanceId)
  }
}

function toClientSessionV2(
  instanceId: string,
  apiSession: SDKSession,
  existingSession?: Session,
): Session {
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
    revert: apiSession.revert ? { ...apiSession.revert } : undefined,
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

async function fetchAgents(instanceId: string, signal?: AbortSignal, hasCommitAuthority: () => boolean = () => true): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const rootClient = getRootClient(instanceId)

  try {
    log.info(`[HTTP] GET /app.agents for instance ${instanceId}`)
    const response = await rootClient.app.agents(undefined, signal ? { signal } : undefined)
    if (signal?.aborted || !hasCommitAuthority() || !isInstanceRuntimeCurrent(instanceId, instance)) return
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

async function fetchProviders(instanceId: string, signal?: AbortSignal, hasCommitAuthority: () => boolean = () => true): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const rootClient = getRootClient(instanceId)

  try {
    log.info(`[HTTP] GET /config.providers for instance ${instanceId}`)
    const response = await rootClient.config.providers(undefined, signal ? { signal } : undefined)
    if (signal?.aborted || !hasCommitAuthority() || !isInstanceRuntimeCurrent(instanceId, instance)) return
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
  options?: { force?: boolean; timeoutMs?: number; applySessionRevert?: boolean; signal?: AbortSignal },
): Promise<void> {
  options?.signal?.throwIfAborted()
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

  let session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    await hydrateRestoredSessionChain(instanceId, [sessionId], options?.signal, { hydrateKnownMetadata: false })
    options?.signal?.throwIfAborted()
    session = sessions().get(instanceId)?.get(sessionId)
    if (!session) throw new Error("Session not found")
  }

  const { epoch: loadEpoch, signal: loadSignal, abort: abortLoad } = beginSessionMessageLoad(instanceId, sessionId)
  const abortFromCaller = () => abortLoad(options?.signal?.reason)
  options?.signal?.addEventListener("abort", abortFromCaller, { once: true })
  if (options?.signal?.aborted) abortFromCaller()
  let loadTimeout: ReturnType<typeof setTimeout> | undefined
  const loadTimeoutPromise = options?.timeoutMs
    ? new Promise<never>((_resolve, reject) => {
        loadTimeout = setTimeout(() => {
          const error = new SessionMessageLoadTimeoutError(options.timeoutMs!)
          abortLoad(error)
          reject(error)
        }, options.timeoutMs)
      })
    : undefined
  const awaitLoad = <T>(promise: Promise<T>): Promise<T> => loadTimeoutPromise ? Promise.race([promise, loadTimeoutPromise]) : promise
  const store = messageStoreBus.getOrCreate(instanceId)
  const expectedRevision = store.getSessionRevision(sessionId)
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
    let apiMessages: any[]
    try {
      const workspacePayload = await awaitLoad(getSessionWorkspacePayload(instanceId, sessionId))
      apiMessages = await awaitLoad(requestData<any[]>(
        client.session.messages({ sessionID: sessionId, ...workspacePayload }, { signal: loadSignal }),
        "session.messages",
      ))
    } catch (error) {
      if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
      throw error
    }

    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return

    if (!Array.isArray(apiMessages)) {
      return
    }

    setSessionMessagesLoadError(instanceId, sessionId, null)

    const latestStatus = sessions().get(instanceId)?.get(sessionId)?.status ?? sessionForV2.status
    const adapted = adaptApiMessages(sessionId, apiMessages, latestStatus)

    let agentName = ""
    let providerID = ""
    let modelID = ""
    if (apiMessages.length > 0) {

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
        const defaultModel = await awaitLoad(getDefaultModel(instanceId, session.agent))
        if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch) || !sessions().get(instanceId)?.has(sessionId)) return
        agentName = session.agent
        providerID = defaultModel.providerId
        modelID = defaultModel.modelId
      }

    }

    const latestSession = sessions().get(instanceId)?.get(sessionId) ?? sessionForV2
    const applySessionRevert = options?.applySessionRevert !== false
    if (!isInstanceRuntimeCurrent(instanceId, instance) || !isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) return
    const snapshotFenceKey = `${instanceId}:${sessionId}`
    const residentMessageIds = new Set(store.getSessionMessageIds(sessionId))
    const snapshotFence = bufferedDeltaSnapshotFences.get(snapshotFenceKey) ?? new Map<string, BufferedDeltaExpectation[]>()
    for (const messageId of snapshotFence.keys()) if (!residentMessageIds.has(messageId)) snapshotFence.delete(messageId)
    for (const messageId of residentMessageIds) {
      const pendingDeltas = getPendingDeltasForMessage(instanceId, messageId)
      if (pendingDeltas.length === 0) continue
      const record = store.getMessage(messageId)
      snapshotFence.set(messageId, pendingDeltas.map(({ partId, field, delta }) => {
        const current = (record?.parts[partId]?.data as any)?.[field]
        return {
          partId,
          field,
          value: `${current ?? ""}${delta}`,
          staleSnapshotsRemaining: BUFFERED_DELTA_STALE_SNAPSHOT_LIMIT,
        }
      }))
    }
    if (snapshotFence.size > 0) bufferedDeltaSnapshotFences.set(snapshotFenceKey, snapshotFence)
    else bufferedDeltaSnapshotFences.delete(snapshotFenceKey)

    const incomingMessages = new Map(adapted.messages.map((message) => [message.id, message]))
    let snapshotFenced = adapted.messages.some((message) => hasPendingDeltasForMessage(instanceId, message.id))
    for (const [messageId, expectations] of snapshotFence) {
      if (hasPendingDeltasForMessage(instanceId, messageId)) {
        snapshotFenced = true
        continue
      }
      const incoming = incomingMessages.get(messageId)
      const mismatches = expectations.filter(({ partId, field, value }) => {
        if (!incoming) return true
        const part = incoming.parts.find((candidate: any) => candidate.id === partId) as any
        const incomingValue = part?.[field]
        return typeof incomingValue !== "string" || !incomingValue.startsWith(value)
      })
      if (mismatches.length === 0) {
        snapshotFence.delete(messageId)
      } else if (mismatches.some((expectation) => expectation.staleSnapshotsRemaining > 0)) {
        for (const expectation of mismatches) expectation.staleSnapshotsRemaining = Math.max(0, expectation.staleSnapshotsRemaining - 1)
        snapshotFenced = true
      } else {
        snapshotFence.delete(messageId)
      }
    }
    if (snapshotFence.size > 0) bufferedDeltaSnapshotFences.set(snapshotFenceKey, snapshotFence)
    else bufferedDeltaSnapshotFences.delete(snapshotFenceKey)
    if (snapshotFenced) {
      retryAfterRevisionConflict = true
    } else if (!seedSessionMessagesV2(
      instanceId,
      applySessionRevert ? latestSession : { id: latestSession.id, title: latestSession.title, parentId: latestSession.parentId },
      adapted.messages,
      adapted.infos,
      expectedRevision,
    )) {
      retryAfterRevisionConflict = true
    } else {
      bufferedDeltaSnapshotFences.delete(snapshotFenceKey)
      if (apiMessages.length > 0) {
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
      if (applySessionRevert) setSessionRevertV2(instanceId, sessionId, latestSession.revert ?? null)
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
  


  } catch (error) {
    if (options?.signal?.aborted) return
    log.error("Failed to load messages:", error)
    if (isInstanceRuntimeCurrent(instanceId, instance) && isCurrentMessageLoad(instanceId, sessionId, loadEpoch)) {
      setSessionMessagesLoadError(instanceId, sessionId, getOpencodeErrorMessage(error, tGlobal("messageSection.loadError.detail")))
    }
    throw error
  } finally {
    options?.signal?.removeEventListener("abort", abortFromCaller)
    if (loadTimeout) clearTimeout(loadTimeout)
    finishSessionMessageLoad(instanceId, sessionId, loadEpoch)
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
  clearBufferedDeltaSnapshotFence,
  createSession,
  deleteSession,
  removeSessionRuntimeState,
  fetchAgents,
  fetchProviders,

  fetchSessions,
  hydrateRestoredSessionChain,
  loadMoreSessions,
  clearSessionSearch,
  searchSessions,
  forkSession,
  loadMessages,
  SessionMessageLoadTimeoutError,
  clearSessionListRequestState,
}
