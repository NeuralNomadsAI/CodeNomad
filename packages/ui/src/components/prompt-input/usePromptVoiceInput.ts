import { createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { useI18n } from "../../lib/i18n"
import { apiCaptureAvailable, createApiRecordingController } from "./api-recording-controller"
import { type RecordingState, type VoiceInputController, type VoiceInputEngine } from "./recording-controller"
import { useRemoteDictation } from "./useRemoteDictation"
import { useDeviceDictation } from "./useDeviceDictation"

interface UsePromptVoiceInputOptions {
  prompt: Accessor<string>
  draftRevision: Accessor<number>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  directory: Accessor<string>
  captureOwner: () => () => boolean
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
  engine?: (api: VoiceInputEngine) => VoiceInputEngine | undefined
}

type TextSelection = Pick<HTMLTextAreaElement, "selectionStart" | "selectionEnd" | "selectionDirection">
const selection = ({ selectionStart, selectionEnd, selectionDirection }: HTMLTextAreaElement): TextSelection =>
  ({ selectionStart, selectionEnd, selectionDirection })
const sameSelection = (field: HTMLTextAreaElement, captured: TextSelection) =>
  field.selectionStart === captured.selectionStart && field.selectionEnd === captured.selectionEnd
  && field.selectionDirection === captured.selectionDirection

export function usePromptVoiceInput(options: UsePromptVoiceInputOptions) {
  const { t, locale } = useI18n()
  const [state, setState] = createSignal<RecordingState>("idle")
  const [transcript, setTranscript] = createSignal<{ text: string; current: () => boolean }>()
  type ActiveCapture = { controller?: VoiceInputController; current: () => boolean; selectionChanged: () => void }
  const [activeCapture, setActiveCapture] = createSignal<ActiveCapture>()
  let composing = false

  const deviceDictation = useDeviceDictation(locale, options.enabled)
  const remoteDictation = useRemoteDictation(locale, options.enabled)
  const route = remoteDictation?.route ?? options.engine ?? deviceDictation?.route
  const authorizeApi = remoteDictation?.authorizeApi ?? deviceDictation?.authorizeApi
  const apiEngine: VoiceInputEngine = {
    canStart: () => {
      const capabilities = speechCapabilities()
      return apiCaptureAvailable() && Boolean(capabilities?.available && capabilities.sttConfigured && capabilities.supportsStt)
    },
    createController: callbacks => createApiRecordingController(callbacks, "dictation", authorizeApi),
  }
  const engine = () => route ? route(apiEngine) : apiEngine

  function cancelRecording() {
    const capture = activeCapture()
    if (!capture) return
    setActiveCapture(undefined)
    capture.controller?.cancelRecording()
    setState("idle")
  }

  function retire() {
    cancelRecording()
    setTranscript(undefined)
  }

  createEffect(() => {
    if (options.enabled()) void loadSpeechCapabilities()
  })
  createEffect(() => {
    const capture = activeCapture()
    if (capture && !capture.current()) cancelRecording()
    const saved = transcript()
    if (saved && !saved.current()) setTranscript(undefined)
  })

  const stopWatching = onInstanceLifecycleAuthority(event => {
    if (event.instanceId === options.instanceId()) retire()
  })
  onMount(() => window.addEventListener("pagehide", retire))
  onCleanup(() => {
    stopWatching()
    window.removeEventListener("pagehide", retire)
    retire()
  })

  const canUseVoiceInput = () => options.enabled() && Boolean(engine()?.canStart())
  const canStartRecording = () => canUseVoiceInput() && !options.disabled() && state() === "idle"

  async function startRecording() {
    if (!canStartRecording() || activeCapture() || composing) return
    const textarea = options.getTextarea()
    if (!textarea?.isConnected || textarea.value !== options.prompt()) return

    const owner = options.captureOwner()
    const instanceId = options.instanceId(), sessionId = options.sessionId(), directory = options.directory()
    const selectedEngine = engine()
    if (!selectedEngine) return
    const revision = options.draftRevision(), range = selection(textarea)
    const current = () => owner() && instanceId === options.instanceId() && sessionId === options.sessionId()
      && directory === options.directory() && options.enabled() && !options.disabled()
      && selectedEngine === engine() && textarea === options.getTextarea() && textarea.isConnected
    if (!current()) return
    let moved = false
    let delivered = false
    const capture: ActiveCapture = { current, selectionChanged: () => { moved ||= !sameSelection(textarea, range) } }
    const held = () => activeCapture() === capture && current()
    capture.controller = selectedEngine.createController({
      onStateChange: value => {
        if (activeCapture() !== capture) return
        if (value === "idle") setActiveCapture(undefined)
        setState(value)
      },
      onTranscript: text => {
        if (!held() || delivered || !text) return
        delivered = true
        if (composing || moved || revision !== options.draftRevision() || !sameSelection(textarea, range) || textarea.value !== options.prompt()) {
          setTranscript({ text, current })
          return
        }
        insertTranscript(textarea, text, range.selectionStart, range.selectionEnd)
      },
      onError: (errorKey, detail) => {
        if (!held()) return
        showAlertDialog(t(errorKey), { title: t("promptInput.voiceInput.error.title"), detail, variant: "error" })
      },
    })
    setActiveCapture(capture)
    await capture.controller.startRecording()
  }

  function insertTranscript(textarea: HTMLTextAreaElement, text: string, start: number, end: number) {
    const suffix = /^\s/.test(textarea.value.slice(end)) ? "" : " "
    // Change the range and caret in the same turn without acquiring focus or scheduling a later write.
    textarea.setRangeText(`${text}${suffix}`, start, end, "end")
    options.setPrompt(textarea.value)
  }

  function restoreTranscript() {
    const saved = transcript()
    const textarea = options.getTextarea()
    if (!saved?.current() || !textarea || composing || textarea.value !== options.prompt()) return
    const end = textarea.selectionEnd
    const prefix = /\S$/.test(textarea.value.slice(0, end)) ? " " : ""
    setTranscript(undefined)
    insertTranscript(textarea, `${prefix}${saved.text}`, end, end)
  }

  return {
    state,
    canUseVoiceInput,
    canOpenVoiceSettings: () => options.enabled() && !options.disabled() && state() === "idle" && !canUseVoiceInput(),
    deviceDictation,
    canStartRecording,
    startRecording,
    stopRecording: () => activeCapture()?.controller?.stopRecording(),
    confirmTranscription: () => {
      const capture = activeCapture()
      if (capture?.current()) capture.controller?.confirmTranscription?.()
    },
    cancelRecording,
    selectionChanged: () => activeCapture()?.selectionChanged(),
    setComposing: (value: boolean) => { composing = value },
    savedTranscript: () => { const saved = transcript(); return saved?.current() ? saved.text : undefined },
    restoreTranscript,
    discardTranscript: () => setTranscript(undefined),
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    buttonTitle: () => {
      if (state() === "recording") return t("promptInput.voiceInput.stop.title")
      if (state() === "transcribing") return t("promptInput.voiceInput.transcribing.title")
      return t("promptInput.voiceInput.dictate")
    },
  }
}
