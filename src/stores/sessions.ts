import { createSignal } from "solid-js"
import type { Session, Agent, Provider } from "../types/session"
import type { Message, MessageDisplayParts } from "../types/message"
import { instances } from "./instances"
import { sseManager } from "../lib/sse-manager"
import { preferences } from "./preferences"

interface SessionInfo {
  tokens: number
  cost: number
  contextWindow: number
  isSubscriptionModel: boolean
}

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
const [sessionInfoByInstance, setSessionInfoByInstance] = createSignal<Map<string, Map<string, SessionInfo>>>(new Map())

// Message index cache structure: instanceId -> sessionId -> { messageIndex, partIndex }
const sessionIndexes = new Map<
  string,
  Map<string, { messageIndex: Map<string, number>; partIndex: Map<string, Map<string, number>> }>
>()

function getSessionIndex(instanceId: string, sessionId: string) {
  let instanceMap = sessionIndexes.get(instanceId)
  if (!instanceMap) {
    instanceMap = new Map()
    sessionIndexes.set(instanceId, instanceMap)
  }

  let sessionMap = instanceMap.get(sessionId)
  if (!sessionMap) {
    sessionMap = { messageIndex: new Map(), partIndex: new Map() }
    instanceMap.set(sessionId, sessionMap)
  }

  return sessionMap
}

function rebuildSessionIndex(instanceId: string, sessionId: string, messages: Message[]) {
  const index = getSessionIndex(instanceId, sessionId)
  index.messageIndex.clear()
  index.partIndex.clear()

  messages.forEach((message, messageIdx) => {
    index.messageIndex.set(message.id, messageIdx)

    const partMap = new Map<string, number>()
    message.parts.forEach((part, partIdx) => {
      if (part.id && typeof part.id === "string") {
        partMap.set(part.id, partIdx)
      }
    })
    index.partIndex.set(message.id, partMap)
  })
}

function clearSessionIndex(instanceId: string, sessionId: string) {
  const instanceMap = sessionIndexes.get(instanceId)
  if (instanceMap) {
    instanceMap.delete(sessionId)
    if (instanceMap.size === 0) {
      sessionIndexes.delete(instanceId)
    }
  }
}

function removeSessionIndexes(instanceId: string) {
  sessionIndexes.delete(instanceId)
}

export function computeDisplayParts(message: Message, showThinking: boolean): MessageDisplayParts {
  const text: any[] = []
  const tool: any[] = []
  const reasoning: any[] = []

  for (const part of message.parts) {
    if (part.type === "text" && !part.synthetic) {
      text.push(part)
    } else if (part.type === "tool") {
      tool.push(part)
    } else if (part.type === "reasoning" && showThinking) {
      reasoning.push(part)
    }
  }

  const combined = reasoning.length > 0 ? [...text, ...reasoning] : [...text]
  const version = typeof message.version === "number" ? message.version : 0

  return { text, tool, reasoning, combined, showThinking, version }
}

function withSession(instanceId: string, sessionId: string, updater: (session: Session) => void) {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  const session = instanceSessions.get(sessionId)
  if (!session) return

  updater(session)

  // Create new session object with fresh references to trigger reactivity
  const updatedSession = {
    ...session,
    messages: [...session.messages],
    messagesInfo: new Map(session.messagesInfo),
  }

  setSessions((prev) => {
    const next = new Map(prev)
    const newInstanceSessions = new Map(instanceSessions)
    newInstanceSessions.set(sessionId, updatedSession)
    next.set(instanceId, newInstanceSessions)
    return next
  })
}

const ID_LENGTH = 26
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let localCounter = 0

function randomBase62(length: number): string {
  let result = ""
  const cryptoObj = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = new Uint8Array(length)
    cryptoObj.getRandomValues(bytes)
    for (let i = 0; i < length; i++) {
      result += BASE62_CHARS[bytes[i] % BASE62_CHARS.length]
    }
  } else {
    for (let i = 0; i < length; i++) {
      const idx = Math.floor(Math.random() * BASE62_CHARS.length)
      result += BASE62_CHARS[idx]
    }
  }
  return result
}

