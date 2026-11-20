import { createHexRecordingController } from "../../../src/components/prompt-input/hex-recording-controller"
import type { requestDeviceSpeech } from "../../../src/lib/native/device-speech"
import { createMicrophoneLeases } from "../../../src/lib/microphone-lease"

const info = {
  state: "idle", operation: undefined as string | undefined,
  requests: [] as Array<{ action: string; wav?: string }>,
  stopped: 0, text: "", error: "", workletError: "", samples: 0,
}
const id = "00000000-0000-0000-0000-000000000001"
const send = (async (action, input) => {
  info.requests.push({ action, ...input })
  if (action === "start") { info.operation = "recording"; return { ok: true, value: { id } } }
  if (action === "status") {
    return { ok: true, value: { state: info.operation, ...(info.operation === "transcribed" ? { text: "Bonjour." } : {}) } }
  }
  if (action === "finish") { info.operation = "transcribed"; return { ok: true, value: null } }
  if (action === "cancel") { info.operation = "cancelled"; return { ok: true, value: null } }
  throw new Error("Unexpected action")
}) as typeof requestDeviceSpeech

const getUserMedia = {
  value: async () => {
    const context = new AudioContext()
    const source = context.createOscillator()
    const audio = context.createMediaStreamDestination()
    source.connect(audio)
    source.start()
    await context.resume()
    for (const track of audio.stream.getTracks()) {
      const stop = track.stop.bind(track)
      track.stop = () => {
        if (track.readyState === "ended") return
        info.stopped++
        stop()
        source.stop()
        void context.close()
      }
    }
    return audio.stream
  },
}
Object.defineProperty(navigator.mediaDevices, "getUserMedia", getUserMedia)
if (window.__CODENOMAD_RUNTIME_HOST__ === "tauri") {
  const append = document.body.append.bind(document.body)
  document.body.append = (...nodes) => {
    append(...nodes)
    for (const node of nodes) {
      if (node instanceof HTMLIFrameElement && node.hidden && !node.src) {
        Object.defineProperty(node.contentWindow!.navigator.mediaDevices, "getUserMedia", getUserMedia)
      }
    }
  }
}
window.AudioWorkletNode = class extends AudioWorkletNode {
  constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
    super(...args)
    this.port.addEventListener("message", event => { info.samples += event.data?.length ?? 0 })
  }
}
const addModule = Worklet.prototype.addModule
Worklet.prototype.addModule = async function (url, options) {
  // The fixture daemon uses the checkout root rather than the packaged UI's public root.
  const fixtureUrl = new URL(`/src/renderer/public${new URL(String(url)).pathname}`, location.href)
  try { await addModule.call(this, fixtureUrl, options) }
  catch (error) { info.workletError = String(error); throw error }
}

const capture = createHexRecordingController("fr-FR", {
  onStateChange: (state) => { info.state = state },
  onTranscript: (text) => { info.text = text },
  onError: (error) => { info.error = error },
}, send, createMicrophoneLeases(async () => () => {}))

for (const [label, handler] of [
  ["Start", () => { void capture.startRecording() }],
  ["Finish", capture.stopRecording],
  ["Cancel", capture.cancelRecording],
] as const) {
  const button = document.createElement("button")
  button.textContent = label
  button.onclick = handler
  document.body.append(button)
}
Object.assign(window, { fixture: info })
