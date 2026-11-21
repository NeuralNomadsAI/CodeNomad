import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { useI18n } from "../i18n"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import { useConfig, type SpeechSettings } from "../../stores/preferences"
import { getSpeechPlaybackSupport } from "../speech-playback-support"
import { playSpeech } from "../speech-playback"
import { captureBackendOperation } from "../backend-operation"

type SpeechPlaybackState = "idle" | "loading" | "playing"

interface UseSpeechOptions {
  id: Accessor<string>
  text: Accessor<string>
  settingsOverride?: Accessor<Partial<Pick<SpeechSettings, "playbackMode" | "ttsFormat">>>
}

// Content IDs may belong to multiple mounted views; the active hook owns playback.
let activePlayback: (() => void) | null = null

function stopActivePlayback() {
  if (!activePlayback) return
  const current = activePlayback
  activePlayback = null
  current()
}

export function useSpeech(options: UseSpeechOptions) {
  const { t } = useI18n()
  const { serverSettings } = useConfig()
  const [state, setState] = createSignal<SpeechPlaybackState>("idle")

  let playback: AbortController | undefined

  createEffect(() => {
    if (captureBackendOperation("").current()) void loadSpeechCapabilities()
  })

  const stop = () => {
    if (activePlayback === stop) activePlayback = null
    const controller = playback
    playback = undefined
    controller?.abort()
    setState("idle")
  }

  const ownerId = createMemo(options.id)
  onCleanup(stop)
  createEffect(() => {
    ownerId()
    onCleanup(stop)
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

  const start = async () => {
    const ownerId = options.id()
    const text = options.text().trim()
    if (!text || playback) return
    // Speech is served by the renderer's local backend, independently of the conversation.
    const controller = new AbortController()
    const operation = captureBackendOperation("", controller.signal, () => options.id() === ownerId)
    if (!operation.current()) return

    if (!isSupported()) {
      showAlertDialog(t("messageItem.actions.speak.error.unsupported"), {
        title: t("messageItem.actions.speak.error.title"),
        variant: "error",
      })
      return
    }

    stopActivePlayback()
    playback = controller
    activePlayback = stop
    setState("loading")
    const detached = () => { if (playback === controller) stop() }
    operation.signal.addEventListener("abort", detached, { once: true })
    try {
      const capabilities = (await loadSpeechCapabilities()) ?? speechCapabilities()
      if (!operation.current()) return
      const settings = resolvedSettings()
      const support = getSpeechPlaybackSupport({ ...settings, capabilities })
      const configured = capabilities?.available && capabilities.ttsConfigured && capabilities.supportsTts
      if (!configured || !support.available) {
        const detailKey = configured && (
          support.reason === "provider-streaming-unavailable" ? "settings.speech.compatibility.streamingUnavailable"
            : support.reason === "browser-streaming-unavailable" ? "settings.speech.compatibility.browserStreamingUnavailable"
              : "messageItem.actions.speak.error.unsupported"
        )
        showAlertDialog(t("messageItem.actions.speak.error.unavailable"), {
          title: t("messageItem.actions.speak.error.title"),
          detail: detailKey ? t(detailKey) : undefined,
          variant: "error",
        })
        return
      }
      await playSpeech(text, settings, operation.signal, () => setState("playing"))
    } catch (error) {
      if (!operation.current()) return
      showAlertDialog(t("messageItem.actions.speak.error.generate"), {
        title: t("messageItem.actions.speak.error.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      operation.signal.removeEventListener("abort", detached)
      if (playback === controller) stop()
    }
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
    buttonTitle: () => {
      if (state() === "loading") return t("messageItem.actions.generatingSpeech")
      if (state() === "playing") return t("messageItem.actions.stopSpeech")
      return t("messageItem.actions.speak")
    },
  }
}
