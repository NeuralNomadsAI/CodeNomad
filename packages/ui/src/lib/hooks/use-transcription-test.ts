import { createSignal, onCleanup } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { speechCapabilities } from "../../stores/speech"
import { serverApi } from "../api-client"
import { useI18n } from "../i18n"
import { isElectronHost } from "../runtime-env"
import { blobToBase64, createMediaRecorder, stopTracks } from "../audio-utils"

type TranscriptionTestState = "idle" | "requesting" | "recording" | "transcribing"

export function useTranscriptionTest() {
  const { t } = useI18n()
  const [state, setState] = createSignal<TranscriptionTestState>("idle")
  const [result, setResult] = createSignal<string | null>(null)

  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let recordedChunks: Blob[] = []
  let requestGeneration = 0
  let disposed = false

  const isSupported = () => {
    if (typeof window === "undefined") return false
    return typeof window.MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)
  }

  const canUseTranscription = () => {
    const capabilities = speechCapabilities()
    return Boolean(isSupported() && capabilities?.available && capabilities?.sttConfigured && capabilities?.supportsStt)
  }

  const releaseStream = () => {
    stopTracks(mediaStream)
    mediaStream = null
  }

  const releaseAll = () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop()
    }
    mediaRecorder = null
    releaseStream()
    recordedChunks = []
  }

  onCleanup(() => {
    disposed = true
    requestGeneration += 1
    releaseAll()
  })

  const startRecording = async () => {
    if (!isSupported()) {
      showAlertDialog(t("promptInput.voiceInput.error.unsupported"), {
        title: t("promptInput.voiceInput.error.title"),
        variant: "error",
      })
      return
    }

    const generation = ++requestGeneration
    setState("requesting")
    setResult(null)

    try {
      if (isElectronHost()) {
        const granted = await (window as Window & { electronAPI?: ElectronAPI }).electronAPI?.requestMicrophoneAccess?.()
        if (granted && !granted.granted) {
          throw new Error(t("promptInput.voiceInput.error.permissionDenied"))
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      if (generation !== requestGeneration || disposed) {
        stopTracks(stream)
        return
      }

      recordedChunks = []
      mediaStream = stream
      const recorder = createMediaRecorder(stream)
      mediaRecorder = recorder

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0 && generation === requestGeneration) {
          recordedChunks.push(event.data)
        }
      })

      recorder.addEventListener("error", () => {
        if (generation !== requestGeneration) return
        releaseAll()
        setState("idle")
      })

      recorder.addEventListener("stop", () => {
        if (generation === requestGeneration) {
          void finalizeRecording(generation)
        }
      })

      setState("recording")
      recorder.start()
    } catch (error) {
      if (generation !== requestGeneration) return
      releaseAll()
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
    releaseStream()
    setState("transcribing")
  }

  const finalizeRecording = async (generation: number) => {
    const chunks = recordedChunks
    recordedChunks = []
    const recorder = mediaRecorder
    mediaRecorder = null

    if (generation !== requestGeneration || chunks.length === 0) {
      if (generation === requestGeneration) setState("idle")
      return
    }

    const mimeType = recorder?.mimeType || chunks[0]?.type || "audio/webm"

    try {
      const audioBlob = new Blob(chunks, { type: mimeType })
      const transcription = await serverApi.transcribeAudio({
        audioBase64: await blobToBase64(audioBlob),
        mimeType,
      })
      if (generation === requestGeneration) {
        setResult(transcription.text.trim() || t("settings.speech.testInput.empty"))
      }
    } catch (error) {
      if (generation === requestGeneration) {
        showAlertDialog(t("promptInput.voiceInput.error.transcribe"), {
          title: t("promptInput.voiceInput.error.title"),
          detail: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    } finally {
      if (generation === requestGeneration) {
        setState("idle")
      }
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

  return {
    state,
    result,
    canUseTranscription,
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    toggle,
    buttonTitle: () => {
      if (state() === "requesting") return t("settings.speech.testInput.requesting")
      if (state() === "recording") return t("settings.speech.testInput.stop")
      if (state() === "transcribing") return t("settings.speech.testInput.transcribing")
      return t("settings.speech.testInput.action")
    },
  }
}
