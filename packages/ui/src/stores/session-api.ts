import type { Session, SessionStatus } from "../types/session"
import type { Message } from "../types/message"

import { instances, stopInstance } from "./instances"
import { preferences, setAgentModelPreference } from "./preferences"
import { setSessionCompactionState } from "./session-compaction"
import {
  activeSessionId,
  agents,
  clearSessionDraftPrompt,
  getChildSessions,
  isBlankSession,
  isSubagentTitle,
  messagesLoaded,
  pruneDraftPrompts,
  providers,
  setActiveSessionId,
  setAgents,
  setMessagesLoaded,
  setProviders,
  setSessionInfoByInstance,
  setSessions,
  sessions,
  loading,
  setLoading,
  cleanupBlankSessions,
} from "./session-state"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getDefaultModel, isModelValid } from "./session-models"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2 } from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { clearCacheForSession } from "../lib/global-cache"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

// ---------------------------------------------------------------------------
// localStorage session cache – safety net for hard-refresh race conditions
// ---------------------------------------------------------------------------

const SESSION_CACHE_KEY = "opencode-session-cache-v1"
const SESSION_CACHE_TTL_MS = 3_600_000 // 1 hour

interface SessionCacheEntry {
  data: any[]
  cachedAt: number
}

function normalizeFolder(folder: string): string {
  return folder.endsWith("/") ? folder.slice(0, -1) : folder
}

function saveSessionCache(folder: string, data: any[]): void {
  if (typeof window === "undefined") return
  try {
    const key = normalizeFolder(folder)
    const raw = window.localStorage.getItem(SESSION_CACHE_KEY)
    const cache: Record<string, SessionCacheEntry> = raw ? JSON.parse(raw) : {}
    cache[key] = { data, cachedAt: Date.now() }
    window.localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // localStorage may be full or unavailable – silently ignore
  }
}

function loadSessionCache(folder: string): any[] | null {
  if (typeof window === "undefined") return null
  try {
    const key = normalizeFolder(folder)
    const raw = window.localStorage.getItem(SESSION_CACHE_KEY)
    if (!raw) return null
    const cache: Record<string, SessionCacheEntry> = JSON.parse(raw)
    const entry = cache[key]
    if (!entry) return null
    if (Date.now() - entry.cachedAt > SESSION_CACHE_TTL_MS) return null
    if (!Array.isArray(entry.data) || entry.data.length === 0) return null
    return entry.data
  } catch {
    return null
  }
}

function removeSessionFromCache(folder: string, sessionId: string): void {
  if (typeof window === "undefined") return
  try {
    const key = normalizeFolder(folder)
    const raw = window.localStorage.getItem(SESSION_CACHE_KEY)
    if (!raw) return
    const cache: Record<string, SessionCacheEntry> = JSON.parse(raw)
    const entry = cache[key]
    if (!entry) return
    entry.data = entry.data.filter((s: any) => s.id !== sessionId)
    entry.cachedAt = Date.now()
    window.localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // silently ignore
  }
}

function addSessionToCache(folder: string, apiSession: any): void {
  if (typeof window === "undefined") return
  try {
    const key = normalizeFolder(folder)
    const raw = window.localStorage.getItem(SESSION_CACHE_KEY)
    const cache: Record<string, SessionCacheEntry> = raw ? JSON.parse(raw) : {}
    const entry = cache[key] || { data: [], cachedAt: Date.now() }
    // Replace if exists, otherwise prepend
    const idx = entry.data.findIndex((s: any) => s.id === apiSession.id)
    if (idx >= 0) {
      entry.data[idx] = apiSession
    } else {
      entry.data.unshift(apiSession)
    }
    entry.cachedAt = Date.now()
    cache[key] = entry
    window.localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // silently ignore
  }
}

/**
 * Fetch sessions from the server's disk-based storage (bypasses the OpenCode
 * SDK instance which may not have loaded historical sessions). Returns data
 * in the same shape the SDK would, filtered to the given directory.
 */
