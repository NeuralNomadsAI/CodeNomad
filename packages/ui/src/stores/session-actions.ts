import type { ModelRef, SessionInboxDelivery, SessionInboxUser, SessionPromptInput } from "@opencode-ai/client"
import type { Attachment } from "../types/attachment"
import { preparePromptDisplayText } from "../lib/prompt-display-metadata"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"

import { addRecentModelPreference, getModelThinkingSelection, setAgentModelPreference } from "./preferences"
import { beginSessionGenerationAdmission, getDescendantSessions, providers, sessions, withSession } from "./session-state"
import { isSessionBusy } from "./session-status"
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
const voiceInstructionSyncs = new Map<string, { desired: boolean; running: Promise<void> }>()

async function syncVoiceModeInstruction(client: ReturnType<typeof getRootClient>, instanceId: string, sessionId: string): Promise<void> {
  const key = `${instanceId}:${sessionId}`
  const existing = voiceInstructionSyncs.get(key)
  if (existing) {
    existing.desired = isConversationModeEnabled(instanceId)
    return existing.running
  }

  const state = { desired: isConversationModeEnabled(instanceId), running: Promise.resolve() }
  state.running = (async () => {
    try {
      let applied: boolean | undefined
      while (applied !== state.desired) {
        const desired = state.desired
        const instruction = client.session.instructions.entry
        if (desired) {
          await instruction.put({ sessionID: sessionId, key: VOICE_MODE_INSTRUCTION_KEY, value: VOICE_MODE_INSTRUCTION })
        } else {
          await instruction.remove({ sessionID: sessionId, key: VOICE_MODE_INSTRUCTION_KEY })
        }
        applied = desired
        state.desired = isConversationModeEnabled(instanceId)
      }
    } finally {
      if (voiceInstructionSyncs.get(key) === state) voiceInstructionSyncs.delete(key)
    }
  })()
  voiceInstructionSyncs.set(key, state)
  return state.running
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

function getNativeModel(instanceId: string, model: { providerId: string; modelId: string }): ModelRef {
  const nativeModel: ModelRef = { providerID: model.providerId, id: model.modelId }
  const variant = getThinkingVariantToSend(instanceId, model)
  if (variant) nativeModel.variant = variant
  return nativeModel
}

function getAgentMention(text: string, name: string): { start: number; end: number; text: string } | undefined {
  const mentionText = `@${name}`
  const start = text.indexOf(mentionText)
  return start < 0 ? undefined : { start, end: start + mentionText.length, text: mentionText }
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
  attachments: Attachment[] = [],
  options: { delivery?: SessionInboxDelivery; replace?: SessionInboxUser } = {},
): Promise<string> {
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
  const replacedDisplayText = options.replace?.payload.metadata?.displayText
  if (typeof replacedDisplayText === "string" && options.replace?.payload.text.startsWith(replacedDisplayText)) {
    preparedPrompt.promptToSend += options.replace.payload.text.slice(replacedDisplayText.length)
  }

  const optimisticParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: preparedPrompt.promptToSend,
      renderCache: undefined,
    },
  ]

  const remapMention = (mention: { text: string } | undefined) => {
    if (!mention) return undefined
    const start = prompt.indexOf(mention.text)
    return start < 0 ? undefined : { text: mention.text, start, end: start + mention.text.length }
  }
  const files: Array<NonNullable<SessionPromptInput["files"]>[number]> = options.replace?.payload.files?.map((file) => ({
    uri: `data:${file.mime};base64,${file.data}`,
    name: file.name,
    description: file.description,
    mention: remapMention(file.mention),
  })) ?? []
  const agents: Array<NonNullable<SessionPromptInput["agents"]>[number]> = options.replace?.payload.agents?.flatMap((agent) => {
    const mention = remapMention(agent.mention)
    return agent.mention && !mention ? [] : [{ name: agent.name, ...(mention ? { mention } : {}) }]
  }) ?? []
  const skills: Array<NonNullable<SessionPromptInput["skills"]>[number]> = options.replace?.payload.skills?.flatMap((skill) => {
    const mention = remapMention(skill.mention)
    return skill.mention && !mention ? [] : [{ id: skill.id, ...(mention ? { mention } : {}) }]
  }) ?? []

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
      } else if (source.type === "agent") {
        const mention = getAgentMention(preparedPrompt.promptToSend, source.name)
        if (!agents.some((agent) => agent.name === source.name)) {
          agents.push({ name: source.name, ...(mention ? { mention } : {}) })
        }
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
          renderCache: undefined,
        })
      }
    }
  }

  const store = messageStoreBus.getOrCreate(instanceId)
  const createdAt = Date.now()

  clearConversationPlaybackForSession(instanceId, sessionId)

  const projectOptimistically = options.delivery !== "queue"
  if (projectOptimistically) {
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
    store.markSendPending(messageId)
  }

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
    ...(agents.length > 0 ? { agents } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(options.replace ? { metadata: { ...options.replace.payload.metadata, displayText: prompt } } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.delivery === "queue" ? { resume: false } : {}),
  }

  log.info("sendMessage", {
    instanceId,
    sessionId,
    requestBody,
  })

  let confirmedId = messageId
  try {
    log.info("session.prompt", { instanceId, sessionId, requestBody })
    const admission = beginSessionGenerationAdmission(instanceId, sessionId)
    try {
      await syncVoiceModeInstruction(client, instanceId, sessionId)
      if (options.delivery !== "queue") {
        if (session.agent) await client.session.switchAgent({ sessionID: sessionId, agent: session.agent })
        if (session.model.providerId && session.model.modelId) {
          await client.session.switchModel({ sessionID: sessionId, model: getNativeModel(instanceId, session.model) })
        }
      }
      const result = await client.session.prompt({ sessionID: sessionId, ...requestBody })
      confirmedId = result?.id || messageId
      if (projectOptimistically && confirmedId !== messageId) store.replaceMessageId({ oldId: messageId, newId: confirmedId })
      admission.complete()
      if (projectOptimistically) store.acceptSend(confirmedId)
    } catch (error) {
      admission.rollback()
      throw error
    }
  } catch (error) {
    if (projectOptimistically) store.failSend(messageId)
    log.error("Failed to send prompt", error)
    throw error
  }

  if (options.replace) {
    // V2 has no atomic inbox update, so preserve the original until its replacement is admitted.
    await client.session.inbox.cancel({ sessionID: sessionId, inboxID: options.replace.id })
  }
  return confirmedId
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

  const admission = beginSessionGenerationAdmission(instanceId, sessionId)
  try {
    await syncVoiceModeInstruction(client, instanceId, sessionId)
    await client.session.command({ sessionID: sessionId, command: commandName, text: args, delivery: "steer" })
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
    const descendantIds = getDescendantSessions(instanceId, sessionId)
      .filter((session) => isSessionBusy(instanceId, session.id))
      .map((session) => session.id)
    const sessionIds = [...descendantIds, sessionId]
    log.info("session.interrupt", { instanceId, sessionIds })
    await Promise.all(sessionIds.map((targetSessionId) => client.session.interrupt({ sessionID: targetSessionId })))
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
    if (!isSessionBusy(instanceId, sessionId)) {
      await getRootClient(instanceId).session.switchAgent({ sessionID: sessionId, agent })
      if (shouldApplyModel) {
        await getRootClient(instanceId).session.switchModel({ sessionID: sessionId, model: getNativeModel(instanceId, nextModel) })
      }
    }
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

  const nativeModel = getNativeModel(instanceId, model)
  try {
    if (!isSessionBusy(instanceId, sessionId)) {
      await getRootClient(instanceId).session.switchModel({ sessionID: sessionId, model: nativeModel })
    }
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

async function moveSession(instanceId: string, sessionId: string, directory: string): Promise<void> {
  if (!directory.trim()) throw new Error("Session directory is required")
  await getRootClient(instanceId).session.move({ sessionID: sessionId, directory })
  withSession(instanceId, sessionId, (session) => {
    session.location = { directory }
  })
}

async function compactSession(instanceId: string, sessionId: string): Promise<void> {
  await getRootClient(instanceId).session.compact({ sessionID: sessionId })
}

async function deleteMessagePart(instanceId: string, sessionId: string, messageId: string, partId: string): Promise<void> {
  const record = messageStoreBus.getOrCreate(instanceId).getMessage(messageId)
  const partIndex = record?.partIds.indexOf(partId) ?? -1
  const part = partIndex >= 0 ? record?.parts[partId]?.data : undefined
  if (record?.sessionId !== sessionId || record.role !== "assistant" || !["complete", "error"].includes(record.status)
    || (part?.type !== "tool" && part?.type !== "reasoning")) {
    throw new Error("Message part is not deletable")
  }

  const client = getRootClient(instanceId)
  const message = await client.session.message({ sessionID: sessionId, messageID: messageId })
  if (message.type !== "assistant" || !message.time.completed) {
    throw new Error("Message content changed before deletion")
  }
  const target = message.content[partIndex]
  if (target?.type !== part.type
    || (target.type === "tool" && target.id !== partId)) {
    throw new Error("Message content changed before deletion")
  }

  await client.session.messageUpdate({
    sessionID: sessionId,
    messageID: messageId,
    content: message.content.filter((_, index) => index !== partIndex),
  })
}

async function deleteMessageTechnicalParts(instanceId: string, sessionId: string, messageId: string): Promise<void> {
  const client = getRootClient(instanceId)
  const message = await client.session.message({ sessionID: sessionId, messageID: messageId })
  if (message.type !== "assistant" || !message.time.completed) throw new Error("Message is not complete")
  const content = message.content.filter((part) => part.type !== "tool" && part.type !== "reasoning")
  if (content.length === message.content.length) return
  await client.session.messageUpdate({ sessionID: sessionId, messageID: messageId, content })
}

export interface SessionTechnicalPartDeletionPlan {
  instanceId: string
  sessionId: string
  toolCount: number
  reasoningCount: number
  messageIds: string[]
}

async function planSessionTechnicalPartDeletion(instanceId: string, sessionId: string): Promise<SessionTechnicalPartDeletionPlan> {
  const client = getRootClient(instanceId)
  const messageIds: string[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let toolCount = 0
  let reasoningCount = 0

  for (;;) {
    const response = await client.message.list({ sessionID: sessionId, limit: 200, ...(cursor ? { cursor } : { order: "asc" }) })
    for (const message of response.data) {
      if (message.type !== "assistant" || !message.time.completed) continue
      const tools = message.content.filter((part) => part.type === "tool").length
      const reasoning = message.content.filter((part) => part.type === "reasoning").length
      if (tools + reasoning === 0) continue
      toolCount += tools
      reasoningCount += reasoning
      messageIds.push(message.id)
    }

    const next = response.cursor?.next ?? undefined
    if (!next) break
    if (seenCursors.has(next)) throw new Error("Repeated message cursor")
    seenCursors.add(next)
    cursor = next
  }

  return { instanceId, sessionId, toolCount, reasoningCount, messageIds }
}

async function executeSessionTechnicalPartDeletion(plan: SessionTechnicalPartDeletionPlan): Promise<number> {
  let failed = 0
  for (const messageId of plan.messageIds) {
    try {
      await deleteMessageTechnicalParts(plan.instanceId, plan.sessionId, messageId)
    } catch {
      failed += 1
    }
  }
  return failed
}

export {
  abortSession,
  executeCustomCommand,
  compactSession,
  deleteMessagePart,
  deleteMessageTechnicalParts,
  executeSessionTechnicalPartDeletion,
  planSessionTechnicalPartDeletion,
  renameSession,
  moveSession,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
}
