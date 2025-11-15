import type { Message, MessageDisplayParts } from "../types/message"
import { partHasRenderableText } from "../types/message"
import type { Provider } from "../types/session"

import { decodeHtmlEntities } from "../lib/markdown"
import { providers, sessions, setSessionInfoByInstance } from "./session-state"
import { DEFAULT_MODEL_OUTPUT_LIMIT } from "./session-models"

interface SessionIndexCache {
  messageIndex: Map<string, number>
  partIndex: Map<string, Map<string, number>>
}

const sessionIndexes = new Map<string, Map<string, SessionIndexCache>>()

function decodeTextSegment(segment: any): any {
  if (typeof segment === "string") {
    return decodeHtmlEntities(segment)
  }

  if (segment && typeof segment === "object") {
    const updated: Record<string, any> = { ...segment }

    if (typeof updated.text === "string") {
      updated.text = decodeHtmlEntities(updated.text)
    }

    if (typeof updated.value === "string") {
      updated.value = decodeHtmlEntities(updated.value)
    }

    if (Array.isArray(updated.content)) {
      updated.content = updated.content.map((item: any) => decodeTextSegment(item))
    }

    return updated
  }

  return segment
}

function normalizeMessagePart(part: any): any {
  if (!part || typeof part !== "object") {
    return part
  }

  if (part.type !== "text") {
    return part
  }

  const normalized: Record<string, any> = { ...part, renderCache: undefined }

  if (typeof normalized.text === "string") {
    normalized.text = decodeHtmlEntities(normalized.text)
  } else if (normalized.text && typeof normalized.text === "object") {
    const textObject: Record<string, any> = { ...normalized.text }

    if (typeof textObject.value === "string") {
      textObject.value = decodeHtmlEntities(textObject.value)
    }

    if (Array.isArray(textObject.content)) {
      textObject.content = textObject.content.map((item: any) => decodeTextSegment(item))
    }

    if (typeof textObject.text === "string") {
      textObject.text = decodeHtmlEntities(textObject.text)
    }

    normalized.text = textObject
  }

  if (Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map((item: any) => decodeTextSegment(item))
  }

  if (normalized.thinking && typeof normalized.thinking === "object") {
    const thinking: Record<string, any> = { ...normalized.thinking }
    if (Array.isArray(thinking.content)) {
      thinking.content = thinking.content.map((item: any) => decodeTextSegment(item))
    }
    normalized.thinking = thinking
  }

  return normalized
}

function computeDisplayParts(message: Message, showThinking: boolean): MessageDisplayParts {
  const text: any[] = []
  const tool: any[] = []
  const reasoning: any[] = []

  for (const part of message.parts) {
    if (part.type === "text" && !part.synthetic && partHasRenderableText(part)) {
      text.push(part)
    } else if (part.type === "tool") {
      tool.push(part)
    } else if (part.type === "reasoning" && showThinking && partHasRenderableText(part)) {
      reasoning.push(part)
    }
  }

  const combined = reasoning.length > 0 ? [...text, ...reasoning] : [...text]
  const version = typeof message.version === "number" ? message.version : 0

  return { text, tool, reasoning, combined, showThinking, version }
}

function initializePartVersion(part: any, version = 0) {
  if (!part || typeof part !== "object") return
  const partAny = part as any
  if (typeof partAny.version !== "number") {
    partAny.version = version
  }
}

function bumpPartVersion(previousPart: any, nextPart: any): number {
  const prevVersion = typeof previousPart?.version === "number" ? previousPart.version : -1
  const nextVersion = prevVersion + 1
  nextPart.version = nextVersion
  return nextVersion
}

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
  let actualUsageTokens = 0
  let contextUsagePercent: number | null = null
  let hasContextUsage = false

  if (session.messagesInfo.size > 0) {
    const messageArray = Array.from(session.messagesInfo.values()).reverse()

    for (const info of messageArray) {
      if (info.role === "assistant" && info.tokens) {
        const usage = info.tokens

        if (usage.output > 0) {
          const inputTokens = usage.input || 0
          const reasoningTokens = usage.reasoning || 0
          const cacheReadTokens = usage.cache?.read || 0
          const cacheWriteTokens = usage.cache?.write || 0
          const outputTokens = usage.output || 0

          if (info.summary) {
            tokens = outputTokens
          } else {
            tokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens
          }

          cost = info.cost || 0
          actualUsageTokens = tokens
          hasContextUsage = inputTokens + cacheReadTokens + cacheWriteTokens > 0

          modelID = info.modelID || ""
          providerID = info.providerID || ""
          isSubscriptionModel = cost === 0

          break
        }
      }
    }
  }

  const instanceProviders = providers().get(instanceId) || []

  const sessionModel = session.model
  let selectedModel: Provider["models"][number] | undefined

  if (sessionModel?.providerId && sessionModel?.modelId) {
    const provider = instanceProviders.find((p) => p.id === sessionModel.providerId)
    selectedModel = provider?.models.find((m) => m.id === sessionModel.modelId)
  }

  if (!selectedModel && modelID && providerID) {
    const provider = instanceProviders.find((p) => p.id === providerID)
    selectedModel = provider?.models.find((m) => m.id === modelID)
  }

  let modelOutputLimit = DEFAULT_MODEL_OUTPUT_LIMIT

  if (selectedModel) {
    if (selectedModel.limit?.context) {
      contextWindow = selectedModel.limit.context
    }

    if (selectedModel.limit?.output && selectedModel.limit.output > 0) {
      modelOutputLimit = selectedModel.limit.output
    }

    if (selectedModel.cost?.input === 0 && selectedModel.cost?.output === 0) {
      isSubscriptionModel = true
    }
  }

  const outputBudget = Math.min(modelOutputLimit, DEFAULT_MODEL_OUTPUT_LIMIT)
  let contextUsageTokens = 0

  if (hasContextUsage && actualUsageTokens > 0) {
    contextUsageTokens = actualUsageTokens + outputBudget
    if (contextWindow > 0) {
      const percent = Math.round((contextUsageTokens / contextWindow) * 100)
      contextUsagePercent = Math.min(100, Math.max(0, percent))
    } else {
      contextUsagePercent = null
    }
  } else {
    contextUsagePercent = contextWindow > 0 ? 0 : null
  }

  setSessionInfoByInstance((prev) => {
    const next = new Map(prev)
    const instanceInfo = new Map(prev.get(instanceId))
    instanceInfo.set(sessionId, {
      tokens,
      cost,
      contextWindow,
      isSubscriptionModel,
      contextUsageTokens,
      contextUsagePercent,
    })
    next.set(instanceId, instanceInfo)
    return next
  })
}

export {
  bumpPartVersion,
  clearSessionIndex,
  computeDisplayParts,
  getSessionIndex,
  initializePartVersion,
  normalizeMessagePart,
  rebuildSessionIndex,
  removeSessionIndexes,
  updateSessionInfo,
}
