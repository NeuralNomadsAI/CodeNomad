import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { isSpeechLocale } from "../../../desktop-speech/contract"
import { tGlobal as t } from "../lib/i18n"
import { requestDeviceSpeech, type DeviceSpeechSnapshot } from "../lib/native/device-speech"
import { settleRemoteDictation } from "../lib/native/remote-dictation"
import type { SettleRemoteDictation } from "../../../desktop-speech/remote-contract"
import { createHexRecordingController } from "./prompt-input/hex-recording-controller"
import type { RecordingState, VoiceInputController } from "./prompt-input/recording-controller"
import { canUseHexDictation } from "./prompt-input/useDeviceDictation"

function readDestination(url: URL): string | undefined {
  try {
    const origin = new URL(new URLSearchParams(url.hash.slice(1)).get("dictationDestination") ?? "")
    if (origin.protocol === "http:" || origin.protocol === "https:") return origin.origin
  } catch { /* Nothing to disclose without a registered destination. */ }
}

export function RemoteDictationWindow() {
  const url = new URL(window.location.href)
  const requestedLocale = url.searchParams.get("dictationLocale")
  const destination = readDestination(url)
  const [snapshot, setSnapshot] = createSignal<DeviceSpeechSnapshot>()
  const [loaded, setLoaded] = createSignal(false)
  const [state, setState] = createSignal<RecordingState>("idle")
  const [transcript, setTranscript] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [settling, setSettling] = createSignal(false)
  let captureButton: HTMLButtonElement | undefined
  let insertButton: HTMLButtonElement | undefined
  let controller: VoiceInputController | undefined
  let disposed = false

  const canCapture = () => Boolean(destination && isSpeechLocale(requestedLocale) && canUseHexDictation(snapshot()))
  const captureBusy = () => state() === "starting" || state() === "transcribing"

  function stop() {
    const capture = controller
    controller = undefined
    capture?.cancelRecording()
  }

  onMount(() => {
    void requestDeviceSpeech("read", {}).then(result => {
      if (disposed) return
      if (result.ok) setSnapshot(result.value)
      setLoaded(true)
    })
    window.addEventListener("pagehide", stop)
  })
  onCleanup(() => {
    disposed = true
    window.removeEventListener("pagehide", stop)
    stop()
  })

  async function settle(request: SettleRemoteDictation) {
    if (settling()) return
    setSettling(true)
    stop()
    try {
      await settleRemoteDictation(request)
    } catch {
      if (disposed) return
      setError("promptInput.remoteDictation.error")
      setState("idle")
      setSettling(false)
    }
  }

  function mainAction(event: MouseEvent) {
    if (!event.isTrusted || !document.hasFocus() || settling()) return
    if (state() === "recording") { controller?.stopRecording(); return }
    if (!canCapture() || !requestedLocale || state() !== "idle" || controller) return
    setError(undefined)
    const capture = createHexRecordingController(requestedLocale, {
      onStateChange(value) {
        if (controller !== capture) return
        if (value === "idle") controller = undefined
        setState(value)
      },
      onTranscript(text) {
        if (controller !== capture) return
        const source = captureButton
        const transferFocus = document.activeElement === source && document.hasFocus()
        setTranscript(text)
        if (transferFocus && !source?.isConnected && document.activeElement === document.body) {
          insertButton?.focus({ preventScroll: true })
        }
      },
      onError(key) { if (controller === capture) setError(key) },
    })
    controller = capture
    void capture.startRecording()
  }

  return (
    <main class="window-shell flex h-full flex-col bg-surface-overlay" aria-labelledby="dictation-title"
      onKeyDown={event => { if (event.key === "Escape" && event.isTrusted) void settle({ action: "cancel" }) }}>
      <header class="window-header">
        <h1 id="dictation-title" class="window-title">{t("promptInput.remoteDictation.title")}</h1>
        <Show when={destination}><bdi id="dictation-destination" class="min-w-0 break-all">{destination}</bdi></Show>
      </header>
      <div class="window-body bg-surface-canvas">
        <Show when={error()}><p role="alert">{t(error()!)}</p></Show>
        <Show when={!error() && loaded() && !canCapture()}>
          <p role="status">{t(snapshot()?.engine === null ? "settings.speech.device.chooseLocal" : "promptInput.remoteDictation.unavailable")}</p>
        </Show>
        <Show when={state() === "transcribing"}>
          <p role="status">{t("promptInput.voiceInput.transcribing.title")}</p>
        </Show>
        <Show when={transcript()}><p role="status" class="whitespace-pre-wrap break-words">{transcript()}</p></Show>
      </div>
      <footer class="window-footer flex-wrap">
        <button type="button" class="button-secondary" disabled={settling()}
          onClick={event => { if (event.isTrusted) void settle({ action: "cancel" }) }}>
          {t("alertDialog.actions.cancel")}
        </button>
        <Show when={loaded() && (!canCapture() || error())}>
          <button type="button" class="button-secondary" disabled={settling()}
            onClick={event => { if (event.isTrusted) void settle({ action: "settings" }) }}>
            {t("settings.nav.voice")}
          </button>
        </Show>
        <Show when={transcript()} fallback={<Show when={canCapture()}>
          <button ref={captureButton} type="button" class="button-primary" disabled={settling()}
            aria-disabled={captureBusy()} onClick={mainAction}>
            {t(state() === "recording"
              ? "promptInput.voiceInput.stop.title" : "promptInput.voiceInput.start.title")}
          </button>
        </Show>}>
          <button ref={insertButton} type="button" class="button-primary" disabled={!destination || settling()}
            aria-describedby="dictation-destination"
            onKeyDown={event => {
              // Holding Enter to stop must not confirm the preview when it arrives.
              if (event.key === "Enter" && event.repeat) event.preventDefault()
            }}
            onClick={event => {
              if (event.isTrusted && document.hasFocus() && destination) void settle({ action: "complete", text: transcript() })
            }}>
            {t("promptInput.voiceInput.recovery.insert")}
          </button>
        </Show>
      </footer>
    </main>
  )
}
