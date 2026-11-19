import { liveVoiceAudioUnavailable, startLiveVoiceAudio } from "../../../src/lib/live-voice-audio"
import { claimMicrophone } from "../../../src/lib/microphone-lease"

const abort = new AbortController()
const info = { input: [] as string[], rendered: 0, playing: false, requested: false, requests: 0,
  stopped: false, started: false, rejected: false, error: "" }
let lateStream: (() => void) | undefined
const getUserMedia = async () => {
  info.requested = true
  info.requests++
  const context = new AudioContext({ sampleRate: 44_100 })
  const oscillator = context.createOscillator()
  const sink = context.createMediaStreamDestination()
  oscillator.connect(sink)
  oscillator.start()
  await context.resume()
  const track = sink.stream.getAudioTracks()[0]
  const stop = track.stop.bind(track)
  track.stop = () => {
    stop()
    info.stopped = true
    void context.close()
  }
  if (location.search === "?late") await new Promise<void>(resolve => { lateStream = resolve })
  return sink.stream
}
Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia })
if (window.__CODENOMAD_WINDOW_CONTEXT__ === "local" && window.__CODENOMAD_RUNTIME_HOST__ === "tauri") {
  const append = document.body.append.bind(document.body)
  document.body.append = (...nodes) => {
    append(...nodes)
    for (const node of nodes) if (node instanceof HTMLIFrameElement && node.hidden) {
      Object.defineProperty(node.contentWindow!.navigator.mediaDevices, "getUserMedia", { value: getUserMedia })
    }
  }
}

window.AudioWorkletNode = class extends AudioWorkletNode {
  constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
    super(...args)
    if (args[1] === "codenomad-live-playback") {
      this.port.addEventListener("message", ({ data }) => { info.rendered = data.rendered })
    }
  }
}

let audio: Awaited<ReturnType<typeof startLiveVoiceAudio>>
const button = document.body.appendChild(document.createElement("button"))
button.textContent = "Start"
button.onclick = () => {
  void startLiveVoiceAudio({
    signal: abort.signal, engine: location.search === "?openai" ? "openai-realtime" : "gemini-live", outputRate: 24_000,
    onInput: message => info.input.push(message.pcm), onError: error => { info.error = String(error) },
    onPlaybackChange: value => { info.playing = value },
  }).then(result => {
    audio = result
    info.started = true
  }, () => { info.rejected = true })
}
Object.assign(window, {
  fixture: {
    info,
    stop: () => abort.abort(),
    allowStream: () => lateStream?.(),
    unavailable: liveVoiceAudioUnavailable,
    mute: (value: boolean) => audio.setMuted(value),
    level: (playback: boolean) => audio.level(playback),
    async busy() {
      try {
        const lease = await claimMicrophone("test", new AbortController().signal)
        await lease.release()
        return false
      } catch { return true }
    },
    play(itemId = "first") {
      const pcm = btoa("\x00\x20".repeat(12_000))
      audio.play({ type: "audio", pcm, itemId, contentIndex: 0 })
    },
    interrupt: () => audio.interrupt(),
  },
})
