import { mapSdkSessionStatus, type Session, type SessionStatus } from "../types/session"
import type { Message } from "../types/message"

import { instances } from "./instances"
import { preferences, setAgentModelPreference } from "./preferences"
import {
  activeSessionId,
  agents,
  clearSessionDraftPrompt,
  getChildSessions,
  isBlankSession,
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
  syncInstanceSessionIndicator,
} from "./session-state"
import { DEFAULT_MODEL_OUTPUT_LIMIT, getDefaultModel, isModelValid } from "./session-models"
import { normalizeMessagePart } from "./message-v2/normalizers"
import { updateSessionInfo } from "./message-v2/session-info"
import { seedSessionMessagesV2, reconcilePendingPermissionsV2, reconcilePendingQuestionsV2 } from "./message-v2/bridge"
import { messageStoreBus } from "./message-v2/bus"
import { clearCacheForSession } from "../lib/global-cache"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"

const log = getLogger("api")

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
    log.info("session.list", { instanceId })
    const response = await instance.client.session.list()

    const sessionMap = new Map<string, Session>()

    if (!response.data || !Array.isArray(response.data)) {
      return
    }

    let statusById: Record<string, any> = {}
    try {
      const statusResponse = await instance.client.session.status()
      if (statusResponse.data && typeof statusResponse.data === "object") {
        statusById = statusResponse.data as Record<string, any>
      }
    } catch (error) {
      log.error("Failed to fetch session status:", error)
    }

    const existingSessions = sessions().get(instanceId)

    for (const apiSession of response.data) {
      const existingSession = existingSessions?.get(apiSession.id)
      const existingStatus = existingSession?.status

      let status: SessionStatus
      if (existingStatus === "compacting") {
        status = "compacting"
      } else {
        const rawStatus = (apiSession as any)?.status ?? statusById[apiSession.id]
        const hasType = rawStatus && typeof rawStatus === "object" && typeof rawStatus.type === "string"
        status = hasType ? mapSdkSessionStatus(rawStatus) : existingStatus ?? "idle"
      }

      sessionMap.set(apiSession.id, {
        id: apiSession.id,
        instanceId,
        title: apiSession.title || "Untitled",
        parentId: apiSession.parentID || null,
        agent: existingSession?.agent ?? "",
        model: existingSession?.model ?? { providerId: "", modelId: "" },
        status,
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
      })
    }

    const validSessionIds = new Set(sessionMap.keys())

    setSessions((prev) => {
      const next = new Map(prev)
      next.set(instanceId, sessionMap)
      return next
    })

    syncInstanceSessionIndicator(instanceId, sessionMap)

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
      status: "idle",
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
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) || new Map()
      instanceSessions.set(session.id, session)
      next.set(instanceId, instanceSessions)
      return next
    })

    syncInstanceSessionIndicator(instanceId)

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
  options?: { messageId?: string },
): Promise<Session> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const request: { sessionID: string; messageID?: string } = {
    sessionID: sourceSessionId,
    messageID: options?.messageId,
  }

  log.info(`[HTTP] POST /session.fork for instance ${instanceId}`, request)
  const info = await requestData<SessionForkResponse>(
    instance.client.session.fork(request),
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
    version: "0",
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
    await requestData(instance.client.session.delete({ sessionID: sessionId }), "session.delete")

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

    if (activeSessionId().get(instanceId) === sessionId) {
      setActiveSessionId((prev) => {
        const next = new Map(prev)
        next.delete(instanceId)
        return next
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
    const apiMessages = await requestData<any[]>(
      instance.client.session.messages({ sessionID: sessionId }),
      "session.messages",
    )

    if (!Array.isArray(apiMessages)) {
      return
    }

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
      agentName = session.agent
      providerID = defaultModel.providerId
      modelID = defaultModel.modelId
    }

    setSessions((prev) => {
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
    seedSessionMessagesV2(instanceId, sessionForV2, messages, messagesInfo)

    // Permissions can be hydrated before messages/tool parts exist in the store.
    // After message hydration, try to attach any pending permissions to tool-call part ids.
    reconcilePendingPermissionsV2(instanceId, sessionId)
    reconcilePendingQuestionsV2(instanceId, sessionId)
  


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
