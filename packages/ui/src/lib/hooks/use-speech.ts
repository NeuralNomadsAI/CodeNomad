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
  let disposed = false

  createEffect(() => {
    if (captureBackendOperation("").current()) void loadSpeechCapabilities()
  })

  const stop = (cancel = true) => {
    if (activePlayback === stop) activePlayback = null
    const controller = playback
    playback = undefined
    if (cancel) controller?.abort()
    setState("idle")
  }

  const ownerId = createMemo(options.id)
  onCleanup(() => { disposed = true; stop() })
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
    if (disposed || playback) return
    const ownerId = options.id()
    const text = options.text().trim()
    if (!text) return
    // Speech is served by the renderer's local backend, independently of the conversation.
    const controller = new AbortController()
    const operation = captureBackendOperation("", undefined, () => options.id() === ownerId)
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
    const detached = () => { if (playback === controller) stop() }
    operation.signal.addEventListener("abort", detached, { once: true, signal: controller.signal })
    setState("loading")
    try {
      const capabilities = (await loadSpeechCapabilities()) ?? speechCapabilities()
      if (controller.signal.aborted || !operation.current()) return
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
      await playSpeech(text, settings, controller.signal, () => setState("playing"))
    } catch (error) {
      if (controller.signal.aborted || !operation.current()) return
      const message = t("messageItem.actions.speak.error.generate")
      const detail = error instanceof Error ? error.message : String(error)
      showAlertDialog(message, {
        title: t("messageItem.actions.speak.error.title"),
        detail: detail !== message ? detail : undefined,
        variant: "error",
      })
    } finally {
      operation.signal.removeEventListener("abort", detached)
      // Playback has settled; a status check triggered by an HTTP 401 still owns its result.
      if (playback === controller) stop(false)
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
