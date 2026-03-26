import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import { useConfig, type SpeechSettings } from "../../stores/preferences"

type SpeechPlaybackState = "idle" | "loading" | "playing"

interface UseSpeechOptions {
  id: Accessor<string>
  text: Accessor<string>
  settingsOverride?: Accessor<Partial<Pick<SpeechSettings, "playbackMode" | "ttsFormat">>>
}

interface ActivePlaybackEntry {
  ownerId: string
  stop: () => void
}

const stateResetters = new Map<string, () => void>()

let activePlayback: ActivePlaybackEntry | null = null

function resetOwnerState(ownerId: string) {
  stateResetters.get(ownerId)?.()
}

function stopActivePlayback(ownerId?: string) {
  if (!activePlayback) return
  if (ownerId && activePlayback.ownerId !== ownerId) return
  const current = activePlayback
  activePlayback = null
  current.stop()
}

function setActivePlayback(ownerId: string, stop: () => void) {
  if (activePlayback?.ownerId === ownerId) {
    activePlayback = { ownerId, stop }
    return
  }

  stopActivePlayback()
  activePlayback = { ownerId, stop }
}

export function useSpeech(options: UseSpeechOptions) {
  const { t } = useI18n()
  const { serverSettings } = useConfig()
  const [state, setState] = createSignal<SpeechPlaybackState>("idle")

  let requestVersion = 0
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  let mediaSource: MediaSource | null = null
  let abortController: AbortController | null = null

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  const cleanupAudio = () => {
    if (abortController) {
      abortController.abort()
      abortController = null
    }

    if (audio) {
      audio.pause()
      audio.currentTime = 0
      audio.src = ""
      audio.load()
      audio = null
    }

    mediaSource = null

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  const resetState = () => {
    requestVersion += 1
    cleanupAudio()
    setState("idle")
  }

  stateResetters.set(options.id(), resetState)

  onCleanup(() => {
    stateResetters.delete(options.id())
    stopActivePlayback(options.id())
    resetState()
  })

  const isSupported = () => typeof window !== "undefined" && typeof window.Audio !== "undefined"

  const resolvedSettings = () => ({
    ...serverSettings().speech,
    ...(options.settingsOverride?.() ?? {}),
  })

  const canUseSpeech = () => {
    const capabilities = speechCapabilities()
    if (!isSupported() || !capabilities?.available || !capabilities?.configured || !capabilities?.supportsTts) {
      return false
    }
    if (resolvedSettings().playbackMode === "streaming") {
      return Boolean(capabilities.supportsStreamingTts)
    }
    return true
  }

  const stop = () => {
    if (activePlayback?.ownerId === options.id()) {
      activePlayback = null
    }
    resetState()
  }

  const start = async () => {
    const ownerId = options.id()
    const text = options.text().trim()
    if (!text || state() === "loading" || state() === "playing") return

    if (!isSupported()) {
      showAlertDialog(t("messageItem.actions.speak.error.unsupported"), {
        title: t("messageItem.actions.speak.error.title"),
        variant: "error",
      })
      return
    }

    const capabilities = (await loadSpeechCapabilities()) ?? speechCapabilities()
    if (!capabilities?.available || !capabilities?.configured || !capabilities?.supportsTts) {
      showAlertDialog(t("messageItem.actions.speak.error.unavailable"), {
        title: t("messageItem.actions.speak.error.title"),
        variant: "error",
      })
      return
    }

    requestVersion += 1
    const currentRequest = requestVersion
    stopActivePlayback()
    cleanupAudio()
    setState("loading")

    const settings = resolvedSettings()
    const format = settings.ttsFormat

    try {
      if (settings.playbackMode === "streaming") {
        await startStreamingPlayback(ownerId, currentRequest, text, format)
      } else {
        await startBufferedPlayback(ownerId, currentRequest, text, format)
      }
    } catch (error) {
      if (currentRequest !== requestVersion) {
        return
      }
      resetState()
      showAlertDialog(t("messageItem.actions.speak.error.generate"), {
        title: t("messageItem.actions.speak.error.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  async function startBufferedPlayback(
    ownerId: string,
    currentRequest: number,
    text: string,
    format: "mp3" | "wav" | "opus" | "aac",
  ) {
    const response = await serverApi.synthesizeSpeech({ text, format })

    if (currentRequest !== requestVersion) {
      return
    }

    const nextUrl = createObjectUrlFromBase64(response.audioBase64, response.mimeType)
    const nextAudio = new Audio(nextUrl)
    objectUrl = nextUrl
    audio = nextAudio

    attachPlaybackLifecycle(ownerId, nextAudio)
    setActivePlayback(ownerId, () => {
      cleanupAudio()
      setState("idle")
    })
    setState("playing")
    await nextAudio.play()
  }

  async function startStreamingPlayback(
    ownerId: string,
    currentRequest: number,
    text: string,
    format: "mp3" | "wav" | "opus" | "aac",
  ) {
    if (typeof MediaSource === "undefined") {
      throw new Error("MediaSource is not available in this browser.")
    }

    const controller = new AbortController()
    abortController = controller
    const response = await serverApi.synthesizeSpeechStream({ text, format }, controller.signal)
    const mimeType = response.headers.get("content-type") || formatToMimeType(format)

    if (!MediaSource.isTypeSupported(mimeType)) {
      throw new Error(`Streaming playback is not supported for ${mimeType}.`)
    }

    const stream = response.body
    if (!stream) {
      throw new Error("Speech stream did not include a response body.")
    }

    const nextMediaSource = new MediaSource()
    const nextObjectUrl = URL.createObjectURL(nextMediaSource)
    const nextAudio = new Audio(nextObjectUrl)
    mediaSource = nextMediaSource
    objectUrl = nextObjectUrl
    audio = nextAudio

    attachPlaybackLifecycle(ownerId, nextAudio)
    setActivePlayback(ownerId, () => {
      cleanupAudio()
      setState("idle")
    })

    await new Promise<void>((resolve, reject) => {
      const handleSourceOpen = () => {
        nextMediaSource.removeEventListener("sourceopen", handleSourceOpen)
        void streamToMediaSource({
          mediaSource: nextMediaSource,
          stream,
          mimeType,
          audioElement: nextAudio,
          onPlayable: async () => {
            if (currentRequest !== requestVersion) return
            if (state() !== "playing") {
              setState("playing")
            }
            try {
              await nextAudio.play()
            } catch (error) {
              reject(error)
            }
          },
          onComplete: resolve,
          onError: reject,
        })
      }

      nextMediaSource.addEventListener("sourceopen", handleSourceOpen, { once: true })
      nextAudio.addEventListener(
        "error",
        () => reject(new Error("Unable to play streamed speech.")),
        { once: true },
      )
    })
  }

  const toggle = async () => {
    if (state() === "idle") {
      await start()
      return
    }
    stop()
  }

  return {
    state,
    canUseSpeech,
    isLoading: () => state() === "loading",
    isPlaying: () => state() === "playing",
    toggle,
    stop,
    buttonTitle: () => {
      if (state() === "loading") return t("messageItem.actions.generatingSpeech")
      if (state() === "playing") return t("messageItem.actions.stopSpeech")
      return t("messageItem.actions.speak")
    },
  }
}

function attachPlaybackLifecycle(ownerId: string, audio: HTMLAudioElement) {
  const finish = () => {
    if (activePlayback?.ownerId === ownerId) {
      activePlayback = null
    }
    resetOwnerState(ownerId)
  }

  audio.addEventListener("ended", finish, { once: true })
  audio.addEventListener("error", finish, { once: true })
}

async function streamToMediaSource(options: {
  mediaSource: MediaSource
  stream: ReadableStream<Uint8Array>
  mimeType: string
  audioElement: HTMLAudioElement
  onPlayable: () => Promise<void>
  onComplete: () => void
  onError: (error: unknown) => void
}) {
  try {
    const sourceBuffer = options.mediaSource.addSourceBuffer(options.mimeType)
    const reader = options.stream.getReader()
    let startedPlayback = false
    let queue: Uint8Array[] = []
    let processing = false

    const flushQueue = async () => {
      if (processing || sourceBuffer.updating || queue.length === 0) return
      processing = true
      const chunk = queue.shift()!
      await appendChunk(sourceBuffer, chunk)
      if (!startedPlayback) {
        startedPlayback = true
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
    options.onComplete()
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
      reject(new Error("Failed to append audio stream chunk."))
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

function formatToMimeType(format: "mp3" | "wav" | "opus" | "aac"): string {
  if (format === "wav") return "audio/wav"
  if (format === "opus") return "audio/opus"
  if (format === "aac") return "audio/aac"
  return "audio/mpeg"
}