async function fetchSessionsFromStorage(folder: string): Promise<any[] | null> {
  try {
    const url = ERA_CODE_API_BASE
      ? new URL("/api/sessions", ERA_CODE_API_BASE).toString()
      : "/api/sessions"
    const response = await fetch(url)
    if (!response.ok) return null
    const data: { sessions: any[] } = await response.json()
    if (!data?.sessions?.length) return null

    const normalizedFolder = normalizeFolder(folder)
    const matched = data.sessions
      .filter((s: any) => normalizeFolder(s.directory || "") === normalizedFolder)
      .map((s: any) => ({
        id: s.id,
        title: s.title || "Untitled",
        parentID: null, // disk storage doesn't track parent hierarchy
        version: "0",
        time: {
          created: s.createdAt ?? Date.now(),
          updated: s.updatedAt ?? Date.now(),
        },
      }))

    return matched.length > 0 ? matched : null
  } catch (error) {
    log.error("Failed to fetch sessions from storage:", error)
    return null
  }
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

async function fetchSessions(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  setLoading((prev) => {
    const next = { ...prev }
    next.fetchingSessions.set(instanceId, true)
    return next
  })

  try {
    log.info("session.list", { instanceId, directory: instance.folder })
    const response = await instance.client.session.list({
      query: { directory: instance.folder },
    })

    let responseData = response.data

    // Retry + cache fallback for hard-refresh race condition
    if (!responseData || !Array.isArray(responseData) || responseData.length === 0) {
      // Retry once after 500ms – backend may still be initializing
      await new Promise((r) => setTimeout(r, 500))
      log.info("session.list retry", { instanceId, directory: instance.folder })
      const retryResponse = await instance.client.session.list({
        query: { directory: instance.folder },
      })
      responseData = retryResponse.data

      if (!responseData || !Array.isArray(responseData) || responseData.length === 0) {
        // SDK returned empty — try server-side disk storage as fallback.
        // The OpenCode instance may not load historical sessions on startup,
        // but the server reads them directly from disk.
        const storageSessions = await fetchSessionsFromStorage(instance.folder)
        if (storageSessions && storageSessions.length > 0) {
          log.info("session.list using disk storage fallback", { instanceId, count: storageSessions.length })
          responseData = storageSessions
        } else {
          // Try localStorage cache as last resort
          const cached = loadSessionCache(instance.folder)
          if (cached) {
            log.info("session.list using cached data", { instanceId, count: cached.length })
            responseData = cached
          } else {
            // Genuinely no sessions — still initialize an empty map so SSE
            // events (session.updated) can insert new sessions later.
            setSessions((prev) => {
              const next = new Map(prev)
              if (!next.has(instanceId)) {
                next.set(instanceId, new Map())
              }
              return next
            })
            return
          }
        }
      }
    }

    // Cache the successful non-empty response
    saveSessionCache(instance.folder, responseData)

    const sessionMap = new Map<string, Session>()

    const existingSessions = sessions().get(instanceId)

    for (const apiSession of responseData) {
      const existingSession = existingSessions?.get(apiSession.id)

      sessionMap.set(apiSession.id, {
        id: apiSession.id,
        instanceId,
        title: apiSession.title || "Untitled",
        parentId: apiSession.parentID || null,
        agent: existingSession?.agent ?? "",
        model: existingSession?.model ?? { providerId: "", modelId: "" },
        version: apiSession.version,
        time: {
          ...apiSession.time,
        },
        revert: apiSession.revert
          ? {
              messageID: apiSession.revert.messageID,
              partID: apiSession.revert.partID,
              snapshot: apiSession.revert.snapshot,
              diff: apiSession.revert.diff,
            }
          : undefined,
        status: existingSession?.status ?? "idle",
      })
    }

    // Re-parent orphaned subagent sessions loaded from API/disk/cache
    for (const [id, session] of sessionMap) {
      if (session.parentId === null && isSubagentTitle(session.title)) {
        // Find the most likely parent: a non-subagent session created most recently before this one
        let bestParent: Session | null = null
        for (const candidate of sessionMap.values()) {
          if (candidate.id === id) continue
          if (candidate.parentId !== null) continue
          if (isSubagentTitle(candidate.title)) continue
          if ((candidate.time.created ?? 0) > (session.time.created ?? 0)) continue
          if (!bestParent || (candidate.time.created ?? 0) > (bestParent.time.created ?? 0)) {
            bestParent = candidate
          }
        }
        if (bestParent) {
          session.parentId = bestParent.id
          log.info(`[API] Re-parented subagent "${session.title}" under parent ${bestParent.id}`)
        }
      }
    }

    const validSessionIds = new Set(sessionMap.keys())

    setSessions((prev) => {
      const next = new Map(prev)
      next.set(instanceId, sessionMap)
      return next
    })

    setMessagesLoaded((prev) => {
      const next = new Map(prev)
      const loadedSet = next.get(instanceId)
      if (loadedSet) {
        const filtered = new Set<string>()
        for (const id of loadedSet) {
          if (validSessionIds.has(id)) {
            filtered.add(id)
          }
        }
        next.set(instanceId, filtered)
      }
      return next
    })

    for (const session of sessionMap.values()) {
      const flag = (session.time as (Session["time"] & { compacting?: number | boolean }) | undefined)?.compacting
      const active = typeof flag === "number" ? flag > 0 : Boolean(flag)
      setSessionCompactionState(instanceId, session.id, active)
    }

    pruneDraftPrompts(instanceId, new Set(sessionMap.keys()))
  } catch (error) {
    log.error("Failed to fetch sessions:", error)
    throw error
  } finally {
    setLoading((prev) => {
      const next = { ...prev }
      next.fetchingSessions.set(instanceId, false)
      return next
    })
  }
}

async function createSession(instanceId: string, agent?: string): Promise<Session> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const instanceAgents = agents().get(instanceId) || []
  const nonSubagents = instanceAgents.filter((a) => a.mode !== "subagent")
  const selectedAgent = agent || (nonSubagents.length > 0 ? nonSubagents[0].name : "")

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
    const response = await instance.client.session.create()

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
      version: response.data.version,
      time: {
        ...response.data.time,
      },
      revert: response.data.revert
        ? {
            messageID: response.data.revert.messageID,
            partID: response.data.revert.partID,
            snapshot: response.data.revert.snapshot,
            diff: response.data.revert.diff,
          }
        : undefined,
      status: "idle",
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) || new Map()
      instanceSessions.set(session.id, session)
      next.set(instanceId, instanceSessions)
      return next
    })

    addSessionToCache(instance.folder, response.data)

    const instanceProviders = providers().get(instanceId) || []
    const initialProvider = instanceProviders.find((p) => p.id === session.model.providerId)
    const initialModel = initialProvider?.models.find((m) => m.id === session.model.modelId)
    const initialContextWindow = initialModel?.limit?.context ?? 0
    const initialSubscriptionModel = initialModel?.cost?.input === 0 && initialModel?.cost?.output === 0
    const initialOutputLimit =
      initialModel?.limit?.output && initialModel.limit.output > 0
        ? initialModel.limit.output
        : DEFAULT_MODEL_OUTPUT_LIMIT
    const initialContextAvailable = initialContextWindow > 0 ? initialContextWindow : null

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
  options?: { messageId?: string; parentId?: string },
): Promise<Session> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const request: {
    path: { id: string }
    body?: { messageID: string }
  } = {
    path: { id: sourceSessionId },
  }

  if (options?.messageId) {
    request.body = { messageID: options.messageId }
  }

  log.info(`[HTTP] POST /session.fork for instance ${instanceId}`, request)
  const response = await instance.client.session.fork(request)

  if (!response.data) {
    throw new Error("Failed to fork session: No data returned")
  }

  const info = response.data as SessionForkResponse
  const now = Date.now()
  const forkedSession: Session = {
    id: info.id,
    instanceId,
    title: info.title || "Forked Session",
    parentId: info.parentID || null,
    agent: info.agent || "",
    model: {
      providerId: info.model?.providerID || "",
      modelId: info.model?.modelID || "",
    },
    version: "0",
    time: {
      created: info.time?.created ?? now,
      updated: info.time?.updated ?? now,
    },
    revert: info.revert?.messageID
      ? {
          messageID: info.revert.messageID,
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
          diff: info.revert.diff,
        }
      : undefined,
    status: "idle",
  }

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = next.get(instanceId) || new Map()
    instanceSessions.set(forkedSession.id, forkedSession)
    next.set(instanceId, instanceSessions)
    return next
  })

  addSessionToCache(instance.folder, response.data)

  const instanceProviders = providers().get(instanceId) || []
  const forkProvider = instanceProviders.find((p) => p.id === forkedSession.model.providerId)
  const forkModel = forkProvider?.models.find((m) => m.id === forkedSession.model.modelId)
  const forkContextWindow = forkModel?.limit?.context ?? 0
  const forkSubscriptionModel = forkModel?.cost?.input === 0 && forkModel?.cost?.output === 0
  const forkOutputLimit =
    forkModel?.limit?.output && forkModel.limit.output > 0 ? forkModel.limit.output : DEFAULT_MODEL_OUTPUT_LIMIT
  const forkContextAvailable = forkContextWindow > 0 ? forkContextWindow : null

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

  setLoading((prev) => {
    const next = { ...prev }
    const deleting = next.deletingSession.get(instanceId) || new Set()
    deleting.add(sessionId)
    next.deletingSession.set(instanceId, deleting)
    return next
  })

  try {
    log.info(`[HTTP] DELETE /session.delete for instance ${instanceId}`, { sessionId })
    await instance.client.session.delete({ path: { id: sessionId } })

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId)
      if (instanceSessions) {
        instanceSessions.delete(sessionId)
      }
      return next
    })

    removeSessionFromCache(instance.folder, sessionId)

    setSessionCompactionState(instanceId, sessionId, false)
    clearSessionDraftPrompt(instanceId, sessionId)

    // Drop normalized message state and caches for this session
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

    // If deleted session was active, select a nearby session
    if (activeSessionId().get(instanceId) === sessionId) {
      const remainingSessions = sessions().get(instanceId)
      if (remainingSessions && remainingSessions.size > 0) {
        // Find parent sessions (sessions without parentId) to select from
        const parentSessions = Array.from(remainingSessions.values())
          .filter((s) => s.parentId === null)
          .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))

        if (parentSessions.length > 0) {
          // Select the most recently updated parent session
          setActiveSessionId((prev) => {
            const next = new Map(prev)
            next.set(instanceId, parentSessions[0].id)
            return next
          })
        } else {
          // No parent sessions, just clear
          setActiveSessionId((prev) => {
            const next = new Map(prev)
            next.delete(instanceId)
            return next
          })
        }
      } else {
        setActiveSessionId((prev) => {
          const next = new Map(prev)
          next.delete(instanceId)
          return next
        })
      }
    }

    // Check if this was the last session and stop instance if preference is enabled
    const remainingSessions = sessions().get(instanceId)
    const hasRemainingSessions = remainingSessions && remainingSessions.size > 0
    if (!hasRemainingSessions && preferences().stopInstanceOnLastSessionDelete) {
      log.info(`Stopping instance ${instanceId} because last session was deleted`)
      void stopInstance(instanceId).catch((error) => {
        log.error("Failed to stop instance after last session delete:", error)
      })
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

async function fetchAgents(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  try {
    log.info(`[HTTP] GET /app.agents for instance ${instanceId}`)
    const response = await instance.client.app.agents()
    const agentList = (response.data ?? []).map((agent) => ({
      name: agent.name,
      description: agent.description || "",
      mode: agent.mode,
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

  try {
    log.info(`[HTTP] GET /config.providers for instance ${instanceId}`)
    const response = await instance.client.config.providers()
    if (!response.data) return

    const providerList = response.data.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      defaultModelId: response.data?.default?.[provider.id],
      models: Object.entries(provider.models).map(([id, model]) => ({
        id,
        name: model.name,
        providerId: provider.id,
        reasoning: (model as any).reasoning ?? (model as any).capabilities?.reasoning ?? false,
        limit: model.limit,
        cost: model.cost,
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

async function loadMessages(instanceId: string, sessionId: string, force = false): Promise<void> {
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

  const isLoading = loading().loadingMessages.get(instanceId)?.has(sessionId)
  if (isLoading) {
    return
  }

  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  setLoading((prev) => {
    const next = { ...prev }
    const loadingSet = next.loadingMessages.get(instanceId) || new Set()
    loadingSet.add(sessionId)
    next.loadingMessages.set(instanceId, loadingSet)
    return next
  })

  try {
    log.info(`[HTTP] GET /session.${"messages"} for instance ${instanceId}`, { sessionId })
    const response = await instance.client.session["messages"]({ path: { id: sessionId } })

    if (!response.data || !Array.isArray(response.data)) {
      return
    }

    const messagesInfo = new Map<string, any>()
    const messages: Message[] = response.data.map((apiMessage: any) => {
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

    for (let i = response.data.length - 1; i >= 0; i--) {
      const apiMessage = response.data[i]
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
      agentName = session.agent
      providerID = defaultModel.providerId
      modelID = defaultModel.modelId
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const nextInstanceSessions = next.get(instanceId)
      if (nextInstanceSessions) {
        const existingSession = nextInstanceSessions.get(sessionId)
        if (existingSession) {
          const updatedSession = {
            ...existingSession,
            agent: agentName || existingSession.agent,
            model: providerID && modelID ? { providerId: providerID, modelId: modelID } : existingSession.model,
          }
          const updatedInstanceSessions = new Map(nextInstanceSessions)
          updatedInstanceSessions.set(sessionId, updatedSession)
          next.set(instanceId, updatedInstanceSessions)
        }
      }
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
    seedSessionMessagesV2(instanceId, sessionForV2, messages, messagesInfo)

  } catch (error) {
    log.error("Failed to load messages:", error)
    throw error
  } finally {
    setLoading((prev) => {
      const next = { ...prev }
      const loadingSet = next.loadingMessages.get(instanceId)
      if (loadingSet) {
        loadingSet.delete(sessionId)
      }
      return next
    })
  }

  updateSessionInfo(instanceId, sessionId)
}

export {
  createSession,
  deleteSession,
  fetchAgents,
  fetchProviders,

  fetchSessions,
  forkSession,
  loadMessages,
}
