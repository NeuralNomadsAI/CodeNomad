import { createSignal } from "solid-js"
import { tGlobal } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"
import { formatToMimeType, getSpeechPlaybackSupport } from "../lib/speech-playback-support"
import { serverSettings } from "./preferences"
import { loadSpeechCapabilities, speechCapabilities } from "./speech"
import { getActiveSession, sessions } from "./session-state"
import type { ClientPart, MessageInfo } from "../types/message"
import { messageStoreBus } from "./message-v2/bus"
import { activeInstanceId } from "./instances"

type SpeechPlaybackMode = "streaming" | "buffered"
type SpeechTtsFormat = "mp3" | "wav" | "opus" | "aac"

interface ConversationQueueEntry {
  key: string
  instanceId: string
  sessionId: string
  messageId: string
  partId: string
  text: string
}

interface PlaybackHandle {
  stop: () => void
  done: Promise<void>
}

const log = getLogger("actions")
const [conversationModeInstances, setConversationModeInstances] = createSignal<Map<string, boolean>>(new Map())

const queuedKeys = new Set<string>()
const spokenKeysBySession = new Map<string, Set<string>>()
let queue: ConversationQueueEntry[] = []
let currentPlayback:
  | {
      entry: ConversationQueueEntry
      handle: PlaybackHandle
    }
  | null = null
let queueRunner: Promise<void> | null = null
let playbackErrorShown = false

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

export function canUseConversationMode(): boolean {
  const capabilities = speechCapabilities()
  if (!capabilities?.available || !capabilities.configured || !capabilities.supportsTts) {
    return false
  }

  const settings = serverSettings().speech
  return getSpeechPlaybackSupport({
    playbackMode: settings.playbackMode,
    ttsFormat: settings.ttsFormat,
    capabilities,
  }).available
}

export function setConversationModeEnabled(instanceId: string, enabled: boolean): void {
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

export function toggleConversationMode(instanceId: string): void {
  setConversationModeEnabled(instanceId, !isConversationModeEnabled(instanceId))
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
    currentPlayback.handle.stop()
    currentPlayback = null
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
    currentPlayback.handle.stop()
    currentPlayback = null
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

  const text = resolveTextPartContent(part).trim()
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
  if (queueRunner) {
    await queueRunner
    return
  }

  queueRunner = (async () => {
    while (queue.length > 0) {
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

      try {
        const handle = await createPlaybackHandle(entry.text)
        currentPlayback = { entry, handle }
        await handle.done
      } catch (error) {
        spokenKeys.delete(entry.key)
        clearConversationPlaybackForInstance(entry.instanceId)
        if (!playbackErrorShown) {
          playbackErrorShown = true
          showToastNotification({
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
        if (currentPlayback?.entry.key === entry.key) {
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
    }
  }
}

async function createPlaybackHandle(text: string): Promise<PlaybackHandle> {
  const capabilities = (await loadSpeechCapabilities()) ?? speechCapabilities()
  const settings = serverSettings().speech

  if (!capabilities?.available || !capabilities.configured || !capabilities.supportsTts) {
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

  return settings.playbackMode === "streaming"
    ? createStreamingPlaybackHandle(text, settings.ttsFormat)
    : createBufferedPlaybackHandle(text, settings.ttsFormat)
}

async function createBufferedPlaybackHandle(text: string, format: SpeechTtsFormat): Promise<PlaybackHandle> {
  const response = await serverApi.synthesizeSpeech({ text, format })
  const objectUrl = createObjectUrlFromBase64(response.audioBase64, response.mimeType)
  const audio = new Audio(objectUrl)

  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (error: unknown) => void

  const cleanup = () => {
    audio.pause()
    audio.src = ""
    audio.load()
    URL.revokeObjectURL(objectUrl)
  }

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    rejectDone = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
  })

  audio.addEventListener("ended", () => resolveDone(), { once: true })
  audio.addEventListener("error", () => rejectDone(new Error(tGlobal("messageItem.actions.speak.error.generate"))), {
    once: true,
  })

  await audio.play()

  return {
    stop: () => resolveDone(),
    done,
  }
}

async function createStreamingPlaybackHandle(text: string, format: SpeechTtsFormat): Promise<PlaybackHandle> {
  if (typeof MediaSource === "undefined") {
    throw new Error(tGlobal("messageItem.actions.speak.error.unsupported"))
  }

  const abortController = new AbortController()
  const response = await serverApi.synthesizeSpeechStream({ text, format }, abortController.signal)
  const mimeType = response.headers.get("content-type") || formatToMimeType(format)
  const stream = response.body
  if (!stream) {
    throw new Error(tGlobal("messageItem.actions.speak.error.generate"))
  }

  if (!MediaSource.isTypeSupported(mimeType)) {
    throw new Error(tGlobal("settings.speech.compatibility.browserStreamingUnavailable"))
  }

  const mediaSource = new MediaSource()
  const objectUrl = URL.createObjectURL(mediaSource)
  const audio = new Audio(objectUrl)

  let settled = false
  let startedPlayback = false
  let resolveDone!: () => void
  let rejectDone!: (error: unknown) => void

  const cleanup = () => {
    abortController.abort()
    audio.pause()
    audio.src = ""
    audio.load()
    URL.revokeObjectURL(objectUrl)
  }

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    rejectDone = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
  })

  audio.addEventListener("ended", () => resolveDone(), { once: true })
  audio.addEventListener("error", () => rejectDone(new Error(tGlobal("messageItem.actions.speak.error.generate"))), {
    once: true,
  })

  await new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        void streamToMediaSource({
          mediaSource,
          stream,
          mimeType,
          onPlayable: async () => {
            if (startedPlayback) return
            startedPlayback = true
            try {
              await audio.play()
              resolve()
            } catch (error) {
              reject(error)
            }
          },
          onError: reject,
        })
      },
      { once: true },
    )
  })

  return {
    stop: () => resolveDone(),
    done,
  }
}

