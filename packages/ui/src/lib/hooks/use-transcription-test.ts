import { createSignal, onCleanup } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { speechCapabilities } from "../../stores/speech"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { isElectronHost } from "../runtime-env"
import { blobToBase64, createMediaRecorder, stopTracks } from "../audio-utils"

type TranscriptionTestState = "idle" | "recording" | "transcribing"

export function useTranscriptionTest() {
  const { t } = useI18n()
  const [state, setState] = createSignal<TranscriptionTestState>("idle")
  const [result, setResult] = createSignal<string | null>(null)

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let recordedChunks: Blob[] = []
  let shouldFinalize = true

  const isSupported = () => {
    if (typeof window === "undefined") return false
    return typeof window.MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)
  }

  const canUseTranscription = () => {
    const capabilities = speechCapabilities()
    return Boolean(isSupported() && capabilities?.available && capabilities?.sttConfigured && capabilities?.supportsStt)
  }

  const cleanup = () => {
    shouldFinalize = false
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop()
    }
    mediaRecorder = null
    stopTracks(mediaStream)
    mediaStream = null
    recordedChunks = []
  }

  onCleanup(() => {
    cleanup()
  })

  const startRecording = async () => {
    if (!isSupported()) {
      showAlertDialog(t("promptInput.voiceInput.error.unsupported"), {
        title: t("promptInput.voiceInput.error.title"),
        variant: "error",
      })
      return
    }

    try {
      if (isElectronHost()) {
        const granted = await (window as Window & { electronAPI?: ElectronAPI }).electronAPI?.requestMicrophoneAccess?.()
        if (granted && !granted.granted) {
          throw new Error(t("promptInput.voiceInput.error.permissionDenied"))
        }
      }

      recordedChunks = []
      shouldFinalize = true
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder = createMediaRecorder(mediaStream)

      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          recordedChunks.push(event.data)
        }
      })

      mediaRecorder.addEventListener("stop", () => {
        void finalizeRecording()
      })

      setState("recording")
      setResult(null)
      mediaRecorder.start()
    } catch (error) {
      cleanup()
      setState("idle")
      showAlertDialog(t("promptInput.voiceInput.error.permission"), {
        title: t("promptInput.voiceInput.error.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  const stopRecording = () => {
    if (!mediaRecorder || state() !== "recording") return
    mediaRecorder.stop()
    setState("transcribing")
  }

  const finalizeRecording = async () => {
    const recorder = mediaRecorder
    const stream = mediaStream
    mediaRecorder = null
    mediaStream = null

    if (!shouldFinalize || recordedChunks.length === 0) {
      recordedChunks = []
      stopTracks(stream)
      setState("idle")
      return
    }

    const mimeType = recorder?.mimeType || recordedChunks[0]?.type || "audio/webm"

    try {
      const audioBlob = new Blob(recordedChunks, { type: mimeType })
      const transcription = await serverApi.transcribeAudio({
        audioBase64: await blobToBase64(audioBlob),
        mimeType,
      })
      setResult(transcription.text.trim() || t("settings.speech.testInput.empty"))
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
    }
  }

  const toggle = async () => {
    if (state() === "recording") {
      stopRecording()
      return
    }
    if (state() === "idle") {
      await startRecording()
    }
  }

  const reset = () => {
    cleanup()
    setState("idle")
    setResult(null)
  }

  return {
    state,
    result,
    canUseTranscription,
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    toggle,
    reset,
    buttonTitle: () => {
      if (state() === "recording") return t("settings.speech.testInput.stop")
      if (state() === "transcribing") return t("settings.speech.testInput.transcribing")
      return t("settings.speech.testInput.action")
    },
  }
}
