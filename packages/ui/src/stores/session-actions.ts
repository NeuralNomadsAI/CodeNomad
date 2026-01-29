import { resolvePastedPlaceholders } from "../lib/prompt-placeholders"
import { instances } from "./instances"

import { addRecentModelPreference, getModelThinkingSelection, setAgentModelPreference } from "./preferences"
import { providers, sessions, setSessions, withSession } from "./session-state"
import { getDefaultModel, isModelValid } from "./session-models"
import { updateSessionInfo } from "./message-v2/session-info"
import { messageStoreBus } from "./message-v2/bus"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"

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

const SEMANTIC_NAMING_MODELS = [
  "opencode/big-pickle",
  "github-copilot/gpt-5-mini",
  "google/antigravity-gemini-3-flash",
  "zai-coding-plan/glm-4.7",
  "github-copilot/gpt-4o",
  "github-copilot/gpt-4.1",
]

// Track transient sessions used for semantic naming to filter their SSE events
const transientSessionIds = new Set<string>()

/**
 * Check if a session is transient (used for background semantic naming).
 * SSE event handlers should ignore events for transient sessions.
 */
export function isTransientSession(sessionId: string): boolean {
  return transientSessionIds.has(sessionId)
}

function getSemanticNamingModel(instanceId: string): { providerId: string; modelId: string } | undefined {
  const instanceProviders = providers().get(instanceId) || []

  // Helper to find if a model exists in providers
  const findModel = (fullId: string) => {
    const [pId, ...mIdParts] = fullId.split("/")
    const mId = mIdParts.join("/")
    const provider = instanceProviders.find((p) => p.id === pId)
    return provider?.models.find((m) => m.id === mId) ? { providerId: pId, modelId: mId } : undefined
  }

  // 2. Iterate through free/preferred list
  for (const modelKey of SEMANTIC_NAMING_MODELS) {
    const found = findModel(modelKey)
    if (found) return found
  }

  return undefined
}