async function streamToMediaSource(options: {
  mediaSource: MediaSource
  stream: ReadableStream<Uint8Array>
  mimeType: string
  onPlayable: () => Promise<void>
  onError: (error: unknown) => void
}) {
  try {
    const sourceBuffer = options.mediaSource.addSourceBuffer(options.mimeType)
    const reader = options.stream.getReader()
    const queue: Uint8Array[] = []
    let processing = false
    let playbackStarted = false

    const flushQueue = async () => {
      if (processing || sourceBuffer.updating || queue.length === 0) return
      processing = true
      const chunk = queue.shift()!
      await appendChunk(sourceBuffer, chunk)
      if (!playbackStarted) {
        playbackStarted = true
        await options.onPlayable()
      }
      processing = false
      await flushQueue()
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        queue.push(value)
        await flushQueue()
      }
    }

    while (queue.length > 0 || sourceBuffer.updating) {
      if (queue.length > 0) {
        await flushQueue()
      } else {
        await waitForUpdateEnd(sourceBuffer)
      }
    }

    if (options.mediaSource.readyState === "open") {
      options.mediaSource.endOfStream()
    }
  } catch (error) {
    options.onError(error)
  }
}

function appendChunk(sourceBuffer: SourceBuffer, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleUpdateEnd = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error(tGlobal("messageItem.actions.speak.error.generate")))
    }
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", handleUpdateEnd)
      sourceBuffer.removeEventListener("error", handleError)
    }

    sourceBuffer.addEventListener("updateend", handleUpdateEnd, { once: true })
    sourceBuffer.addEventListener("error", handleError, { once: true })
    sourceBuffer.appendBuffer(new Uint8Array(chunk).buffer)
  })
}

function waitForUpdateEnd(sourceBuffer: SourceBuffer): Promise<void> {
  return new Promise((resolve) => {
    sourceBuffer.addEventListener("updateend", () => resolve(), { once: true })
  })
}

function createObjectUrlFromBase64(audioBase64: string, mimeType: string): string {
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || "audio/mpeg" }))
}
