import { createSignal, onCleanup, onMount } from "solid-js"
import { apiCaptureAvailable, createApiRecordingController } from "../../components/prompt-input/api-recording-controller"
import type { RecordingState } from "../../components/prompt-input/recording-controller"
import { showAlertDialog } from "../../stores/alerts"
import { speechCapabilities } from "../../stores/speech"
import { useI18n } from "../i18n"

export function useTranscriptionTest(beforeStateChange: (next: RecordingState) => void) {
  const { t } = useI18n()
  const [state, setState] = createSignal<RecordingState>("idle")
  const [result, setResult] = createSignal<string | null>(null)

  const capture = createApiRecordingController({
    onStateChange: next => {
      beforeStateChange(next)
      setState(next)
    },
    onTranscript: text => setResult(text || t("settings.speech.testInput.empty")),
    onError: (key, detail) => showAlertDialog(t(key), {
      title: t("promptInput.voiceInput.error.title"), detail, variant: "error",
    }),
  }, "test")
  onMount(() => window.addEventListener("pagehide", capture.cancelRecording))
  onCleanup(() => {
    window.removeEventListener("pagehide", capture.cancelRecording)
    capture.cancelRecording()
  })

  return {
    state,
    result,
    canUseTranscription: () => {
      const capabilities = speechCapabilities()
      return apiCaptureAvailable() && Boolean(capabilities?.available && capabilities.sttConfigured && capabilities.supportsStt)
    },
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    confirmTranscription: capture.confirmTranscription,
    cancelRecording: capture.cancelRecording,
    async toggle() {
      if (state() === "recording") capture.stopRecording()
      else if (state() === "idle") {
        setResult(null)
        await capture.startRecording()
      }
    },
    buttonTitle: () => {
      if (state() === "starting") return t("settings.speech.testInput.requesting")
      if (state() === "recording") return t("settings.speech.testInput.stop")
      if (state() === "transcribing") return t("settings.speech.testInput.transcribing")
      return t("settings.speech.testInput.action")
    },
  }
}
