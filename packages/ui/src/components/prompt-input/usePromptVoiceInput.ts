import { createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { showAlertDialog } from "../../stores/alerts"
import { loadSpeechCapabilities, speechCapabilities, speechCapabilitiesError } from "../../stores/speech"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"
import { promptTranscript, setPromptTranscript } from "../../stores/prompt-transcripts"
import { useI18n } from "../../lib/i18n"
import { microphoneUse } from "../../lib/microphone-lease"
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
  active: Accessor<boolean>
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
  sending: Accessor<boolean>
  canInsertTranscript: Accessor<boolean>
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
  const transcript = () => {
    if (!options.active()) return
    const saved = promptTranscript(options.instanceId(), options.sessionId())
    if (saved?.directory === options.directory() && saved.owner()) return saved.text
  }
  const discardTranscript = () => setPromptTranscript(options.instanceId(), options.sessionId(), undefined)
  type ActiveCapture = { controller?: VoiceInputController; current: () => boolean; selectionChanged: () => void; restoreFocus?: boolean }
  const [activeCapture, setActiveCapture] = createSignal<ActiveCapture>()
  let composing = false

  const deviceDictation = useDeviceDictation(locale, options.enabled)
  const remoteDictation = useRemoteDictation(locale, options.enabled)
  const route = remoteDictation?.route ?? deviceDictation?.route
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

  createEffect(() => {
    if (options.enabled()) void loadSpeechCapabilities()
  })
  createEffect(() => {
    const capture = activeCapture()
    if (capture && !capture.current()) cancelRecording()
  })

  const stopWatching = onInstanceLifecycleAuthority(event => {
    if (event.instanceId === options.instanceId()) cancelRecording()
  })
  onMount(() => window.addEventListener("pagehide", cancelRecording))
  onCleanup(() => {
    stopWatching()
    window.removeEventListener("pagehide", cancelRecording)
    cancelRecording()
  })

  function unavailableKey() {
    if (!options.enabled()) return "voice.command.off"
    if (state() === "starting") return "settings.speech.testInput.requesting"
    if (state() === "transcribing") return "promptInput.voiceInput.transcribing.title"
    if (state() === "limitReached") return "promptInput.voiceInput.limitReached"
    if (transcript()) return "voice.command.pendingTranscription"
    if (options.disabled() || options.sending()) return "voice.command.composerUnavailable"
    if (deviceDictation?.readFailed() || remoteDictation?.readFailed()) return "settings.speech.device.readFailed"
    const purpose = microphoneUse()
    if (purpose) return `voice.microphone.${purpose}`
    if (engine()?.canStart()) return
    if (deviceDictation?.choice() === null || remoteDictation?.choice() === null) return "settings.speech.device.chooseLocal"
    if (engine() === apiEngine && !apiCaptureAvailable()) {
      if (typeof window !== "undefined" && !window.isSecureContext) return "voice.command.secureContext"
      return "voice.microphone.unavailable"
    }
    if (remoteDictation && !remoteDictation.choice()) return "promptInput.remoteDictation.unavailable"
    if (engine() === apiEngine && !speechCapabilities()) {
      return speechCapabilitiesError() ? "voice.command.capabilitiesError" : "voice.command.loading"
    }
    return "voice.command.setupDictation"
  }
  const canStartRecording = () => state() === "idle" && !unavailableKey()

  async function startRecording() {
    if (!canStartRecording() || activeCapture() || composing) return
    const textarea = options.getTextarea()
    if (!textarea?.isConnected || textarea.value !== options.prompt()) return

    const owner = options.captureOwner()
    const instanceId = options.instanceId(), sessionId = options.sessionId(), directory = options.directory()
    const selectedEngine = engine()
    if (!selectedEngine) return
    const revision = options.draftRevision(), range = selection(textarea)
    const contextCurrent = () => owner() && instanceId === options.instanceId() && sessionId === options.sessionId()
      && directory === options.directory() && options.active() && textarea === options.getTextarea() && textarea.isConnected
    const current = () => contextCurrent() && options.enabled() && selectedEngine === engine()
      && (state() === "transcribing" || (!options.disabled() && (state() === "limitReached" || !options.sending())))
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
        if (!options.canInsertTranscript() || options.disabled() || options.sending() || composing || moved
          || revision !== options.draftRevision() || !sameSelection(textarea, range) || textarea.value !== options.prompt()) {
          setPromptTranscript(instanceId, sessionId, { text, directory, owner })
          return
        }
        insertTranscript(textarea, text, range.selectionStart, range.selectionEnd)
        if (capture.restoreFocus && textarea.ownerDocument.activeElement === textarea.ownerDocument.body) {
          textarea.focus({ preventScroll: true })
        }
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
    if (!options.canInsertTranscript() || !saved || !textarea || composing || textarea.value !== options.prompt()) return
    const end = textarea.selectionEnd
    const prefix = /\S$/.test(textarea.value.slice(0, end)) ? " " : ""
    discardTranscript()
    insertTranscript(textarea, `${prefix}${saved}`, end, end)
    textarea.focus({ preventScroll: true })
  }

  return {
    state,
    unavailableKey,
    canStartRecording,
    startRecording,
    usesRemoteCapture: () => remoteDictation?.choice() === "hex",
    stopRecording: () => activeCapture()?.controller?.stopRecording(),
    confirmTranscription: (restoreFocus: boolean) => {
      const capture = activeCapture()
      if (!capture?.current()) return
      capture.restoreFocus = restoreFocus
      capture.controller?.confirmTranscription?.()
    },
    cancelRecording,
    selectionChanged: () => activeCapture()?.selectionChanged(),
    setComposing: (value: boolean) => { composing = value },
    savedTranscript: transcript,
    restoreTranscript,
    discardTranscript,
    isRecording: () => state() === "recording",
    isTranscribing: () => state() === "transcribing",
    buttonTitle: () => {
      if (state() === "recording") return t("promptInput.voiceInput.stop.title")
      return t("promptInput.voiceInput.dictate")
    },
  }
}
