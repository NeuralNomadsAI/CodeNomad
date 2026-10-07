import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import { useConfig, type SpeechSettings } from "../../stores/preferences"
import { formatToMimeType, getSpeechPlaybackSupport } from "../speech-playback-support"
import { createObjectUrlFromBase64, streamToMediaSource } from "../audio-utils"

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
    if (!isSupported() || !capabilities?.available || !capabilities?.ttsConfigured || !capabilities?.supportsTts) {
      return false
    }
    return getSpeechPlaybackSupport({
      playbackMode: resolvedSettings().playbackMode,
      ttsFormat: resolvedSettings().ttsFormat,
      capabilities,
    }).available
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
    if (!capabilities?.available || !capabilities?.ttsConfigured || !capabilities?.supportsTts) {
      showAlertDialog(t("messageItem.actions.speak.error.unavailable"), {
        title: t("messageItem.actions.speak.error.title"),
        variant: "error",
      })
      return
    }

    const support = getSpeechPlaybackSupport({
      playbackMode: resolvedSettings().playbackMode,
      ttsFormat: resolvedSettings().ttsFormat,
      capabilities,
    })
    if (!support.available) {
      const detailKey =
        support.reason === "provider-streaming-unavailable"
          ? "settings.speech.compatibility.streamingUnavailable"
          : support.reason === "browser-streaming-unavailable"
            ? "settings.speech.compatibility.browserStreamingUnavailable"
            : "messageItem.actions.speak.error.unsupported"

      showAlertDialog(t("messageItem.actions.speak.error.unavailable"), {
        title: t("messageItem.actions.speak.error.title"),
        detail: t(detailKey),
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
          appendErrorMessage: () => "Failed to append audio stream chunk.",
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
