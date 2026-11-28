import { createEffect, createRoot, createSignal, on } from "solid-js"
import { tGlobal } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { getLogger } from "../lib/logger"
import { microphoneUse } from "../lib/microphone-lease"
import { getSpeechPlaybackSupport } from "../lib/speech-playback-support"
import { playSpeech } from "../lib/speech-playback"
import { serverSettings } from "./preferences"
import { loadSpeechCapabilities, speechCapabilities } from "./speech"
import { getActiveSession, sessions } from "./session-state"
import type { ClientPart, MessageInfo } from "../types/message"
import { messageStoreBus } from "./message-v2/bus"
import { activeInstanceId } from "./instances"
import { voiceConversationEngine, voiceConversationEngineLoaded, voiceConversationReadFailed } from "./voice-conversation-engine"

interface ConversationQueueEntry {
  key: string
  instanceId: string
  sessionId: string
  messageId: string
  partId: string
  text: string
}

const log = getLogger("actions")
const [conversationModeInstances, setConversationModeInstances] = createSignal<Map<string, boolean>>(new Map())
const LEADING_SPOKEN_BLOCK_REGEX = /^\s*```spoken[ \t]*\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/i

const queuedKeys = new Set<string>()
const spokenKeysBySession = new Map<string, Set<string>>()
let queue: ConversationQueueEntry[] = []
let currentPlayback:
  | {
      entry: ConversationQueueEntry
      controller: AbortController
    }
  | null = null
let queueRunner: Promise<void> | null = null
let playbackErrorShown = false

const microphoneBlocksPlayback = () => {
  const purpose = microphoneUse()
  return purpose === "dictation" || purpose === "test"
}

createRoot(() => createEffect(on(microphoneBlocksPlayback, blocked => {
  if (blocked) currentPlayback?.controller.abort()
  else void runConversationQueue()
})))

function getEntryKey(instanceId: string, sessionId: string, messageId: string, partId: string): string {
  return `${instanceId}:${sessionId}:${messageId}:${partId}`
}

function getSpokenKeySet(instanceId: string, sessionId: string): Set<string> {
  const sessionKey = `${instanceId}:${sessionId}`
  const existing = spokenKeysBySession.get(sessionKey)
  if (existing) return existing
  const next = new Set<string>()
  spokenKeysBySession.set(sessionKey, next)
  return next
}

function resolveTextPartContent(part: ClientPart): string {
  if (part.type !== "text") return ""
  if (typeof part.text === "string") {
    return part.text
  }

  if (part.text && typeof part.text === "object") {
    const value = part.text as { text?: unknown; value?: unknown; content?: unknown[] }
    const segments: string[] = []
    if (typeof value.text === "string") {
      segments.push(value.text)
    }
    if (typeof value.value === "string") {
      segments.push(value.value)
    }
    if (Array.isArray(value.content)) {
      for (const segment of value.content) {
        if (typeof segment === "string") {
          segments.push(segment)
        } else if (segment && typeof segment === "object") {
          const typedSegment = segment as { text?: unknown; value?: unknown }
          if (typeof typedSegment.text === "string") segments.push(typedSegment.text)
          if (typeof typedSegment.value === "string") segments.push(typedSegment.value)
        }
      }
    }
    return segments.join("\n")
  }

  return ""
}

export function isConversationModeEnabled(instanceId: string): boolean {
  return conversationModeInstances().get(instanceId) === true
}

export function classicConversationUnavailable(): "loading" | "capabilitiesError" | "setupPlayback" | "unsupportedFormat" | undefined {
  if (voiceConversationReadFailed()) return "capabilitiesError"
  if (!voiceConversationEngineLoaded() || voiceConversationEngine() !== "classic") return "loading"
  const capabilities = speechCapabilities()
  if (!capabilities?.available || !capabilities.ttsConfigured || !capabilities.supportsTts) {
    return "setupPlayback"
  }

  const settings = serverSettings().speech
  if (!getSpeechPlaybackSupport({
    playbackMode: settings.playbackMode,
    ttsFormat: settings.ttsFormat,
    capabilities,
  }).available) return "unsupportedFormat"
}

export function toggleConversationMode(instanceId: string): void {
  const enabled = !isConversationModeEnabled(instanceId)
  setConversationModeInstances((prev) => {
    const next = new Map(prev)
    if (enabled) {
      next.set(instanceId, true)
    } else {
      next.delete(instanceId)
    }
    return next
  })

  if (!enabled) {
    clearConversationPlaybackForInstance(instanceId)
  }
}

export function clearConversationPlaybackForSession(instanceId: string, sessionId: string): void {
  const sessionKey = `${instanceId}:${sessionId}`
  queue = queue.filter((entry) => {
    if (`${entry.instanceId}:${entry.sessionId}` === sessionKey) {
      queuedKeys.delete(entry.key)
      return false
    }
    return true
  })

  if (currentPlayback && `${currentPlayback.entry.instanceId}:${currentPlayback.entry.sessionId}` === sessionKey) {
    currentPlayback.controller.abort()
  }
}

export function clearConversationPlaybackForInstance(instanceId: string): void {
  queue = queue.filter((entry) => {
    if (entry.instanceId === instanceId) {
      queuedKeys.delete(entry.key)
      return false
    }
    return true
  })

  if (currentPlayback?.entry.instanceId === instanceId) {
    currentPlayback.controller.abort()
  }
}

function isSpeakableSession(instanceId: string, sessionId: string): boolean {
  if (activeInstanceId() !== instanceId) {
    return false
  }

  const activeSession = getActiveSession(instanceId)
  if (!activeSession || activeSession.id !== sessionId) {
    return false
  }

  const session = sessions().get(instanceId)?.get(sessionId) ?? activeSession
  return !session?.parentId
}

export function handleConversationAssistantPartUpdated(instanceId: string, part: ClientPart, messageInfo?: MessageInfo): void {
  if (part.type !== "text") return

  const sessionId = typeof part.sessionID === "string" ? part.sessionID : messageInfo?.sessionID
  const messageId = typeof part.messageID === "string" ? part.messageID : messageInfo?.id
  const partId = typeof part.id === "string" ? part.id : undefined
  if (!sessionId || !messageId || !partId) return

  const messageRole =
    messageInfo?.role ??
    messageStoreBus.getOrCreate(instanceId).getMessage(messageId)?.role ??
    null
  if (messageRole !== "assistant") return

  if (!isConversationModeEnabled(instanceId)) return
  if (!isSpeakableSession(instanceId, sessionId)) return

  const text = extractLeadingSpokenBlock(resolveTextPartContent(part))
  if (!text) return

  const key = getEntryKey(instanceId, sessionId, messageId, partId)
  const spokenKeys = getSpokenKeySet(instanceId, sessionId)
  if (spokenKeys.has(key) || queuedKeys.has(key) || currentPlayback?.entry.key === key) {
    return
  }

  queuedKeys.add(key)
  queue.push({ key, instanceId, sessionId, messageId, partId, text })
  void runConversationQueue()
}

async function runConversationQueue(): Promise<void> {
  if (queueRunner || !queue.length || microphoneBlocksPlayback()) return

  queueRunner = (async () => {
    while (queue.length > 0 && !microphoneBlocksPlayback()) {
      const entry = queue.shift()!
      queuedKeys.delete(entry.key)

      if (!isConversationModeEnabled(entry.instanceId)) {
        continue
      }
      if (!isSpeakableSession(entry.instanceId, entry.sessionId)) {
        continue
      }

      const spokenKeys = getSpokenKeySet(entry.instanceId, entry.sessionId)
      spokenKeys.add(entry.key)

      const controller = new AbortController()
      currentPlayback = { entry, controller }
      try {
        await playSummary(entry.text, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) continue
        spokenKeys.delete(entry.key)
        // The failed playback has settled; an HTTP 401 status check can still finish.
        currentPlayback = null
        clearConversationPlaybackForInstance(entry.instanceId)
        if (!playbackErrorShown) {
          playbackErrorShown = true
          showToastNotification({ category: "sessions",
            title: tGlobal("promptInput.conversationMode.error.title"),
            message:
              error instanceof Error && error.message
                ? error.message
                : tGlobal("promptInput.conversationMode.error.message"),
            variant: "error",
          })
        }
        log.error("Conversation playback failed", error)
        break
      } finally {
        if (currentPlayback?.controller === controller) {
          currentPlayback = null
        }
      }
    }
  })()

  try {
    await queueRunner
  } finally {
    queueRunner = null
    if (queue.length === 0) {
      playbackErrorShown = false
    } else void runConversationQueue()
  }
}

async function playSummary(text: string, signal: AbortSignal): Promise<void> {
  const capabilities = (await loadSpeechCapabilities()) ?? speechCapabilities()
  if (signal.aborted) throw signal.reason
  const settings = serverSettings().speech

  if (!capabilities?.available || !capabilities.ttsConfigured || !capabilities.supportsTts) {
    throw new Error(tGlobal("messageItem.actions.speak.error.unavailable"))
  }

  const support = getSpeechPlaybackSupport({
    playbackMode: settings.playbackMode,
    ttsFormat: settings.ttsFormat,
    capabilities,
  })
  if (!support.available) {
    if (support.reason === "provider-streaming-unavailable") {
      throw new Error(tGlobal("settings.speech.compatibility.streamingUnavailable"))
    }
    if (support.reason === "browser-streaming-unavailable") {
      throw new Error(tGlobal("settings.speech.compatibility.browserStreamingUnavailable"))
    }
    throw new Error(tGlobal("messageItem.actions.speak.error.unsupported"))
  }

  return playSpeech(text, settings, signal)
}

function extractLeadingSpokenBlock(text: string): string {
  const match = text.match(LEADING_SPOKEN_BLOCK_REGEX)
  if (!match?.[1]) return ""
  return match[1].trim()
}
