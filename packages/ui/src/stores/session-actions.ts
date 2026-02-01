import { resolvePastedPlaceholders } from "../lib/prompt-placeholders"
import { classifyPromptIntent, shouldEscalateAgent } from "../lib/agent-intent"
import {
  classify,
  mergeWithLlmResult,
  isLlmUnavailable,
  type ClassifyConfirmResponse,
  type ClassificationResult,
} from "../lib/instruction-classifier"
import { showCaptureCard } from "./instruction-capture"
import { getComposedInjection, retrieveSessionStartInstructions } from "./instruction-retrieval"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import { instances } from "./instances"

import { addRecentModelPreference, setAgentModelPreference, getEffectiveThinkingMode } from "./preferences"
import { getEffectivePermissionState } from "./session-permissions"
import { sessions, withSession, checkAndArchiveSubagents, agents } from "./session-state"
import { getDefaultModel, isModelValid } from "./session-models"
import { updateSessionInfo } from "./message-v2/session-info"
import { messageStoreBus, triggerCollapseAll } from "./message-v2/bus"
import { cleanupIdleChildren } from "./session-cleanup"
import { getLogger } from "../lib/logger"
import { setRequestSent } from "./streaming-metrics"

const log = getLogger("actions")

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

async function sendMessage(
  instanceId: string,
  sessionId: string,
  prompt: string,
  attachments: any[] = [],
): Promise<void> {
  // Auto-collapse all tool calls when user submits a new message
  triggerCollapseAll()

  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const instanceSessions = sessions().get(instanceId)
  let session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  // If sending message to a parent session, cleanup idle child sessions
  // This triggers the merge/cleanup behavior when user continues parent conversation
  if (session.parentId === null) {
    cleanupIdleChildren(instanceId, sessionId).catch((error) => {
      log.error("Failed to cleanup idle children:", error)
    })
    // Check if any completed subagents should be archived
    const store = messageStoreBus.getOrCreate(instanceId)
    const parentMessageCount = store.getSessionMessageIds(sessionId).length
    checkAndArchiveSubagents(instanceId, parentMessageCount)
  }

  // Auto-route agent on first message of a top-level session
  {
    const store = messageStoreBus.getOrCreate(instanceId)
    const isFirstMessage = store.getSessionMessageIds(sessionId).length === 0

    if (isFirstMessage && session.parentId === null) {
      const instanceAgentList = agents().get(instanceId) || []
      const availableNames = instanceAgentList
        .filter((a) => a.mode !== "subagent")
        .map((a) => a.name)
      const suggestedAgent = classifyPromptIntent(prompt, availableNames)

      if (suggestedAgent && suggestedAgent !== session.agent) {
        const nextModel = await getDefaultModel(instanceId, suggestedAgent)
        const shouldApplyModel = isModelValid(instanceId, nextModel)

        withSession(instanceId, sessionId, (current) => {
          current.agent = suggestedAgent
          if (shouldApplyModel) {
            current.model = nextModel
          }
        })
        // Re-read session after mutation for request body
        session = sessions().get(instanceId)?.get(sessionId)
        if (!session) {
          throw new Error("Session lost after auto-route")
        }
        log.info("Auto-routed to agent", { suggestedAgent, sessionId })
      }
    }
  }

  // Auto-escalate: if current agent is read-only (e.g. "plan") and the
  // follow-up prompt signals execution intent, switch to a capable agent.
  {
    const instanceAgentList = agents().get(instanceId) || []
    const availableNames = instanceAgentList
      .filter((a) => a.mode !== "subagent")
      .map((a) => a.name)
    const escalateTarget = shouldEscalateAgent(prompt, session.agent, availableNames)

    if (escalateTarget && escalateTarget !== session.agent) {
      const nextModel = await getDefaultModel(instanceId, escalateTarget)
      const shouldApplyModel = isModelValid(instanceId, nextModel)

      withSession(instanceId, sessionId, (current) => {
        current.agent = escalateTarget
        if (shouldApplyModel) {
          current.model = nextModel
        }
      })
      session = sessions().get(instanceId)?.get(sessionId)
      if (!session) {
        throw new Error("Session lost after agent escalation")
      }
      log.info("Auto-escalated agent", { from: session.agent, to: escalateTarget, sessionId })
    }
  }

  // Fire-and-forget: pre-fetch instructions for first message of a top-level session
  {
    const store = messageStoreBus.getOrCreate(instanceId)
    const isFirstMessage = store.getSessionMessageIds(sessionId).length === 0
    if (isFirstMessage && session.parentId === null) {
      const folder = instance?.folder
      const projectName = folder?.split("/").pop() ?? undefined
      retrieveSessionStartInstructions(instanceId, sessionId, { projectName }).catch(() => {})
    }
  }

  const messageId = createId("msg")
  const textPartId = createId("part")

  const resolvedPrompt = resolvePastedPlaceholders(prompt, attachments)

  const optimisticParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: resolvedPrompt,
      synthetic: true,
      renderCache: undefined,
    },
  ]

  const requestParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: resolvedPrompt,
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
        const display: string | undefined = att.display
        const value: unknown = source.value
        const isPastedPlaceholder = typeof display === "string" && /^pasted #\d+/.test(display)

        if (isPastedPlaceholder || typeof value !== "string") {
          continue
        }

        const partId = createId("part")
        requestParts.push({
          id: partId,
          type: "text" as const,
          text: value,
        })
        optimisticParts.push({
          id: partId,
          type: "text" as const,
          text: value,
          synthetic: true,
          renderCache: undefined,
        })
      }
    }
  }

  // Inject retrieved instructions as a hidden text part (requestParts only, not optimisticParts)
  const composedInstructions = getComposedInjection(instanceId, sessionId)
  if (composedInstructions) {
    requestParts.unshift({
      id: createId("part"),
      type: "text" as const,
      text: composedInstructions,
    })
  }

  const store = messageStoreBus.getOrCreate(instanceId)
  const createdAt = Date.now()

  store.upsertMessage({
    id: messageId,
    sessionId,
    role: "user",
    status: "sending",
    parts: optimisticParts,
    createdAt,
    updatedAt: createdAt,
    isEphemeral: true,
  })

  withSession(instanceId, sessionId, () => {
    /* trigger reactivity for legacy session data */
  })

  // Non-blocking instruction classification — fire and forget
  try {
    const classification = classify(resolvedPrompt)
    if (classification) {
      if (!classification.needsLlmConfirmation) {
        // High confidence — show card immediately
        showCaptureCard(classification)
      } else {
        // Borderline — ask server for LLM confirmation
        confirmClassification(classification).catch(() => {})
      }
    }
  } catch {
    // Classification errors are silently swallowed — never block message send
  }

  // Get effective permission state for this session
  const autoApprove = getEffectivePermissionState(instanceId, sessionId)

  // Resolve thinking mode for the current model
  const modelKey = session.model.providerId && session.model.modelId
    ? `${session.model.providerId}/${session.model.modelId}`
    : ""
  const thinkingMode = modelKey ? getEffectiveThinkingMode(modelKey, session.model.providerId) : undefined

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
    // Include thinking mode in request (backend may silently ignore if unsupported)
    ...(thinkingMode && { thinking: thinkingMode }),
    // Include permission state in request
    dangerouslySkipPermissions: autoApprove,
  }

  log.info("sendMessage", {
    instanceId,
    sessionId,
    requestBody,
  })

  try {
    setRequestSent(instanceId, sessionId)
    log.info("session.promptAsync", { instanceId, sessionId, requestBody })
    const response = await instance.client.session.promptAsync({
      path: { id: sessionId },
      body: requestBody,
    })

    log.info("sendMessage response", response)

    if (response.error) {
      log.error("sendMessage server error", response.error)
      throw new Error(JSON.stringify(response.error) || "Failed to send message")
    }
  } catch (error) {
    log.error("Failed to send prompt", error)
    throw error
  }
}

