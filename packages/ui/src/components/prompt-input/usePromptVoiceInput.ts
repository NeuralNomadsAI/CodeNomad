import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"

interface UsePromptVoiceInputOptions {
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
}

type VoiceInputState = "idle" | "recording" | "transcribing"

export function usePromptVoiceInput(options: UsePromptVoiceInputOptions) {
  const { t } = useI18n()
  const [state, setState] = createSignal<VoiceInputState>("idle")
  const [elapsedMs, setElapsedMs] = createSignal(0)

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let timerId: number | undefined
  let shouldTranscribe = true
  let recordedChunks: Blob[] = []
  let recordingStartedAt = 0

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  onCleanup(() => {
    cleanupMedia(false)
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
        capabilities?.configured &&
        capabilities?.supportsStt,
    )
  }

  async function toggleRecording(): Promise<void> {
    if (state() === "recording") {
      stopRecording()
      return
    }

    await startRecording()
  }

  function stopRecording() {
    if (!mediaRecorder || state() !== "recording") return
    shouldTranscribe = true
    mediaRecorder.stop()
    setState("transcribing")
    stopTimer()
  }

  function cancelRecording() {
    if (!mediaRecorder || state() !== "recording") return
    shouldTranscribe = false
    mediaRecorder.stop()
    cleanupMedia(false)
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

    try {
      recordedChunks = []
      shouldTranscribe = true
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder = createRecorder(mediaStream)

      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          recordedChunks.push(event.data)
        }
      })

      mediaRecorder.addEventListener("stop", () => {
        void finalizeRecording()
      })

      recordingStartedAt = Date.now()
      setElapsedMs(0)
      setState("recording")
      startTimer()
      mediaRecorder.start()
    } catch (error) {
      cleanupMedia(false)
      showAlertDialog(t("promptInput.voiceInput.error.permission"), {
        title: t("promptInput.voiceInput.error.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  async function finalizeRecording() {
    const recorder = mediaRecorder
    const stream = mediaStream
    mediaRecorder = null
    mediaStream = null

    if (!shouldTranscribe || recordedChunks.length === 0) {
      recordedChunks = []
      stopTracks(stream)
      setState("idle")
      setElapsedMs(0)
      return
    }

    const mimeType = recorder?.mimeType || recordedChunks[0]?.type || "audio/webm"

    try {
      const audioBlob = new Blob(recordedChunks, { type: mimeType })
      const transcription = await serverApi.transcribeAudio({
        audioBase64: await blobToBase64(audioBlob),
        mimeType,
      })
      if (transcription.text.trim()) {
        insertTranscript(transcription.text.trim())
      }
    } catch (error) {
      showAlertDialog(t("promptInput.voiceInput.error.transcribe"), {
        title: t("promptInput.voiceInput.error.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      recordedChunks = []
      stopTracks(stream)
      setState("idle")
      setElapsedMs(0)
    }
  }

  function insertTranscript(text: string) {
    const current = options.prompt()
    const textarea = options.getTextarea()
    const start = textarea ? textarea.selectionStart : current.length
    const end = textarea ? textarea.selectionEnd : current.length
    const before = current.slice(0, start)
    const after = current.slice(end)
    const prefix = before.length > 0 && !/\s$/.test(before) ? " " : ""
    const suffix = after.length > 0 && !/^\s/.test(after) ? " " : ""
    const nextValue = `${before}${prefix}${text}${suffix}${after}`
    const cursor = before.length + prefix.length + text.length

    options.setPrompt(nextValue)
    if (textarea) {
      setTimeout(() => {
        textarea.focus()
        textarea.setSelectionRange(cursor, cursor)
      }, 0)
    }
  }

  function cleanupMedia(resetState = true) {
    stopTimer()
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop()
    }
    mediaRecorder = null
    stopTracks(mediaStream)
    mediaStream = null
    recordedChunks = []
    if (resetState) {
      setState("idle")
      setElapsedMs(0)
    }
  }

  function startTimer() {
    stopTimer()
    timerId = window.setInterval(() => {
      setElapsedMs(Date.now() - recordingStartedAt)
    }, 250)
  }

  function stopTimer() {
    if (timerId !== undefined) {
      window.clearInterval(timerId)
      timerId = undefined
    }
  }

  return {
    state,
    elapsedMs,
    canUseVoiceInput,
    startRecording,
    stopRecording,
    toggleRecording,
    cancelRecording,
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    buttonTitle: () => {
      if (state() === "recording") return t("promptInput.voiceInput.stop.title")
      if (state() === "transcribing") return t("promptInput.voiceInput.transcribing.title")
      return t("promptInput.voiceInput.start.title")
    },
  }
}

function createRecorder(stream: MediaStream): MediaRecorder {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
  const supported = candidates.find((candidate) => typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(candidate))
  return supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream)
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
