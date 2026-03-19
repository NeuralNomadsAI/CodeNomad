import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { serverApi, type SpeechRealtimeEvent } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import { createRealtimePcmStream, type RealtimePcmStreamHandle } from "./createRealtimePcmStream"
import { appendVoiceTranscript, buildPromptWithInsertedTranscript, createPromptVoiceAnchor } from "./promptVoiceInsertion"

interface UsePromptRealtimeVoiceInputOptions {
  prompt: Accessor<string>
  setPrompt: (value: string, options?: { persistDraft?: boolean }) => void
  getTextarea: () => HTMLTextAreaElement | null
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
}

type RealtimeVoiceState = "idle" | "connecting" | "listening" | "finalizing"

const FINAL_TRANSCRIPT_TIMEOUT_MS = 10000

export function usePromptRealtimeVoiceInput(options: UsePromptRealtimeVoiceInputOptions) {
  const { t } = useI18n()
  const [state, setState] = createSignal<RealtimeVoiceState>("idle")
  const [elapsedMs, setElapsedMs] = createSignal(0)

  let activeSessionId: string | null = null
  let eventSource: EventSource | null = null
  let pcmStream: RealtimePcmStreamHandle | null = null
  let audioQueue: Promise<void> = Promise.resolve()
  let timerId: number | undefined
  let recordingStartedAt = 0
  let finalizeTimerId: number | undefined
  let anchor = createPromptVoiceAnchor("", 0, 0)
  let finalTranscript = ""
  let liveTranscript = ""
  let activeLiveItemId: string | null = null
  let closing = false

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  onCleanup(() => {
    cancelRecording()
  })

  const isSupported = () => {
    if (typeof window === "undefined") return false
    return Boolean(window.AudioContext || (window as any).webkitAudioContext) && Boolean(navigator.mediaDevices?.getUserMedia) && typeof EventSource !== "undefined"
  }

  const canUseVoiceInput = () => {
    const capabilities = speechCapabilities()
    return Boolean(
      options.enabled() &&
        isSupported() &&
        capabilities?.available &&
        capabilities?.configured &&
        capabilities?.supportsStt &&
        capabilities?.supportsRealtimeTranscription,
    )
  }

  async function toggleRecording(): Promise<void> {
    if (state() === "listening" || state() === "connecting") {
      await stopRecording()
      return
    }

    if (!canUseVoiceInput() || options.disabled() || state() === "finalizing") return

    try {
      await startRecording()
    } catch (error) {
      await cleanupSession({ revertPrompt: true, closeRemote: true })
      showAlertDialog(t("promptInput.voiceInput.error.connection"), {
        title: t("promptInput.voiceInput.error.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  async function startRecording() {
    if (!isSupported()) {
      showAlertDialog(t("promptInput.voiceInput.error.unsupported"), {
        title: t("promptInput.voiceInput.error.title"),
        variant: "error",
      })
      return
    }

    resetTranscriptState()
    captureAnchor()
    setState("connecting")
    setElapsedMs(0)

    const created = await serverApi.createRealtimeSpeechSession({
      language: detectLanguage(),
    })
    activeSessionId = created.sessionId
    connectEventStream(created.sessionId)

    pcmStream = await createRealtimePcmStream({
      onChunk: (audioBase64) => {
        const sessionId = activeSessionId
        if (!sessionId || closing) return
        audioQueue = audioQueue
          .then(() => serverApi.appendRealtimeSpeechAudio(sessionId, { audioBase64 }))
          .catch((error) => {
            handleRealtimeError(error)
          })
      },
    })

    recordingStartedAt = Date.now()
    startTimer()
    setState("listening")
  }

  async function stopRecording() {
    const sessionId = activeSessionId
    if (!sessionId || (state() !== "listening" && state() !== "connecting")) return

    setState("finalizing")
    stopTimer()

    if (pcmStream) {
      const stream = pcmStream
      pcmStream = null
      await stream.stop()
    }

    try {
      await audioQueue.catch(() => undefined)
      await serverApi.finalizeRealtimeSpeechSession(sessionId)
      scheduleFinalizeClose(FINAL_TRANSCRIPT_TIMEOUT_MS)
    } catch (error) {
      handleRealtimeError(error)
    }
  }

  function cancelRecording() {
    void cleanupSession({ revertPrompt: true, closeRemote: true })
  }

  function connectEventStream(sessionId: string) {
    eventSource?.close()
    eventSource = serverApi.connectRealtimeSpeechEvents(
      sessionId,
      (event) => handleEvent(event),
      () => {
        if (closing) return
        handleRealtimeError(new Error(t("promptInput.voiceInput.error.connection")))
      },
    )
  }

  function handleEvent(event: SpeechRealtimeEvent) {
    if (event.type === "session.ready") {
      return
    }

    if (event.type === "session.error") {
      handleRealtimeError(new Error(event.message))
      return
    }

    if (event.type === "transcript.partial") {
      activeLiveItemId = event.itemId
      liveTranscript = event.text
      renderPrompt(false)
      return
    }

    if (event.type === "transcript.final") {
      activeLiveItemId = activeLiveItemId === event.itemId ? null : activeLiveItemId
      liveTranscript = ""
      finalTranscript = appendVoiceTranscript(finalTranscript, event.text)
      renderPrompt(true)
      if (state() === "finalizing") {
        scheduleFinalizeClose(250)
      }
      return
    }

    if (event.type === "session.closed") {
      void cleanupSession({ revertPrompt: false, closeRemote: false })
    }
  }

  function captureAnchor() {
    const textarea = options.getTextarea()
    const current = options.prompt()
    const start = textarea ? textarea.selectionStart : current.length
    const end = textarea ? textarea.selectionEnd : current.length
    anchor = createPromptVoiceAnchor(current, start, end)
  }

  function renderPrompt(persistDraft: boolean) {
    const inserted = [finalTranscript, liveTranscript.trim()].filter(Boolean).join(finalTranscript && liveTranscript.trim() ? " " : "")
    const { value, cursor } = buildPromptWithInsertedTranscript(anchor, inserted)
    options.setPrompt(value, persistDraft ? undefined : { persistDraft: false })
    syncTextareaCursor(cursor)
  }

  function syncTextareaCursor(cursor: number) {
    const textarea = options.getTextarea()
    if (!textarea) return
    queueMicrotask(() => {
      const next = options.getTextarea()
      if (!next) return
      next.focus()
      next.setSelectionRange(cursor, cursor)
    })
  }

  function scheduleFinalizeClose(delayMs: number) {
    if (finalizeTimerId !== undefined) {
      window.clearTimeout(finalizeTimerId)
    }
    finalizeTimerId = window.setTimeout(() => {
      void cleanupSession({ revertPrompt: false, closeRemote: true })
    }, delayMs)
  }

  async function cleanupSession(cleanupOptions: { revertPrompt: boolean; closeRemote: boolean }) {
    if (closing) return
    closing = true

    if (finalizeTimerId !== undefined) {
      window.clearTimeout(finalizeTimerId)
      finalizeTimerId = undefined
    }

    stopTimer()

    const sessionId = activeSessionId
    activeSessionId = null

    eventSource?.close()
    eventSource = null

    if (pcmStream) {
      const stream = pcmStream
      pcmStream = null
      await stream.stop().catch(() => undefined)
    }

    await audioQueue.catch(() => undefined)
    audioQueue = Promise.resolve()

    if (cleanupOptions.closeRemote && sessionId) {
      await serverApi.closeRealtimeSpeechSession(sessionId).catch(() => undefined)
    }

    if (!cleanupOptions.revertPrompt && !finalTranscript.trim() && liveTranscript.trim()) {
      finalTranscript = appendVoiceTranscript(finalTranscript, liveTranscript)
      liveTranscript = ""
    }

    if (cleanupOptions.revertPrompt) {
      options.setPrompt(anchor.prompt)
    } else if (finalTranscript.trim()) {
      renderPrompt(true)
    }

    resetTranscriptState()
    setState("idle")
    setElapsedMs(0)
    closing = false
  }

  function resetTranscriptState() {
    finalTranscript = ""
    liveTranscript = ""
    activeLiveItemId = null
  }

  function handleRealtimeError(error: unknown) {
    if (closing) return
    void cleanupSession({ revertPrompt: true, closeRemote: true })
    showAlertDialog(t("promptInput.voiceInput.error.connection"), {
      title: t("promptInput.voiceInput.error.title"),
      detail: error instanceof Error ? error.message : String(error),
      variant: "error",
    })
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
    toggleRecording,
    cancelRecording,
    isRecording: () => state() === "connecting" || state() === "listening",
    isTranscribing: () => state() === "finalizing",
    buttonTitle: () => {
      if (state() === "connecting") return t("promptInput.voiceInput.connecting.title")
      if (state() === "listening") return t("promptInput.voiceInput.stop.title")
      if (state() === "finalizing") return t("promptInput.voiceInput.transcribing.title")
      return t("promptInput.voiceInput.start.title")
    },
  }
}

function detectLanguage(): string | undefined {
  if (typeof navigator === "undefined") return undefined
  const [language] = navigator.language.split("-")
  return language?.trim() || undefined
}