function generateHeuristicTitle(prompt: string): string | null {
  // 1. Check for file paths/mentions first (High signal)
  // Matches: @file.ext, ./file.ext, /path/to/file
  const fileMatch = prompt.match(/(?:@|[\/\\])?([\w.-]+\.\w+)/)
  if (fileMatch?.[1] && fileMatch[1].length < 30) return `Context: ${fileMatch[1]}`

  // 2. Filter conversational noise (Stop words)
  const stopWords = new Set(
    "hi hello hey can you please pls help me with the a an is it does how to for in of about what we i my our us this that there here".split(
      " ",
    ),
  )

  // Split, clean, and filter
  const words = prompt
    .replace(/[^\w\s-]/g, "") // Remove special chars (keep dashes/underscores)
    .split(/\s+/)
    .filter((w) => {
      // Filter stop words and suspicious long strings (potential keys > 25 chars)
      return !stopWords.has(w.toLowerCase()) && w.length < 25
    })

  // 3. Construct Title (Character Budget Approach)
  if (words.length > 0) {
    let title = ""
    const charLimit = 30

    for (const word of words) {
      // If adding this word exceeds limit (plus space), check if we should stop
      if (title.length + word.length + (title ? 1 : 0) > charLimit) {
        // If we have at least one word, stop and add ellipsis
        if (title.length > 0) {
          title += "..."
          break
        }
      }

      // Capitalize first letter of the result for the very first word
      const nextWord = title.length === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
      title += (title ? " " : "") + nextWord
    }

    // If we used all words but didn't hit the limit, no ellipsis needed.
    // But if there were more words remaining in the source array than we used, add ellipsis
    if (!title.endsWith("...") && title.split(" ").length < words.length) title += "..."

    return title
  }

  return null
}

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

  const instanceSessions = sessions().get(instanceId)
  const session = instanceSessions?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
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

  const store = messageStoreBus.getOrCreate(instanceId)
  const createdAt = Date.now()

  // Semantic Session Naming
  // If this is the first message in the session, generate a better title
  // using a free model (without consuming premium tokens)
  if (store.getSessionMessageIds(sessionId).length === 0) {
    const semanticModel = getSemanticNamingModel(instanceId)
    const client = instance.client

    if (semanticModel && client) {
      // Use a transient session to generate the title safely without compacting the main session history
      client.session
        .create({})
        .then(async (res) => {
          const tempId = res.data?.id
          if (!tempId) throw new Error("Failed to create temp session")

          // Track this session as transient so SSE handlers ignore its events
          transientSessionIds.add(tempId)

          // Clean up if SSE already added this session to the store (race condition)
          const existingSession = sessions().get(instanceId)?.get(tempId)
          if (existingSession) {
            setSessions((prev) => {
              const next = new Map(prev)
              const instanceSessions = next.get(instanceId)
              if (instanceSessions) {
                instanceSessions.delete(tempId)
                next.set(instanceId, instanceSessions)
              }
              return next
            })
          }

          try {
            // Send the user prompt to the temp session using a free model
            await requestData(
              client.session.promptAsync({
                sessionID: tempId,
                parts: [
                  {
                    type: "text",
                    text: prompt,
                  },
                ],
                model: { providerID: semanticModel.providerId, modelID: semanticModel.modelId },
              }),
              "session.promptAsync_temp",
            )
            
            // Wait for the backend to process and set a title
            await new Promise(resolve => setTimeout(resolve, 2000))

            // Fetch the title from the temp session
            const tempSessionData = await requestData(
              client.session.get({
                sessionID: tempId,
              }),
              "session.get_temp",
            )

            const semanticTitle = tempSessionData?.title
            if (semanticTitle && !semanticTitle.startsWith("New session -")) {
              // Apply the semantic title to the real session
              await renameSession(instanceId, sessionId, semanticTitle)
              log.info("Semantic session naming applied", { sessionId, title: semanticTitle })
            } else {
              // Fallback to heuristic
              throw new Error("No semantic title generated")
            }
          } catch (innerErr) {
            log.warn("Transient semantic naming failed", innerErr)
            // Fallback: Use heuristic naming
            const autoTitle = generateHeuristicTitle(prompt)
            if (autoTitle && session.title.startsWith("New session -")) {
              renameSession(instanceId, sessionId, autoTitle).catch((err) => {
                log.warn("Failed to auto-rename session (fallback)", err)
              })
            }
          } finally {
            // Cleanup: Delete the temp session and remove from transient tracking
            transientSessionIds.delete(tempId)

            // Also clean up from sessions store if it somehow got added
            const residualSession = sessions().get(instanceId)?.get(tempId)
            if (residualSession) {
              setSessions((prev) => {
                const next = new Map(prev)
                const instanceSessions = next.get(instanceId)
                if (instanceSessions) {
                  instanceSessions.delete(tempId)
                  next.set(instanceId, instanceSessions)
                }
                return next
              })
            }

            client.session.delete({ sessionID: tempId }).catch((err) => {
              log.warn("Failed to delete temp session", err)
            })
          }
        })
        .catch((err) => {
          log.warn("Failed to initiate semantic naming", err)
          // Fallback: Heuristic
          const autoTitle = generateHeuristicTitle(prompt)
          if (autoTitle && session.title.startsWith("New session -")) {
            renameSession(instanceId, sessionId, autoTitle).catch((err) => {
              log.warn("Failed to auto-rename session", err)
            })
          }
        })
    } else {
      const autoTitle = generateHeuristicTitle(prompt)
      if (autoTitle && session.title.startsWith("New session -")) {
        // Fire and forget - don't block the message sending
        renameSession(instanceId, sessionId, autoTitle).catch((err) => {
          log.warn("Failed to auto-rename session", err)
        })
      }
    }
  }


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
      instance.client.session.promptAsync({
        sessionID: sessionId,
        ...(requestBody as any),
      }),
      "session.promptAsync",
    )
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
    instance.client.session.command({
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

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const agent = session.agent || "build"

  await requestData(
    instance.client.session.shell({
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

  log.info("abortSession", { instanceId, sessionId })

  try {
    log.info("session.abort", { instanceId, sessionId })
    await requestData(
      instance.client.session.abort({
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

  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const trimmedTitle = nextTitle.trim()
  if (!trimmedTitle) {
    throw new Error("Session title is required")
  }

  await requestData(
    instance.client.session.update({
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

export {
  abortSession,
  executeCustomCommand,
  renameSession,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
}