function createId(prefix: string): string {
  const timestamp = Date.now()
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    localCounter = 0
  }
  localCounter++

  const value = (BigInt(timestamp) << BigInt(12)) + BigInt(localCounter)
  const bytes = new Array<number>(6)
  for (let i = 0; i < 6; i++) {
    const shift = BigInt(8 * (5 - i))
    bytes[i] = Number((value >> shift) & BigInt(0xff))
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
  const random = randomBase62(ID_LENGTH - 12)

  return `${prefix}_${hex}${random}`
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
        revert: apiSession.revert
          ? {
              messageID: apiSession.revert.messageID,
              partID: apiSession.revert.partID,
              snapshot: apiSession.revert.snapshot,
              diff: apiSession.revert.diff,
            }
          : undefined,
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

function getSessionInfo(instanceId: string, sessionId: string): SessionInfo | undefined {
  return sessionInfoByInstance().get(instanceId)?.get(sessionId)
}

function updateSessionInfo(instanceId: string, sessionId: string) {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  const session = instanceSessions.get(sessionId)
  if (!session) return

  let tokens = 0
  let cost = 0
  let contextWindow = 0
  let isSubscriptionModel = false
  let modelID = ""
  let providerID = ""

  // Calculate from last assistant message in this session only
  if (session.messagesInfo.size > 0) {
    // Go backwards through messagesInfo to find the last relevant assistant message (like TUI)
    const messageArray = Array.from(session.messagesInfo.values()).reverse()

    for (const info of messageArray) {
      if (info.role === "assistant" && info.tokens) {
        const usage = info.tokens

        if (usage.output > 0) {
          if (info.summary) {
            // If summary message, only count output tokens and stop (like TUI)
            tokens = usage.output || 0
            cost = info.cost || 0
          } else {
            // Regular message - count all token types (like TUI)
            tokens =
              (usage.input || 0) +
              (usage.cache?.read || 0) +
              (usage.cache?.write || 0) +
              (usage.output || 0) +
              (usage.reasoning || 0)
            cost = info.cost || 0
          }

          // Get model info for context window and subscription check
          modelID = info.modelID || ""
          providerID = info.providerID || ""
          isSubscriptionModel = cost === 0

          break // Break after finding the last assistant message
        }
      }
    }
  }

  // Get context window from providers
  if (modelID && providerID) {
    const instanceProviders = providers().get(instanceId) || []
    const provider = instanceProviders.find((p) => p.id === providerID)
    if (provider) {
      const model = provider.models.find((m) => m.id === modelID)
      if (model?.limit?.context) {
        contextWindow = model.limit.context
      }
      // Check if it's a subscription model (cost is 0 for both input and output)
      if (model?.cost?.input === 0 && model?.cost?.output === 0) {
        isSubscriptionModel = true
      }
    }
  }

  setSessionInfoByInstance((prev) => {
    const next = new Map(prev)
    const instanceInfo = new Map(prev.get(instanceId))
    instanceInfo.set(sessionId, {
      tokens,
      cost,
      contextWindow,
      isSubscriptionModel,
    })
    next.set(instanceId, instanceInfo)
    return next
  })
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
      revert: response.data.revert
        ? {
            messageID: response.data.revert.messageID,
            partID: response.data.revert.partID,
            snapshot: response.data.revert.snapshot,
            diff: response.data.revert.diff,
          }
        : undefined,
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

    // Initialize session info with zeros for the new session
    setSessionInfoByInstance((prev) => {
      const next = new Map(prev)
      const instanceInfo = new Map(prev.get(instanceId))
      instanceInfo.set(session.id, {
        tokens: 0,
        cost: 0,
        contextWindow: 0,
        isSubscriptionModel: false,
      })
      next.set(instanceId, instanceInfo)
      return next
    })

    // Initialize cache entry for new session (empty messages)
    getSessionIndex(instanceId, session.id)

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

    // Remove session info entry
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

    // Clear cache entry for deleted session
    clearSessionIndex(instanceId, sessionId)

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

async function loadMessages(instanceId: string, sessionId: string, force = false): Promise<void> {
  // If force reload, clear the loaded cache
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

      const message: Message = {
        id: messageId,
        sessionId,
        type: role === "user" ? "user" : "assistant",
        parts: apiMessage.parts || [],
        timestamp: info.time?.created || Date.now(),
        status: "complete" as const,
        version: 0,
      }

      message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)

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

    // Rebuild index after loading messages
    rebuildSessionIndex(instanceId, sessionId, messages)

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

  updateSessionInfo(instanceId, sessionId)
}

function handleMessageUpdate(instanceId: string, event: any): void {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  if (event.type === "message.part.updated") {
    const part = event.properties?.part
    if (!part) return

    const session = instanceSessions.get(part.sessionID)
    if (!session) return

    const index = getSessionIndex(instanceId, part.sessionID)
    let messageIndex = index.messageIndex.get(part.messageID)
    let replacedTemp = false

    if (messageIndex === undefined) {
      // Search for queued message with status 'sending' and no server id
      for (let i = 0; i < session.messages.length; i++) {
        const msg = session.messages[i]
        if (msg.sessionId === part.sessionID && msg.status === "sending") {
          messageIndex = i
          replacedTemp = true
          break
        }
      }
    }

    if (messageIndex === undefined) {
      // Create new message
      const newMessage: Message = {
        id: part.messageID,
        sessionId: part.sessionID,
        type: "assistant" as const,
        parts: [part],
        timestamp: Date.now(),
        status: "streaming" as const,
        version: 0,
      }

      newMessage.displayParts = computeDisplayParts(newMessage, preferences().showThinkingBlocks)

      let insertIndex = session.messages.length
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].id < newMessage.id) {
          insertIndex = i + 1
          break
        }
      }

      session.messages.splice(insertIndex, 0, newMessage)
      rebuildSessionIndex(instanceId, part.sessionID, session.messages)
    } else {
      // Update existing message
      const message = session.messages[messageIndex]
      if (typeof message.version !== "number") {
        message.version = 0
      }

      // Strip synthetic parts when real data arrives
      let filteredSynthetics = false
      if (message.parts.some((partItem: any) => partItem.synthetic === true)) {
        message.parts = message.parts.filter((partItem: any) => partItem.synthetic !== true)
        filteredSynthetics = true
      }

      let baseParts: any[]
      if (replacedTemp) {
        baseParts = message.parts.filter((partItem: any) => partItem.type !== "text")
        message.parts = baseParts
      } else {
        baseParts = message.parts
      }

      // Update part in place
      let partMap = index.partIndex.get(message.id)
      if (!partMap) {
        partMap = new Map()
        index.partIndex.set(message.id, partMap)
      }

      let shouldIncrementVersion = filteredSynthetics || replacedTemp
      const partIndex = partMap.get(part.id)

      if (partIndex === undefined) {
        baseParts.push(part)
        if (part.id && typeof part.id === "string") {
          partMap.set(part.id, baseParts.length - 1)
        }
        shouldIncrementVersion = true
      } else {
        const previousPart = baseParts[partIndex]
        const textUnchanged =
          !filteredSynthetics &&
          !replacedTemp &&
          part.type === "text" &&
          previousPart?.type === "text" &&
          previousPart.text === part.text

        if (textUnchanged) {
          return
        }

        baseParts[partIndex] = part
        if (part.type !== "text" || !previousPart || previousPart.text !== part.text) {
          shouldIncrementVersion = true
        }
      }

      const oldId = message.id
      message.id = replacedTemp ? part.messageID : message.id
      message.status = message.status === "sending" ? "streaming" : message.status
      message.parts = baseParts

      if (shouldIncrementVersion) {
        message.version += 1
        message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)
      } else if (
        !message.displayParts ||
        message.displayParts.showThinking !== preferences().showThinkingBlocks ||
        message.displayParts.version !== message.version
      ) {
        message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)
      }

      // Update message index if ID changed
      if (oldId !== message.id) {
        index.messageIndex.delete(oldId)
        index.messageIndex.set(message.id, messageIndex)
        const existingPartMap = index.partIndex.get(oldId)
        if (existingPartMap) {
          index.partIndex.delete(oldId)
          index.partIndex.set(message.id, existingPartMap)
        }
      }

      // Refresh part indexes after filtering synthetic parts or replacing optimistic content
      if (filteredSynthetics || replacedTemp) {
        const partMap = new Map<string, number>()
        message.parts.forEach((partItem, idx) => {
          if (partItem.id && typeof partItem.id === "string") {
            partMap.set(partItem.id, idx)
          }
        })
        index.partIndex.set(message.id, partMap)
      }
    }

    withSession(instanceId, part.sessionID, (session) => {
      // Session already mutated in place
    })

    updateSessionInfo(instanceId, part.sessionID)
  } else if (event.type === "message.updated") {
    const info = event.properties?.info
    if (!info) return

    const session = instanceSessions.get(info.sessionID)
    if (!session) return

    const index = getSessionIndex(instanceId, info.sessionID)
    let messageIndex = index.messageIndex.get(info.id)

    if (messageIndex === undefined) {
      // Look for queued message to replace
      let tempMessageIndex = -1
      for (let i = 0; i < session.messages.length; i++) {
        const msg = session.messages[i]
        if (
          msg.sessionId === info.sessionID &&
          msg.type === (info.role === "user" ? "user" : "assistant") &&
          msg.status === "sending"
        ) {
          tempMessageIndex = i
          break
        }
      }

      if (tempMessageIndex === -1) {
        for (let i = 0; i < session.messages.length; i++) {
          const msg = session.messages[i]
          if (msg.sessionId === info.sessionID && msg.status === "sending") {
            tempMessageIndex = i
            break
          }
        }
      }

      if (tempMessageIndex > -1) {
        // Replace queued message
        const message = session.messages[tempMessageIndex]
        if (typeof message.version !== "number") {
          message.version = 0
        }

        const oldId = message.id
        message.id = info.id
        message.type = (info.role === "user" ? "user" : "assistant") as "user" | "assistant"
        message.timestamp = info.time?.created || Date.now()
        message.status = "complete" as const
        message.version += 1
        message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)

        if (oldId !== message.id) {
          index.messageIndex.delete(oldId)
          index.messageIndex.set(message.id, tempMessageIndex)
          const existingPartMap = index.partIndex.get(oldId)
          if (existingPartMap) {
            index.partIndex.delete(oldId)
            index.partIndex.set(message.id, existingPartMap)
          }
        }
      } else {
        // Append new message
        const newMessage: Message = {
          id: info.id,
          sessionId: info.sessionID,
          type: (info.role === "user" ? "user" : "assistant") as "user" | "assistant",
          parts: [],
          timestamp: info.time?.created || Date.now(),
          status: "complete" as const,
          version: 0,
        }

        newMessage.displayParts = computeDisplayParts(newMessage, preferences().showThinkingBlocks)

        let insertIndex = session.messages.length
        for (let i = session.messages.length - 1; i >= 0; i--) {
          if (session.messages[i].id < newMessage.id) {
            insertIndex = i + 1
            break
          }
        }

        session.messages.splice(insertIndex, 0, newMessage)
        rebuildSessionIndex(instanceId, info.sessionID, session.messages)
      }
    } else {
      // Update existing message status
      const message = session.messages[messageIndex]
      if (typeof message.version !== "number") {
        message.version = 0
      }
      message.status = "complete" as const
      message.version += 1
      message.displayParts = computeDisplayParts(message, preferences().showThinkingBlocks)

      session.messagesInfo.set(info.id, info)

      withSession(instanceId, info.sessionID, (session) => {
        // Session already mutated in place
      })

      updateSessionInfo(instanceId, info.sessionID)
    }
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
      revert: info.revert
        ? {
            messageID: info.revert.messageID,
            partID: info.revert.partID,
            snapshot: info.revert.snapshot,
            diff: info.revert.diff,
          }
        : undefined,
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
  attachments: any[] = [],
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

  const messageId = createId("msg")
  const textPartId = createId("part")

  const optimisticParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: prompt,
      synthetic: true,
    },
  ]

  const optimisticMessage: Message = {
    id: messageId,
    sessionId,
    type: "user",
    parts: optimisticParts,
    timestamp: Date.now(),
    status: "sending",
    version: 0,
  }

  optimisticMessage.displayParts = computeDisplayParts(optimisticMessage, preferences().showThinkingBlocks)

  withSession(instanceId, sessionId, (session) => {
    session.messages.push(optimisticMessage)
    const index = getSessionIndex(instanceId, sessionId)
    index.messageIndex.set(optimisticMessage.id, session.messages.length - 1)
  })

  const requestParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: prompt,
    },
  ]

  if (attachments.length > 0) {
    for (const att of attachments) {
      const source = att.source
      if (source.type === "file") {
        const partId = createId("part")
        requestParts.push({
          id: partId,
          type: "file" as const,
          url: att.url,
          mime: source.mime,
          filename: att.filename,
        })
        optimisticParts.push({
          id: partId,
          type: "file" as const,
          url: att.url,
          mime: source.mime,
          filename: att.filename,
          synthetic: true,
        })
      } else if (source.type === "text") {
        const partId = createId("part")
        requestParts.push({
          id: partId,
          type: "text" as const,
          text: source.value,
        })
        optimisticParts.push({
          id: partId,
          type: "text" as const,
          text: source.value,
          synthetic: true,
        })
      }
    }
  }

  const requestBody = {
    messageID: messageId,
    parts: requestParts,
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

async function abortSession(instanceId: string, sessionId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  console.log("[abortSession] Aborting session:", { instanceId, sessionId })

  try {
    await instance.client.session.abort({
      path: { id: sessionId },
    })
    console.log("[abortSession] Session aborted successfully")
  } catch (error) {
    console.error("[abortSession] Failed to abort session:", error)
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

function handleSessionCompacted(instanceId: string, event: any): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  console.log(`[SSE] Session compacted: ${sessionID}`)
  loadMessages(instanceId, sessionID, true).catch(console.error)
}

function handleSessionError(instanceId: string, event: any): void {
  const error = event.properties?.error
  const sessionID = event.properties?.sessionID
  console.error(`[SSE] Session error:`, error)

  let message = error?.data?.message || error?.message || "Unknown error"

  if (error?.data?.responseBody) {
    try {
      const body = JSON.parse(error.data.responseBody)
      if (body.error) {
        message = body.error
      }
    } catch {}
  }

  alert(`Error: ${message}`)
}

function handleMessageRemoved(instanceId: string, event: any): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  console.log(`[SSE] Message removed from session ${sessionID}, reloading messages`)
  loadMessages(instanceId, sessionID, true).catch(console.error)
}

function handleMessagePartRemoved(instanceId: string, event: any): void {
  const sessionID = event.properties?.sessionID
  if (!sessionID) return

  console.log(`[SSE] Message part removed from session ${sessionID}, reloading messages`)
  loadMessages(instanceId, sessionID, true).catch(console.error)
}

sseManager.onMessageUpdate = handleMessageUpdate
sseManager.onMessageRemoved = handleMessageRemoved
sseManager.onMessagePartRemoved = handleMessagePartRemoved
sseManager.onSessionUpdate = handleSessionUpdate
sseManager.onSessionCompacted = handleSessionCompacted
sseManager.onSessionError = handleSessionError

export {
  sessions,
  activeSessionId,
  activeParentSessionId,
  agents,
  providers,
  loading,
  sessionInfoByInstance,
  getSessionInfo,
  fetchSessions,
  createSession,
  deleteSession,
  fetchAgents,
  fetchProviders,
  loadMessages,
  sendMessage,
  abortSession,
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
  removeSessionIndexes,
}
