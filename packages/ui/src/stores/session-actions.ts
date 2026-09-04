import type { ModelRef, SessionInboxDelivery, SessionInboxUserPayload, SessionMessageInfo, SessionPromptInput } from "@opencode-ai/client"
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
import { MESSAGE_WINDOW_PAGE_SIZE } from "./message-v2/message-window"
import { normalizeSessionMessage } from "./message-v2/normalizers"
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
const technicalPartUpdates = new Map<string, Promise<void>>()
const sessionAdmissions = new Map<string, Promise<unknown>>()

function admitSessionAction<T>(instanceId: string, sessionId: string, action: () => Promise<T>): Promise<T> {
  const key = `${instanceId}:${sessionId}`
  const run = (sessionAdmissions.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const admission = beginSessionGenerationAdmission(instanceId, sessionId)
    try {
      const result = await action()
      admission.complete()
      return result
    } catch (error) {
      admission.rollback()
      throw error
    }
  })
  const settled = run.finally(() => {
    if (sessionAdmissions.get(key) === settled) sessionAdmissions.delete(key)
  })
  sessionAdmissions.set(key, settled)
  return settled
}

function serializeTechnicalPartUpdate(
  instanceId: string,
  sessionId: string,
  messageId: string,
  update: () => Promise<void>,
): Promise<void> {
  const key = `${instanceId}:${sessionId}:${messageId}`
  const current = (technicalPartUpdates.get(key) ?? Promise.resolve()).catch(() => undefined).then(update)
  const settled = current.finally(() => {
    if (technicalPartUpdates.get(key) === settled) technicalPartUpdates.delete(key)
  })
  technicalPartUpdates.set(key, settled)
  return settled
}

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
  options: { delivery?: SessionInboxDelivery; restoredPayload?: SessionInboxUserPayload } = {},
): Promise<string> {
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
  const textPartId = createId("prt")

  const preparedPrompt = preparePromptDisplayText(prompt, attachments)
  const restoredDisplayText = options.restoredPayload?.metadata?.displayText
  if (typeof restoredDisplayText === "string" && options.restoredPayload?.text.startsWith(restoredDisplayText)) {
    preparedPrompt.promptToSend += options.restoredPayload.text.slice(restoredDisplayText.length)
  }
  const optimisticParts: any[] = [
    {
      id: textPartId,
      type: "text" as const,
      text: preparedPrompt.promptToSend,
      renderCache: undefined,
    },
  ]

  const files: Array<NonNullable<SessionPromptInput["files"]>[number]> = []
  const agents: Array<NonNullable<SessionPromptInput["agents"]>[number]> = []
  const remapMention = (mention: { text: string } | undefined) => {
    if (!mention) return undefined
    const start = prompt.indexOf(mention.text)
    return start < 0 ? undefined : { text: mention.text, start, end: start + mention.text.length }
  }
  const restoredFiles = [...(options.restoredPayload?.files ?? [])]

  if (attachments.length > 0) {
    for (const att of attachments) {
      const source = att.source
      if (source.type === "file") {
        const partId = createId("prt")
        const restoredIndex = restoredFiles.findIndex((file) => {
          const uri = file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`
          return uri === att.url
        })
        const restored = restoredIndex < 0 ? undefined : restoredFiles.splice(restoredIndex, 1)[0]
        const mention = remapMention(restored?.mention)
        files.push({
          uri: att.url,
          name: att.filename,
          ...(restored?.description ? { description: restored.description } : {}),
          ...(mention ? { mention } : {}),
        })
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
          ?? remapMention(options.restoredPayload?.agents?.find((agent) => agent.name === source.name)?.mention)
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
    store.trimSessionMessages(sessionId, MESSAGE_WINDOW_PAGE_SIZE)
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
    ...(options.restoredPayload?.skills ? {
      skills: options.restoredPayload.skills.flatMap((skill) => {
        const mention = remapMention(skill.mention)
        return skill.mention && !mention ? [] : [{ id: skill.id, ...(mention ? { mention } : {}) }]
      }),
    } : {}),
    ...(options.restoredPayload ? { metadata: { ...options.restoredPayload.metadata, displayText: prompt } } : {}),
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
    await admitSessionAction(instanceId, sessionId, async () => {
      const currentInstance = instances().get(instanceId)
      const currentSession = sessions().get(instanceId)?.get(sessionId)
      if (!currentInstance?.client) throw new Error("Instance not ready")
      if (!currentSession) throw new Error("Session not found")
      const client = getRootClient(instanceId)
      await syncVoiceModeInstruction(client, instanceId, sessionId)
      if (options.delivery !== "queue") {
        if (currentSession.agent) await client.session.switchAgent({ sessionID: sessionId, agent: currentSession.agent })
        if (currentSession.model.providerId && currentSession.model.modelId) {
          await client.session.switchModel({ sessionID: sessionId, model: getNativeModel(instanceId, currentSession.model) })
        }
      }
      const result = await client.session.prompt({ sessionID: sessionId, ...requestBody })
      confirmedId = result?.id || messageId
      if (projectOptimistically && confirmedId !== messageId) store.replaceMessageId({ oldId: messageId, newId: confirmedId })
      if (projectOptimistically) store.acceptSend(confirmedId)
    })
  } catch (error) {
    if (projectOptimistically) store.failSend(messageId)
    log.error("Failed to send prompt", error)
    throw error
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

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  await admitSessionAction(instanceId, sessionId, async () => {
    if (!instances().get(instanceId)?.client) throw new Error("Instance not ready")
    if (!sessions().get(instanceId)?.has(sessionId)) throw new Error("Session not found")
    const client = getRootClient(instanceId)
    await syncVoiceModeInstruction(client, instanceId, sessionId)
    await client.session.command({ sessionID: sessionId, command: commandName, text: args, delivery: "steer" })
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

  await admitSessionAction(instanceId, sessionId, async () => {
    if (!instances().get(instanceId)?.client) throw new Error("Instance not ready")
    if (!sessions().get(instanceId)?.has(sessionId)) throw new Error("Session not found")
    const client = getRootClient(instanceId)
    await syncVoiceModeInstruction(client, instanceId, sessionId)
    await client.session.shell({ sessionID: sessionId, command })
  })
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

function applyUpdatedMessage(instanceId: string, sessionId: string, source: SessionMessageInfo): void {
  const { message, info } = normalizeSessionMessage(sessionId, source)
  const store = messageStoreBus.getOrCreate(instanceId)
  store.upsertMessage({
    id: message.id,
    sessionId: message.sessionId,
    role: message.type,
    status: message.status,
    createdAt: message.timestamp,
    updatedAt: message.timestamp,
    parts: message.parts,
  })
  store.setMessageInfo(info.id, info)
}

async function deleteSelectedMessageTechnicalParts(
  instanceId: string,
  sessionId: string,
  messageId: string,
  partIds: string[],
): Promise<void> {
  const record = messageStoreBus.getOrCreate(instanceId).getMessage(messageId)
  const targets = Array.from(new Set(partIds)).map((partId) => ({
    partId,
    part: record?.parts[partId]?.data,
  }))
  if (record?.sessionId !== sessionId || record.role !== "assistant" || !["complete", "error"].includes(record.status)
    || targets.length === 0
    || targets.some(({ part }) => part?.type !== "tool" && part?.type !== "reasoning")) {
    throw new Error("Message part is not deletable")
  }

  return serializeTechnicalPartUpdate(instanceId, sessionId, messageId, async () => {
    const client = getRootClient(instanceId)
    const message = await client.session.message({ sessionID: sessionId, messageID: messageId })
    if (message.type !== "assistant" || !message.time.completed) {
      throw new Error("Message content changed before deletion")
    }
    const currentRecord = messageStoreBus.getOrCreate(instanceId).getMessage(messageId)
    const indexes = new Set(targets.map((selected) => {
      const part = selected.part!
      const currentIndex = currentRecord?.partIds.indexOf(selected.partId) ?? -1
      if (currentIndex >= 0) return currentIndex
      const time = part.time as { created?: number; completed?: number } | undefined
      return message.content.findIndex((candidate) => {
        if (candidate.type !== part.type) return false
        if (candidate.type === "tool" && part.type === "tool") return candidate.id === part.id
        if (candidate.type !== "reasoning" || part.type !== "reasoning") return false
        return candidate.text === part.text
          && candidate.time?.created === time?.created
          && candidate.time?.completed === time?.completed
      })
    }))
    if (indexes.has(-1)) {
      throw new Error("Message content changed before deletion")
    }

    const updated = await client.session.messageUpdate({
      sessionID: sessionId,
      messageID: messageId,
      content: message.content.filter((_, index) => !indexes.has(index)),
    })
    applyUpdatedMessage(instanceId, sessionId, updated)
  })
}

async function deleteMessagePart(instanceId: string, sessionId: string, messageId: string, partId: string): Promise<void> {
  await deleteSelectedMessageTechnicalParts(instanceId, sessionId, messageId, [partId])
}

async function deleteMessageTechnicalParts(instanceId: string, sessionId: string, messageId: string, partIds?: string[]): Promise<void> {
  if (partIds) {
    await deleteSelectedMessageTechnicalParts(instanceId, sessionId, messageId, partIds)
    return
  }
  await serializeTechnicalPartUpdate(instanceId, sessionId, messageId, async () => {
    const client = getRootClient(instanceId)
    const message = await client.session.message({ sessionID: sessionId, messageID: messageId })
    if (message.type !== "assistant" || !message.time.completed) throw new Error("Message is not complete")
    const content = message.content.filter((part) => part.type !== "tool" && part.type !== "reasoning")
    if (content.length === message.content.length) return
    const updated = await client.session.messageUpdate({ sessionID: sessionId, messageID: messageId, content })
    applyUpdatedMessage(instanceId, sessionId, updated)
  })
}

async function deleteTechnicalPartGroup(
  instanceId: string,
  sessionId: string,
  parts: Array<{ messageId: string; partId: string }>,
): Promise<void> {
  const byMessage = new Map<string, string[]>()
  for (const part of parts) {
    const partIds = byMessage.get(part.messageId) ?? []
    partIds.push(part.partId)
    byMessage.set(part.messageId, partIds)
  }
  for (const [messageId, partIds] of byMessage) {
    await deleteMessageTechnicalParts(instanceId, sessionId, messageId, partIds)
  }
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

async function backgroundSession(instanceId: string, sessionId: string): Promise<void> {
  await getRootClient(instanceId).session.background({ sessionID: sessionId })
}

export {
  abortSession,
  backgroundSession,
  executeCustomCommand,
  compactSession,
  deleteMessagePart,
  deleteMessageTechnicalParts,
  deleteTechnicalPartGroup,
  executeSessionTechnicalPartDeletion,
  planSessionTechnicalPartDeletion,
  renameSession,
  moveSession,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
}
