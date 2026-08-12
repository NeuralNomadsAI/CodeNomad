import type { ModelRef } from "@opencode-ai/client"
import { preparePromptDisplayText } from "../lib/prompt-display-metadata"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"

import { addRecentModelPreference, getModelThinkingSelection, setAgentModelPreference } from "./preferences"
import { beginSessionGenerationAdmission, providers, sessions, withSession } from "./session-state"
import { getDefaultModel, isModelValid } from "./session-models"
import { updateSessionInfo } from "./message-v2/session-info"
import { messageStoreBus } from "./message-v2/bus"
import { getLogger } from "../lib/logger"
import { clearConversationPlaybackForSession, isConversationModeEnabled } from "./conversation-speech"

const log = getLogger("actions")
const VOICE_MODE_INSTRUCTION_KEY = "codenomad.voice-mode"
const VOICE_MODE_INSTRUCTION = [
  "Voice conversation mode is enabled.",
  "Prepend your reply with a fenced code block using language `spoken`.",
  "The `spoken` block should be a concise, natural spoken gist of the full response in 2 to 4 sentences.",
  "Do not include code, bullet lists, markdown formatting, or long technical detail in the spoken block.",
  "After the `spoken` block, continue with your normal detailed response.",
].join("\n\n")

async function syncVoiceModeInstruction(client: ReturnType<typeof getRootClient>, instanceId: string, sessionId: string): Promise<void> {
  const instruction = client.session.instructions.entry
  if (isConversationModeEnabled(instanceId)) {
    await instruction.put({ sessionID: sessionId, key: VOICE_MODE_INSTRUCTION_KEY, value: VOICE_MODE_INSTRUCTION })
  } else {
    await instruction.remove({ sessionID: sessionId, key: VOICE_MODE_INSTRUCTION_KEY })
  }
}

function getVariantKeysForModel(instanceId: string, model: { providerId: string; modelId: string }): string[] {
  if (!model.providerId || !model.modelId) return []
  const instanceProviders = providers().get(instanceId) || []
  const provider = instanceProviders.find((p) => p.id === model.providerId)
  const match = provider?.models.find((m) => m.id === model.modelId)
  return match?.variantKeys ?? []
}

