import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import type { PromptInputApi } from "../../../src/components/prompt-input/types"
import AlertDialog from "../../../src/components/alert-dialog"
import { SpeechSettingsSection } from "../../../src/components/settings/speech-settings-section"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance, setActiveInstanceId, updateInstance } from "../../../src/stores/instances"
import { ConfigProvider } from "../../../src/stores/preferences"
import { addToHistory } from "../../../src/stores/message-history"
import { activeSettingsSection, adoptSettingsRowHint, closeSettings, settingsOpen } from "../../../src/stores/settings-screen"
import { setVoiceConversationEngine, voiceConversationEngineLoaded } from "../../../src/stores/voice-conversation-engine"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const needsPcm = new URL(location.href).searchParams.get("pcm") === "1"
const showAlerts = new URL(location.href).searchParams.has("alerts")
const capture = { tracksStopped: 0, starts: 0, samples: 0, permit: null as null | (() => void), deferPermission: false, frames: [] as HTMLIFrameElement[],
  chunk: (_bytes: number) => {},
  requests: [] as Array<{ signal: AbortSignal; input: { mimeType: string; audioBase64: string }; resolve: (text: string) => void }> }
Object.assign(window, { capture })
navigator.mediaDevices.getUserMedia = async () => {
  if (capture.deferPermission) await new Promise<void>(resolve => { capture.permit = resolve })
  if (needsPcm) {
    const context = new AudioContext()
    const source = context.createOscillator()
    const output = context.createMediaStreamDestination()
    source.connect(output)
    source.start()
    await context.resume()
    for (const track of output.stream.getAudioTracks()) {
      const stop = track.stop.bind(track)
      track.stop = () => {
        if (track.readyState === "ended") return
        capture.tracksStopped++
        stop()
        void context.close()
      }
    }
    capture.starts++
    return output.stream
  }
  return { getTracks: () => [{ stop: () => capture.tracksStopped++ }], getAudioTracks: () => [] } as unknown as MediaStream
}
if (needsPcm) {
  const addModule = Worklet.prototype.addModule
  Worklet.prototype.addModule = function (url, options) {
    return addModule.call(this, new URL(`/src/renderer/public${new URL(String(url)).pathname}`, location.href), options)
  }
  window.AudioWorkletNode = class extends AudioWorkletNode {
    constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
      super(...args)
      this.port.addEventListener("message", event => { capture.samples += event.data?.length ?? 0 })
    }
  }
}
if (window.__CODENOMAD_RUNTIME_HOST__ === "tauri") {
  const append = document.body.append.bind(document.body)
  document.body.append = (...nodes) => {
    append(...nodes)
    for (const node of nodes) {
      if (node instanceof HTMLIFrameElement && node.hidden && !node.src) {
        capture.frames.push(node)
        node.contentWindow!.navigator.mediaDevices.getUserMedia = navigator.mediaDevices.getUserMedia
      }
    }
  }
}
window.MediaRecorder = class extends EventTarget {
  static isTypeSupported = (type: string) => !needsPcm && type === "audio/mp4"
  mimeType = "audio/mp4"
  state = "inactive"
  start() {
    this.state = "recording"
    capture.starts++
    capture.chunk = bytes => {
      if (this.state === "recording") {
        this.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) }))
      }
    }
  }
  stop() {
    this.state = "inactive"
    queueMicrotask(() => {
      this.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob(["audio"], { type: "audio/mp4" }) }))
      this.dispatchEvent(new Event("stop"))
    })
  }
} as unknown as typeof MediaRecorder
const fetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  if (!String(input).endsWith("/api/speech/transcribe")) return fetch(input, init)
  return new Promise<Response>(resolve => {
    capture.requests.push({ signal: init!.signal!, input: JSON.parse(String(init!.body)),
      // Deliberately resolve even after abort to exercise the stale result fence.
      resolve: text => resolve(Response.json({ text })) })
  })
}

const instanceId = "dictation"
const folder = new URL(location.href).searchParams.get("wsl") === "1" ? "/mnt/d/fixture" : "/fixture"
addInstance({
  id: instanceId, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client: null,
})
setActiveInstanceId(instanceId)
const [open, setOpen] = createSignal(true)
const [session, setSession] = createSignal("ses_a")
const [nativeSettings, setNativeSettings] = createSignal(false)
const sends: string[] = []
const resentPayloads: Parameters<PromptInputApi["restoreQueuedPrompt"]>[1][] = []
let composer: PromptInputApi | undefined
let holdNextSend = false
let releaseSend: (() => void) | undefined
const locale = new URL(location.href).searchParams.get("locale")
await applyUiSettings({ locale: locale === "he" || locale === "zh-Hans" ? locale : "en", showPromptVoiceInput: true })
if (new URLSearchParams(location.search).has("history")) await addToHistory(folder, "Previously sent")
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Show when={showAlerts}><AlertDialog /></Show>
  <button id="elsewhere" type="button">Other control</button>
  <Show when={open()}>
    <PromptInput instanceId={instanceId} instanceFolder={folder} sessionId={session()} isActive
      registerPromptInputApi={api => { composer = api }}
      onSend={async (prompt, _attachments, _delivery, restored) => {
        sends.push(prompt)
        if (restored) resentPayloads.push(restored)
        if (holdNextSend) await new Promise<void>(resolve => { releaseSend = resolve })
      }} />
  </Show>
  <Show when={nativeSettings() || (settingsOpen() && activeSettingsSection() === "speech")}>
    <SpeechSettingsSection />
  </Show>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
Object.assign(window, { fixture: {
  sends, setOpen, setSession, closeSettings, setVoiceConversationEngine, voiceConversationEngineLoaded,
  resentPayloads,
  restoreQueuedPrompt: (text: string, payload: Parameters<PromptInputApi["restoreQueuedPrompt"]>[1]) => composer!.restoreQueuedPrompt(text, payload),
  holdSend: () => { holdNextSend = true },
  sendHeld: () => Boolean(releaseSend),
  releaseSend: () => { releaseSend?.(); releaseSend = undefined },
  setNativeSettings(open: boolean) {
    if (open) adoptSettingsRowHint("speech")
    setNativeSettings(open)
  },
  retarget: () => updateInstance(instanceId, { proxyPath: "/workspace/other" }),
} })