async function executeCustomCommand(
  instanceId: string,
  sessionId: string,
  commandName: string,
  args: string,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  // Get effective permission state for this session
  const autoApprove = getEffectivePermissionState(instanceId, sessionId)

  const body: {
    command: string
    arguments: string
    messageID: string
    agent?: string
    model?: string
    dangerouslySkipPermissions?: boolean
  } = {
    command: commandName,
    arguments: args,
    messageID: createId("msg"),
    dangerouslySkipPermissions: autoApprove,
  }

  if (session.agent) {
    body.agent = session.agent
  }

  if (session.model.providerId && session.model.modelId) {
    body.model = `${session.model.providerId}/${session.model.modelId}`
  }

  await instance.client.session.command({
    path: { id: sessionId },
    body,
  })
}

async function runShellCommand(instanceId: string, sessionId: string, command: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const agent = session.agent || "build"

  // Get effective permission state for this session
  const autoApprove = getEffectivePermissionState(instanceId, sessionId)

  await instance.client.session.shell({
    path: { id: sessionId },
    body: {
      agent,
      command,
      dangerouslySkipPermissions: autoApprove,
    } as { agent: string; command: string; dangerouslySkipPermissions?: boolean },
  })
}

async function abortSession(instanceId: string, sessionId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  log.info("abortSession", { instanceId, sessionId })

  try {
    log.info("session.abort", { instanceId, sessionId })
    await instance.client.session.abort({
      path: { id: sessionId },
    })
    log.info("abortSession complete", { instanceId, sessionId })
  } catch (error) {
    log.error("Failed to abort session", error)
    throw error
  }
}

