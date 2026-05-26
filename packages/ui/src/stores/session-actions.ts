import { resolvePastedPlaceholders } from "../lib/prompt-placeholders"
import { instances } from "./instances"
import { getOrCreateWorktreeClient, getWorktreeSlugForSession } from "./worktrees"

import { addRecentModelPreference, getModelThinkingSelection, setAgentModelPreference } from "./preferences"
import { providers, sessions, withSession } from "./session-state"
import { getDefaultModel, isModelValid } from "./session-models"
import { updateSessionInfo } from "./message-v2/session-info"
import { messageStoreBus } from "./message-v2/bus"
import { removeMessagePartV2, removeMessageV2 } from "./message-v2/bridge"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"
import { clearConversationPlaybackForSession } from "./conversation-speech"
import { onNetworkRestored } from "../lib/network-status"
import { debugInfo, debugWarn, debugError } from "./debug-log"

const log = getLogger("actions")

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
  debugInfo("actions", `sendMessage: session=${sessionId.slice(0, 8)} len=${prompt.length}`)
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const messageId = createId("msg")
  const textPartId = createId("prt")

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
      type: "text" as const,
      text: resolvedPrompt,
    },
  ]

  if (attachments.length > 0) {
    for (const att of attachments) {
      const source = att.source
      if (source.type === "file") {
        const partId = createId("prt")
        requestParts.push({
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
        const isPathPlaceholder = typeof display === "string" && /^path:/.test(display)

        // Skip path: attachments from being sent as separate parts (content is already in prompt)
        // Skip pasted placeholders too (already resolved in prompt)
        if (isPastedPlaceholder || isPathPlaceholder || typeof value !== "string") {
          continue
        }

        const partId = createId("prt")
        requestParts.push({
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
  })

  withSession(instanceId, sessionId, () => {
    /* trigger reactivity for legacy session data */
  })

  const requestBody = {
    parts: requestParts,
    ...(session.agent && { agent: session.agent }),
    ...(session.model.providerId &&
      session.model.modelId && {
        model: {
          providerID: session.model.providerId,
          modelID: session.model.modelId,
        },
      }),
    ...(session.model.providerId &&
      session.model.modelId &&
      (() => {
        const variant = getThinkingVariantToSend(instanceId, session.model)
        return variant ? { variant } : {}
      })()),
  }

  log.info("sendMessage", {
    instanceId,
    sessionId,
    requestBody,
  })

  try {
    log.info("session.promptAsync", { instanceId, sessionId, requestBody })
    await requestData(
      client.session.promptAsync({
        sessionID: sessionId,
        ...(requestBody as any),
      }),
      "session.promptAsync",
    )
  } catch (error) {
    log.error("Failed to send prompt", error)
    const rawMsg = error instanceof Error ? error.message : String(error)
    const friendlyMsg =
      rawMsg.includes("Failed to fetch") || rawMsg.includes("NetworkError") || rawMsg.includes("network")
        ? "No network connection"
        : rawMsg.includes("timed out")
          ? "Request timed out"
          : rawMsg
    debugError("actions", `sendMessage failed: ${friendlyMsg}`)
    store.upsertMessage({
      id: messageId,
      sessionId,
      role: "user",
      status: "error",
      parts: optimisticParts,
      createdAt,
      isEphemeral: true,
    })
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

  const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const body: {
    command: string
    arguments: string
    messageID: string
    agent?: string
    model?: string
    variant?: string
  } = {
    command: commandName,
    arguments: args,
    messageID: createId("msg"),
  }

  if (session.agent) {
    body.agent = session.agent
  }

  if (session.model.providerId && session.model.modelId) {
    body.model = `${session.model.providerId}/${session.model.modelId}`
    const variant = getThinkingVariantToSend(instanceId, session.model)
    if (variant) body.variant = variant
  }

  await requestData(
    client.session.command({
      sessionID: sessionId,
      ...(body as any),
    }),
    "session.command",
  )
}

async function runShellCommand(instanceId: string, sessionId: string, command: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const agent = session.agent || "build"

  await requestData(
    client.session.shell({
      sessionID: sessionId,
      agent,
      command,
    }),
    "session.shell",
  )
}

async function abortSession(instanceId: string, sessionId: string): Promise<void> {
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

  log.info("abortSession", { instanceId, sessionId })

  try {
    log.info("session.abort", { instanceId, sessionId })
    await requestData(
      client.session.abort({
        sessionID: sessionId,
      }),
      "session.abort",
    )
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

  const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const trimmedTitle = nextTitle.trim()
  if (!trimmedTitle) {
    throw new Error("Session title is required")
  }

  await requestData(
    client.session.update({
      sessionID: sessionId,
      title: trimmedTitle,
    }),
    "session.update",
  )

  withSession(instanceId, sessionId, (current) => {
    current.title = trimmedTitle
    const time = { ...(current.time ?? {}) }
    time.updated = Date.now()
    current.time = time
  })
}

async function deleteMessagePart(instanceId: string, sessionId: string, messageId: string, partId: string): Promise<void> {
  if (!instanceId || !sessionId || !messageId || !partId) return
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

  await requestData(
    client.part.delete({
      sessionID: sessionId,
      messageID: messageId,
      partID: partId,
    }),
    "part.delete",
  )

  // Optimistic removal; SSE will also broadcast a part-removed event.
  removeMessagePartV2(instanceId, messageId, partId)
  updateSessionInfo(instanceId, sessionId)
}

async function deleteMessage(instanceId: string, sessionId: string, messageId: string): Promise<void> {
  if (!instanceId || !sessionId || !messageId) return
  const instance = instances().get(instanceId)
  if (!instance || !instance.client) {
    throw new Error("Instance not ready")
  }

  const worktreeSlug = getWorktreeSlugForSession(instanceId, sessionId)
  const client = getOrCreateWorktreeClient(instanceId, worktreeSlug)

  // The SDK generator does not currently expose a typed method for deleting a message,
  // but the API is available at DELETE /session/:sessionID/message/:messageID.
  await requestData(
    (client as any).client.delete({
      url: `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    }),
    "session.message.delete",
  )

  // Optimistic removal; SSE will also broadcast a message-removed event.
  removeMessageV2(instanceId, messageId)
  updateSessionInfo(instanceId, sessionId)
}

async function retrySendMessage(instanceId: string, sessionId: string, messageId: string): Promise<void> {
  debugInfo("actions", `retrySendMessage: session=${sessionId.slice(0, 8)} msg=${messageId.slice(0, 8)}`)
  const store = messageStoreBus.getOrCreate(instanceId)
  const message = store.getMessage(messageId)
  if (!message) {
    log.error("retrySendMessage: message not found", { instanceId, sessionId, messageId })
    throw new Error("Message not found")
  }

  const textParts: string[] = []
  for (const partId of message.partIds) {
    const part = message.parts[partId]
    if (part?.data?.type === "text") {
      textParts.push((part.data as { text: string }).text)
    }
  }

  const prompt = textParts.join("\n")
  if (!prompt) {
    log.error("retrySendMessage: no text content in message", { instanceId, sessionId, messageId })
    throw new Error("Message has no text content")
  }

  removeMessageV2(instanceId, messageId)

  await sendMessage(instanceId, sessionId, prompt)
}

// Auto-retry failed user messages when the browser regains connectivity
// and the message store indicates they are in error state.
function autoRetryOnReconnect() {
  onNetworkRestored(() => {
    // Collect unique failed messages first (deduplicate by messageId)
    const pending = new Map<string, { instId: string; sessId: string; msgId: string }>()
    const ids = instances()
    for (const instId of ids.keys()) {
      const store = messageStoreBus.getOrCreate(instId)
      if (!store) continue
      const sessEntries = Object.entries(store.state.sessions)
      for (const [sessId] of sessEntries) {
        const msgIds = store.getSessionMessageIds(sessId)
        for (const msgId of msgIds) {
          const msg = store.getMessage(msgId)
          if (msg && msg.status === "error" && msg.role === "user" && !pending.has(msgId)) {
            pending.set(msgId, { instId, sessId, msgId })
          }
        }
      }
    }

    if (pending.size === 0) return

    const count = pending.size
    log.info(`Auto-retrying ${count} failed message(s) after 3s delay`)
    debugInfo("actions", `Auto-retrying ${count} message(s) on reconnect in 3s`)

    // Delay to let SSE reconnect before retrying
    setTimeout(async () => {
      let success = 0
      for (const { instId, sessId, msgId } of pending.values()) {
        try {
          await retrySendMessage(instId, sessId, msgId)
          success++
        } catch (e) {
          log.error("Auto-retry failed", { instanceId: instId, sessionId: sessId, messageId: msgId, error: e })
        }
      }
      debugInfo("actions", `Auto-retry done: ${success}/${count} succeeded`)
    }, 3000)
  })
}

if (typeof window !== "undefined") {
  autoRetryOnReconnect()
}

export {
  abortSession,
  deleteMessage,
  deleteMessagePart,
  executeCustomCommand,
  renameSession,
  retrySendMessage,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
}
