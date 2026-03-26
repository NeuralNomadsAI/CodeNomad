import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"

type SpeechPlaybackState = "idle" | "loading" | "playing"

interface UseSpeechOptions {
  id: Accessor<string>
  text: Accessor<string>
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
  const [state, setState] = createSignal<SpeechPlaybackState>("idle")

  let requestVersion = 0
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  const cleanupAudio = () => {
    if (audio) {
      audio.pause()
      audio.currentTime = 0
      audio.src = ""
      audio.load()
      audio = null
    }

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

  const canUseSpeech = () => {
    const capabilities = speechCapabilities()
    return Boolean(isSupported() && capabilities?.available && capabilities?.configured && capabilities?.supportsTts)
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

    try {
      const response = await serverApi.synthesizeSpeech({
        text,
        format: "mp3",
      })

      if (currentRequest !== requestVersion) {
        return
      }

      const nextUrl = createObjectUrlFromBase64(response.audioBase64, response.mimeType)
      const nextAudio = new Audio(nextUrl)
      objectUrl = nextUrl
      audio = nextAudio

      const finish = () => {
        if (activePlayback?.ownerId === ownerId) {
          activePlayback = null
        }
        resetOwnerState(ownerId)
      }

      nextAudio.addEventListener("ended", finish, { once: true })
      nextAudio.addEventListener("error", finish, { once: true })

      setActivePlayback(ownerId, () => {
        cleanupAudio()
        setState("idle")
      })

      setState("playing")
      await nextAudio.play()
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

function createObjectUrlFromBase64(audioBase64: string, mimeType: string): string {
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || "audio/mpeg" }))
}