async function updateSessionAgent(instanceId: string, sessionId: string, agent: string): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const nextModel = await getDefaultModel(instanceId, agent)
  const shouldApplyModel = isModelValid(instanceId, nextModel)

  withSession(instanceId, sessionId, (current) => {
    current.agent = agent
    if (shouldApplyModel) {
      current.model = nextModel
    }
  })

  if (agent && shouldApplyModel) {
    await setAgentModelPreference(instanceId, agent, nextModel)
  }

  if (shouldApplyModel) {
    updateSessionInfo(instanceId, sessionId)
  }
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

  if (!isModelValid(instanceId, model)) {
    log.warn("Invalid model selection", model)
    return
  }

  withSession(instanceId, sessionId, (current) => {
    current.model = model
  })

  if (session.agent) {
    await setAgentModelPreference(instanceId, session.agent, model)
  }
  addRecentModelPreference(model)

  updateSessionInfo(instanceId, sessionId)
}

async function renameSession(instanceId: string, sessionId: string, nextTitle: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const trimmedTitle = nextTitle.trim()
  if (!trimmedTitle) {
    throw new Error("Session title is required")
  }

  await instance.client.session.update({
    path: { id: sessionId },
    body: { title: trimmedTitle },
  })

  withSession(instanceId, sessionId, (current) => {
    current.title = trimmedTitle
    const time = { ...(current.time ?? {}) }
    time.updated = Date.now()
    current.time = time
  })
}

/**
 * Reply to an active Question tool call via the /question/{id}/reply API.
 * The question tool uses a separate API from permissions and regular messages.
 */
async function replyToQuestion(
  instanceId: string,
  requestId: string,
  answers: string[][],
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance) {
    throw new Error("Instance not ready")
  }

  log.info("replyToQuestion", { instanceId, requestId, answers })

  try {
    const { instanceApi } = await import("../lib/instance-api")
    await instanceApi.replyToQuestion(instance, requestId, answers)
    log.info("Question reply sent successfully")
  } catch (error) {
    log.error("Failed to reply to question", error)
    throw error
  }
}

/**
 * Reject/dismiss an active Question tool call.
 */
async function rejectQuestion(
  instanceId: string,
  requestId: string,
): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance) {
    throw new Error("Instance not ready")
  }

  log.info("rejectQuestion", { instanceId, requestId })

  try {
    const { instanceApi } = await import("../lib/instance-api")
    await instanceApi.rejectQuestion(instance, requestId)
    log.info("Question rejected successfully")
  } catch (error) {
    log.error("Failed to reject question", error)
    throw error
  }
}

/**
 * Ask the server to refine a borderline classification using Haiku.
 * Fire-and-forget: if the LLM confirms, shows the capture card.
 * If it rejects or is unavailable, does nothing.
 */
async function confirmClassification(regexResult: ClassificationResult): Promise<void> {
  try {
    const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/classify-confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: regexResult.sourceMessage }),
    })

    if (!resp.ok) return

    const data = (await resp.json()) as ClassifyConfirmResponse

    if (isLlmUnavailable(data)) return

    const refined = mergeWithLlmResult(regexResult, data)
    if (refined.isInstruction) {
      showCaptureCard(refined)
    }
  } catch {
    // Best-effort — silently ignore errors
  }
}

export {
  abortSession,
  executeCustomCommand,
  rejectQuestion,
  renameSession,
  replyToQuestion,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
}