function getThinkingVariantToSend(instanceId: string, model: { providerId: string; modelId: string }): string | undefined {
  const selected = getModelThinkingSelection(model)
  if (!selected) return undefined
  const keys = getVariantKeysForModel(instanceId, model)
  if (keys.length === 0) return undefined
  return keys.includes(selected) ? selected : undefined
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

  const client = getRootClient(instanceId)

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const messageId = createId("msg")
  const textPartId = createId("prt")

  const preparedPrompt = preparePromptDisplayText(prompt, attachments)

  const optimisticParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: preparedPrompt.promptToSend,
      synthetic: true,
      renderCache: undefined,
    },
  ]

  const files: Array<{ uri: string; name?: string }> = []

  if (attachments.length > 0) {
    for (const att of attachments) {
      const source = att.source
      if (source.type === "file") {
        const partId = createId("prt")
        files.push({ uri: att.url, name: att.filename })
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
        const isPathPlaceholder = typeof display === "string" && /^path:/.test(display)

        // Skip path: attachments from being sent as separate parts (content is already in prompt)
        // Skip pasted placeholders too (already resolved in prompt)
        if (isPastedPlaceholder || isPathPlaceholder || typeof value !== "string") {
          continue
        }

        const partId = createId("prt")
        preparedPrompt.promptToSend += `\n\n${value}`
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

  const store = messageStoreBus.getOrCreate(instanceId)
  const createdAt = Date.now()

  clearConversationPlaybackForSession(instanceId, sessionId)

  store.upsertMessage({
    id: messageId,
    sessionId,
    role: "user",
    status: "sending",
    parts: optimisticParts,
    createdAt,
    updatedAt: createdAt,
    isEphemeral: true,
    clientPromptDisplayMetadata: preparedPrompt.displayMetadata,
  })

  // Preserve the optimistic bubble only while the prompt request is unresolved.
  store.markSendPending(messageId)

  withSession(instanceId, sessionId, () => {
    /* trigger reactivity for legacy session data */
  })

  const requestBody = {
    // Send the optimistic message id so the server confirms THIS send under
    // the same id. Hydration then reconciles by identity (same id in the
    // snapshot) instead of content matching, and the SSE echo updates the
    // existing record in place — no duplicate bubble, no ambiguity between
    // identical texts.
    id: messageId,
    text: preparedPrompt.promptToSend,
    ...(files.length > 0 ? { files } : {}),
  }

  log.info("sendMessage", {
    instanceId,
    sessionId,
    requestBody,
  })

  try {
    log.info("session.prompt", { instanceId, sessionId, requestBody })
    const admission = beginSessionGenerationAdmission(instanceId, sessionId)
    try {
      await syncVoiceModeInstruction(client, instanceId, sessionId)
      await client.session.prompt({ sessionID: sessionId, ...requestBody })
      admission.complete()
      store.acceptSend(messageId)
    } catch (error) {
      admission.rollback()
      throw error
    }
  } catch (error) {
    store.failSend(messageId)
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

  const client = getRootClient(instanceId)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const body: {
    command: string
    arguments: string
    id: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
  } = {
    command: commandName,
    arguments: args,
    id: createId("msg"),
  }

  if (session.agent) {
    body.agent = session.agent
  }

  if (session.model.providerId && session.model.modelId) {
    body.model = { providerID: session.model.providerId, id: session.model.modelId }
    const variant = getThinkingVariantToSend(instanceId, session.model)
    if (variant) body.model.variant = variant
  }

  const admission = beginSessionGenerationAdmission(instanceId, sessionId)
  try {
    await syncVoiceModeInstruction(client, instanceId, sessionId)
    await client.session.command({ sessionID: sessionId, ...body })
    admission.complete()
  } catch (error) {
    admission.rollback()
    throw error
  }
}

async function runShellCommand(instanceId: string, sessionId: string, command: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const admission = beginSessionGenerationAdmission(instanceId, sessionId)
  try {
    await syncVoiceModeInstruction(client, instanceId, sessionId)
    await client.session.shell({ sessionID: sessionId, command })
    admission.complete()
  } catch (error) {
    admission.rollback()
    throw error
  }
}

async function abortSession(instanceId: string, sessionId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const client = getRootClient(instanceId)

  log.info("abortSession", { instanceId, sessionId })

  try {
    log.info("session.interrupt", { instanceId, sessionId })
    await client.session.interrupt({ sessionID: sessionId })
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
  const previousAgent = session.agent
  const previousModel = session.model

  withSession(instanceId, sessionId, (current) => {
    current.agent = agent
    if (shouldApplyModel) {
      current.model = nextModel
    }
  })

  try {
    await getRootClient(instanceId).session.switchAgent({ sessionID: sessionId, agent })
  } catch (error) {
    withSession(instanceId, sessionId, (current) => {
      if (current.agent !== agent) return false
      current.agent = previousAgent
      if (
        shouldApplyModel &&
        current.model.providerId === nextModel.providerId &&
        current.model.modelId === nextModel.modelId
      ) {
        current.model = previousModel
      }
    })
    throw error
  }

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

  const nativeModel: ModelRef = { providerID: model.providerId, id: model.modelId }
  try {
    await getRootClient(instanceId).session.switchModel({ sessionID: sessionId, model: nativeModel })
  } catch (error) {
    withSession(instanceId, sessionId, (current) => {
      if (current.model.providerId !== model.providerId || current.model.modelId !== model.modelId) return false
      current.model = session.model
    })
    throw error
  }

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

  const client = getRootClient(instanceId)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const trimmedTitle = nextTitle.trim()
  if (!trimmedTitle) {
    throw new Error("Session title is required")
  }

  await client.session.rename({ sessionID: sessionId, title: trimmedTitle })

  withSession(instanceId, sessionId, (current) => {
    current.title = trimmedTitle
    const time = { ...(current.time ?? {}) }
    time.updated = Date.now()
    current.time = time
  })
}

async function compactSession(instanceId: string, sessionId: string): Promise<void> {
  await getRootClient(instanceId).session.compact({ sessionID: sessionId })
}

export {
  abortSession,
  executeCustomCommand,
  compactSession,
  renameSession,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
}
