import { createSignal } from "solid-js"
import type { Session, Agent, Provider } from "../types/session"
import type { Message } from "../types/message"
import { instances } from "./instances"
import { sseManager } from "../lib/sse-manager"

const [sessions, setSessions] = createSignal<Map<string, Map<string, Session>>>(new Map())
const [activeSessionId, setActiveSessionId] = createSignal<Map<string, string>>(new Map())
const [activeParentSessionId, setActiveParentSessionId] = createSignal<Map<string, string>>(new Map())
const [agents, setAgents] = createSignal<Map<string, Agent[]>>(new Map())
const [providers, setProviders] = createSignal<Map<string, Provider[]>>(new Map())

const [loading, setLoading] = createSignal({
  fetchingSessions: new Map<string, boolean>(),
  creatingSession: new Map<string, boolean>(),
  deletingSession: new Map<string, Set<string>>(),
  loadingMessages: new Map<string, Set<string>>(),
})

const [messagesLoaded, setMessagesLoaded] = createSignal<Map<string, Set<string>>>(new Map())

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
    const response = await instance.client.session.list()

    const sessionMap = new Map<string, Session>()

    if (!response.data || !Array.isArray(response.data)) {
      return
    }

    for (const apiSession of response.data) {
      sessionMap.set(apiSession.id, {
        id: apiSession.id,
        instanceId,
        title: apiSession.title || "Untitled",
        parentId: apiSession.parentID || null,
        agent: "",
        model: { providerId: "", modelId: "" },
        time: {
          created: apiSession.time.created,
          updated: apiSession.time.updated,
        },
        messages: [],
        messagesInfo: new Map(),
      })
    }

    setSessions((prev) => {
      const next = new Map(prev)
      next.set(instanceId, sessionMap)
      return next
    })
  } catch (error) {
    console.error("Failed to fetch sessions:", error)
    throw error
  } finally {
    setLoading((prev) => {
      const next = { ...prev }
      next.fetchingSessions.set(instanceId, false)
      return next
    })
  }
}

async function getDefaultModel(
  instanceId: string,
  agentName?: string,
): Promise<{ providerId: string; modelId: string }> {
  const instanceProviders = providers().get(instanceId) || []
  const instanceAgents = agents().get(instanceId) || []

  if (agentName) {
    const agent = instanceAgents.find((a) => a.name === agentName)
    if (agent?.model?.providerId && agent.model.modelId) {
      return {
        providerId: agent.model.providerId,
        modelId: agent.model.modelId,
      }
    }
  }

  const anthropicProvider = instanceProviders.find((p) => p.id === "anthropic")
  if (anthropicProvider) {
    const defaultModelId = anthropicProvider.defaultModelId || anthropicProvider.models[0]?.id
    if (defaultModelId) {
      return {
        providerId: "anthropic",
        modelId: defaultModelId,
      }
    }
  }

  if (instanceProviders.length > 0) {
    const firstProvider = instanceProviders[0]
    const defaultModelId = firstProvider.defaultModelId || firstProvider.models[0]?.id

    if (defaultModelId) {
      return {
        providerId: firstProvider.id,
        modelId: defaultModelId,
      }
    }
  }

  return { providerId: "", modelId: "" }
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

  setLoading((prev) => {
    const next = { ...prev }
    next.creatingSession.set(instanceId, true)
    return next
  })

  try {
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
      time: {
        created: response.data.time.created,
        updated: response.data.time.updated,
      },
      messages: [],
      messagesInfo: new Map(),
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId) || new Map()
      instanceSessions.set(session.id, session)
      next.set(instanceId, instanceSessions)
      return next
    })

    return session
  } catch (error) {
    console.error("Failed to create session:", error)
    throw error
  } finally {
    setLoading((prev) => {
      const next = { ...prev }
      next.creatingSession.set(instanceId, false)
      return next
    })
  }
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
    await instance.client.session.delete({ path: { id: sessionId } })

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = next.get(instanceId)
      if (instanceSessions) {
        instanceSessions.delete(sessionId)
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
    console.error("Failed to delete session:", error)
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
    console.error("Failed to fetch agents:", error)
  }
}

