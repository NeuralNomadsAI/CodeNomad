import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { isElectronHost } from "../../lib/runtime-env"
import { blobToBase64, createMediaRecorder, stopTracks } from "../../lib/audio-utils"
import { createRecordingController, type RecordingState } from "./recording-controller"

interface UsePromptVoiceInputOptions {
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
}

export function usePromptVoiceInput(options: UsePromptVoiceInputOptions) {
  const { t } = useI18n()
  const [state, setState] = createSignal<RecordingState>("idle")
  const [elapsedMs, setElapsedMs] = createSignal(0)

  const controller = createRecordingController(
    {
      isElectron: () => isElectronHost(),
      requestMicAccess: async () =>
        (window as Window & { electronAPI?: ElectronAPI }).electronAPI?.requestMicrophoneAccess?.(),
      getUserMedia: async () => navigator.mediaDevices.getUserMedia({ audio: true }),
      setupRecorder: (stream, handlers) => {
        const recorder = createMediaRecorder(stream as MediaStream)
        let stopped = false
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) handlers.onDataAvailable(event.data)
        })
        recorder.addEventListener("stop", () => handlers.onStop())
        return {
          start: () => recorder.start(),
          stop: () => {
            if (!stopped) {
              stopped = true
              if (recorder.state === "recording") {
                recorder.stop()
              }
            }
          },
          mimeType: recorder.mimeType,
        }
      },
      stopTracks: (stream) => stopTracks(stream as MediaStream | null),
      blobToBase64,
      transcribe: (input) => serverApi.transcribeAudio(input),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => {
        if (id !== undefined) window.clearInterval(id)
      },
    },
    {
      onStateChange: setState,
      onElapsedChange: setElapsedMs,
      onTranscript: (text) => insertTranscript(text),
      onError: (errorKey, detail) => {
        showAlertDialog(t(errorKey), {
          title: t("promptInput.voiceInput.error.title"),
          ...(detail ? { detail } : {}),
          variant: "error",
        })
      },
    },
  )

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  onCleanup(() => {
    controller.cleanup(false)
  })

  const isSupported = () => {
    if (typeof window === "undefined") return false
    return typeof window.MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)
  }

  const canUseVoiceInput = () => {
    const capabilities = speechCapabilities()
    return Boolean(
      options.enabled() &&
        isSupported() &&
        capabilities?.available &&
        capabilities?.sttConfigured &&
        capabilities?.supportsStt,
    )
  }

  async function startRecording() {
    if (!canUseVoiceInput() || options.disabled() || state() === "transcribing" || state() === "recording") return

    if (!isSupported()) {
      showAlertDialog(t("promptInput.voiceInput.error.unsupported"), {
        title: t("promptInput.voiceInput.error.title"),
        variant: "error",
      })
      return
    }

    await controller.startRecording()
  }

  function stopRecording() {
    controller.stopRecording()
  }

  async function toggleRecording(): Promise<void> {
    if (state() === "recording") {
      stopRecording()
      return
    }

    await startRecording()
  }

  function insertTranscript(text: string) {
    const current = options.prompt()
    const textarea = options.getTextarea()
    const start = textarea ? textarea.selectionStart : current.length
    const end = textarea ? textarea.selectionEnd : current.length
    const wasCursorAtEnd = end === current.length
    const wasScrolledToBottom = textarea
      ? textarea.scrollHeight - (textarea.scrollTop + textarea.clientHeight) <= 4
      : false
    const before = current.slice(0, start)
    const after = current.slice(end)
    const prefix = ""
    const suffix = after.length > 0 ? (/^\s/.test(after) ? "" : " ") : " "
    const nextValue = `${before}${prefix}${text}${suffix}${after}`
    const cursor = before.length + prefix.length + text.length + suffix.length

    options.setPrompt(nextValue)
    if (textarea) {
      setTimeout(() => {
        textarea.focus()
        textarea.setSelectionRange(cursor, cursor)
        if (wasCursorAtEnd || wasScrolledToBottom) {
          textarea.scrollTop = textarea.scrollHeight
        }
      }, 0)
    }
  }

  return {
    state,
    elapsedMs,
    canUseVoiceInput,
    startRecording,
    stopRecording,
    toggleRecording,
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    buttonTitle: () => {
      if (state() === "recording") return t("promptInput.voiceInput.stop.title")
      if (state() === "transcribing") return t("promptInput.voiceInput.transcribing.title")
      return t("promptInput.voiceInput.start.title")
    },
  }
}