async function fetchProviders(instanceId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  try {
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
      })),
    }))

    setProviders((prev) => {
      const next = new Map(prev)
      next.set(instanceId, providerList)
      return next
    })
  } catch (error) {
    console.error("Failed to fetch providers:", error)
  }
}

function setActiveSession(instanceId: string, sessionId: string): void {
  setActiveSessionId((prev) => {
    const next = new Map(prev)
    next.set(instanceId, sessionId)
    return next
  })
}

function setActiveParentSession(instanceId: string, parentSessionId: string): void {
  setActiveParentSessionId((prev) => {
    const next = new Map(prev)
    next.set(instanceId, parentSessionId)
    return next
  })

  setActiveSession(instanceId, parentSessionId)
}

function clearActiveParentSession(instanceId: string): void {
  setActiveParentSessionId((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })

  setActiveSessionId((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
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

function getParentSessions(instanceId: string): Session[] {
  const allSessions = getSessions(instanceId)
  return allSessions.filter((s) => s.parentId === null)
}

function getChildSessions(instanceId: string, parentId: string): Session[] {
  const allSessions = getSessions(instanceId)
  return allSessions.filter((s) => s.parentId === parentId)
}

function getSessionFamily(instanceId: string, parentId: string): Session[] {
  const parent = sessions().get(instanceId)?.get(parentId)
  if (!parent) return []

  const children = getChildSessions(instanceId, parentId)
  return [parent, ...children]
}

async function loadMessages(instanceId: string, sessionId: string): Promise<void> {
  const alreadyLoaded = messagesLoaded().get(instanceId)?.has(sessionId)
  if (alreadyLoaded) {
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
    const response = await instance.client.session.messages({ path: { id: sessionId } })

    if (!response.data || !Array.isArray(response.data)) {
      return
    }

    const messagesInfo = new Map<string, any>()
    const messages: Message[] = response.data.map((apiMessage: any) => {
      const info = apiMessage.info || apiMessage
      const role = info.role || "assistant"
      const messageId = info.id || String(Date.now())

      messagesInfo.set(messageId, info)

      return {
        id: messageId,
        sessionId,
        type: role === "user" ? "user" : "assistant",
        parts: apiMessage.parts || [],
        timestamp: info.time?.created || Date.now(),
        status: "complete" as const,
      }
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
      const instanceSessions = next.get(instanceId)
      if (instanceSessions) {
        const session = instanceSessions.get(sessionId)
        if (session) {
          const updatedSession = {
            ...session,
            messages,
            messagesInfo,
            agent: agentName || session.agent,
            model: providerID && modelID ? { providerId: providerID, modelId: modelID } : session.model,
          }
          const updatedInstanceSessions = new Map(instanceSessions)
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
  } catch (error) {
    console.error("Failed to load messages:", error)
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
}

function handleMessageUpdate(instanceId: string, event: any): void {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  if (event.type === "message.part.updated") {
    const part = event.properties?.part
    if (!part) return

    const session = instanceSessions.get(part.sessionID)
    if (!session) return

    let message = session.messages.find((m) => m.id === part.messageID)

    if (!message) {
      message = {
        id: part.messageID,
        sessionId: part.sessionID,
        type: "assistant",
        parts: [part],
        timestamp: Date.now(),
        status: "streaming",
      }
      session.messages.push(message)
    } else {
      const partIndex = message.parts.findIndex((p: any) => p.id === part.id)
      if (partIndex === -1) {
        message.parts.push(part)
      } else {
        message.parts[partIndex] = part
      }
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(prev.get(instanceId))
      instanceSessions.set(part.sessionID, { ...session })
      next.set(instanceId, instanceSessions)
      return next
    })
  } else if (event.type === "message.updated") {
    const info = event.properties?.info
    if (!info) return

    const session = instanceSessions.get(info.sessionID)
    if (!session) return

    let message = session.messages.find((m) => m.id === info.id)

    if (!message) {
      message = {
        id: info.id,
        sessionId: info.sessionID,
        type: info.role === "user" ? "user" : "assistant",
        parts: [],
        timestamp: info.time?.created || Date.now(),
        status: "complete",
      }
      session.messages.push(message)
    } else {
      // Update existing message - replace temp message with real one
      message.id = info.id
      message.status = "complete"
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(prev.get(instanceId))
      const updatedSession = instanceSessions.get(info.sessionID)
      if (updatedSession) {
        const messagesInfo = new Map(updatedSession.messagesInfo)
        messagesInfo.set(info.id, info)
        instanceSessions.set(info.sessionID, { ...updatedSession, messagesInfo })
      }
      next.set(instanceId, instanceSessions)
      return next
    })
  }
}

function handleSessionUpdate(instanceId: string, event: any): void {
  const info = event.properties?.info
  if (!info) return

  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  const existingSession = instanceSessions.get(info.id)

  if (!existingSession) {
    const newSession: Session = {
      id: info.id,
      instanceId,
      title: info.title || "Untitled",
      parentId: info.parentID || null,
      agent: info.agent || "",
      model: {
        providerId: info.model?.providerID || "",
        modelId: info.model?.modelID || "",
      },
      time: {
        created: info.time?.created || Date.now(),
        updated: info.time?.updated || Date.now(),
      },
      messages: [],
      messagesInfo: new Map(),
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(prev.get(instanceId))
      instanceSessions.set(newSession.id, newSession)
      next.set(instanceId, instanceSessions)
      return next
    })

    console.log(`[SSE] New session created: ${info.id}`, newSession)
  } else {
    const updatedSession = {
      ...existingSession,
      title: info.title || existingSession.title,
      agent: info.agent || existingSession.agent,
      model: info.model
        ? {
            providerId: info.model.providerID || existingSession.model.providerId,
            modelId: info.model.modelID || existingSession.model.modelId,
          }
        : existingSession.model,
      time: {
        ...existingSession.time,
        updated: info.time?.updated || Date.now(),
      },
    }

    setSessions((prev) => {
      const next = new Map(prev)
      const instanceSessions = new Map(prev.get(instanceId))
      instanceSessions.set(existingSession.id, updatedSession)
      next.set(instanceId, instanceSessions)
      return next
    })
  }
}

async function sendMessage(
  instanceId: string,
  sessionId: string,
  prompt: string,
  attachments: string[] = [],
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const requestBody = {
    parts: [
      {
        type: "text" as const,
        text: prompt,
      },
    ],
    ...(session.agent && { agent: session.agent }),
    ...(session.model.providerId &&
      session.model.modelId && {
        model: {
          providerID: session.model.providerId,
          modelID: session.model.modelId,
        },
      }),
  }

  console.log("[sendMessage] Sending prompt:", {
    sessionId,
    requestBody,
  })

  try {
    const response = await instance.client.session.prompt({
      path: { id: sessionId },
      body: requestBody,
    })

    console.log("[sendMessage] Response:", response)

    if (response.error) {
      console.error("[sendMessage] Server returned error:", response.error)
      throw new Error(JSON.stringify(response.error) || "Failed to send message")
    }
  } catch (error) {
    console.error("[sendMessage] Failed to send prompt:", error)
    throw error
  }
}

async function updateSessionAgent(instanceId: string, sessionId: string, agent: string): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = new Map(prev.get(instanceId))
    const session = instanceSessions.get(sessionId)
    if (session) {
      instanceSessions.set(sessionId, { ...session, agent })
      next.set(instanceId, instanceSessions)
    }
    return next
  })
}

async function updateSessionModel(
  instanceId: string,
  sessionId: string,
  model: { providerId: string; modelId: string },
): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = new Map(prev.get(instanceId))
    const session = instanceSessions.get(sessionId)
    if (session) {
      instanceSessions.set(sessionId, { ...session, model })
      next.set(instanceId, instanceSessions)
    }
    return next
  })
}

sseManager.onMessageUpdate = handleMessageUpdate
sseManager.onSessionUpdate = handleSessionUpdate

export {
  sessions,
  activeSessionId,
  activeParentSessionId,
  agents,
  providers,
  loading,
  fetchSessions,
  createSession,
  deleteSession,
  fetchAgents,
  fetchProviders,
  loadMessages,
  sendMessage,
  setActiveSession,
  setActiveParentSession,
  clearActiveParentSession,
  getActiveSession,
  getActiveParentSession,
  getSessions,
  getParentSessions,
  getChildSessions,
  getSessionFamily,
  updateSessionAgent,
  updateSessionModel,
  getDefaultModel,
}
