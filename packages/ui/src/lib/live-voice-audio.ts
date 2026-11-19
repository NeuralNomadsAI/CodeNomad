import { LIVE_VOICE_PROVIDER_BYTES, liveVoiceInputRate, type LiveVoiceClientMessage, type LiveVoiceEngine, type LiveVoiceServerMessage } from "../../../server/src/speech/live-voice-contract"
import workletURL from "./live-voice-worklet.js?url&no-inline"
import { LIVE_VOICE_PLAYBACK_CAPACITY, LiveVoicePlayback, type TruncateMessage } from "./live-voice-playback"
import { getMicrophone, stopTracks } from "./microphone"
import { claimMicrophone, MicrophoneUnavailable } from "./microphone-lease"
import { usesWebKitMicrophone } from "./native/device-speech"
import { isDesktopHost, isRemoteWindow } from "./runtime-env"

type Ready = Extract<LiveVoiceServerMessage, { type: "ready" }>
type AudioMessage = Extract<LiveVoiceServerMessage, { type: "audio" }>
type Input = Extract<LiveVoiceClientMessage, { type: "audio" }>

/** Remote Linux Tauri webviews deliberately have no browser microphone. */
export function liveVoiceAudioUnavailable(): "secureContext" | "remoteWebKit" | "device" | undefined {
  if (typeof window === "undefined" || window !== window.top) return "device"
  if (!window.isSecureContext) return "secureContext"
  if (usesWebKitMicrophone() && isRemoteWindow()) return "remoteWebKit"
  if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function" || (!isDesktopHost() && !navigator.locks)) return "device"
}

async function loadAudioGraph(context: AudioContext, resume: Promise<void>, signal: AbortSignal) {
  let timeout: number | undefined
  let cancelled: (() => void) | undefined
  try {
    await Promise.race([
      Promise.all([context.audioWorklet.addModule(workletURL), resume]),
      new Promise<never>((_, reject) => {
        cancelled = () => reject(signal.reason)
        signal.addEventListener("abort", cancelled, { once: true })
        timeout = window.setTimeout(() => reject(new Error("Audio setup timed out")), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
    if (cancelled) signal.removeEventListener("abort", cancelled)
  }
}

/** Start from the user's gesture so playback and local WebKit can be authorized. */
export async function startLiveVoiceAudio(options: {
  signal: AbortSignal
  engine: LiveVoiceEngine
  outputRate: Ready["outputRate"]
  onInput: (audio: Input) => void
  onPlaybackChange: (playing: boolean) => void
  onError: (error: unknown) => void
}) {
  const { signal, engine, outputRate, onInput, onPlaybackChange, onError } = options
  const inputRate = liveVoiceInputRate(engine)
  const silence = engine === "openai-realtime" ? btoa("\0".repeat(inputRate * 2 / 50)) : undefined
  if (liveVoiceAudioUnavailable()) throw new MicrophoneUnavailable("unavailable")
  signal.throwIfAborted()
  const lifetime = new AbortController()
  const own = lifetime.signal
  const context = new AudioContext()
  let lease: Awaited<ReturnType<typeof claimMicrophone>> | undefined
  let mic: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let capture: AudioWorkletNode | undefined
  let output: AudioWorkletNode | undefined
  let inputMeter: AnalyserNode | undefined
  let outputMeter: AnalyserNode | undefined
  let permission: PermissionStatus | undefined
  let playback = new LiveVoicePlayback()
  let playing = false
  let muted = false
  const flushes: { playback: LiveVoicePlayback; settle: (frames: number) => void }[] = []
  let setupDone!: () => void
  const settingUp = new Promise<void>(resolve => { setupDone = resolve })
  let cleanup: Promise<void> | undefined

  const ended = () => fail(new DOMException("Microphone ended", "NotAllowedError"))
  const permissionChanged = () => { if (permission?.state === "denied") ended() }
  const processorError = () => fail(new Error("Audio processing failed"))
  const playbackChanged = () => {
    if (playing === playback.pending) return
    playing = playback.pending
    onPlaybackChange(playing)
  }

  const close = () => cleanup ??= (async () => {
    lifetime.abort()
    signal.removeEventListener("abort", stop)
    window.removeEventListener("pagehide", pageHidden)
    permission?.removeEventListener("change", permissionChanged)
    mic?.getAudioTracks().forEach(track => track.removeEventListener("ended", ended))
    stopTracks(mic ?? null)
    source?.disconnect()
    inputMeter?.disconnect()
    outputMeter?.disconnect()
    for (const node of [capture, output]) {
      if (!node) continue
      node.removeEventListener("processorerror", processorError)
      node.disconnect()
      node.port.close()
    }
    for (const flush of flushes.splice(0)) flush.settle(-1)
    void context.close().catch(() => {})
    // getUserMedia cannot be aborted. Keep the lease until a late stream
    // has been stopped rather than admitting a second permission request.
    await settingUp
    await lease?.release()
  })()
  const fail = (error: unknown) => {
    if (own.aborted) return
    void close()
    onError(error)
  }
  const stop = () => { void close() }
  const pageHidden = () => fail(new DOMException("Voice document closed", "AbortError"))
  signal.addEventListener("abort", stop, { once: true })
  window.addEventListener("pagehide", pageHidden, { once: true })

  try {
    const resume = context.resume()
    // Capture permission can outlast an aborted AudioContext.
    void resume.catch(() => {})
    lease = await claimMicrophone("conversation", own)
    own.throwIfAborted()
    const access = await window.electronAPI?.requestMicrophoneAccess?.()
    if (access?.granted === false) {
      throw new DOMException("Microphone permission denied", "NotAllowedError")
    }
    own.throwIfAborted()
    const stream = await getMicrophone(own, { channelCount: 1, echoCancellation: true }, "api", lease.id)
    if (own.aborted) {
      stopTracks(stream)
      own.throwIfAborted()
    }
    mic = stream
    const tracks = stream.getAudioTracks()
    if (!tracks.length || tracks.some(track => track.readyState !== "live")) {
      throw new DOMException("Microphone ended", "NotAllowedError")
    }
    tracks.forEach(track => track.addEventListener("ended", ended))
    await loadAudioGraph(context, resume, own)
    own.throwIfAborted()
    void navigator.permissions?.query({ name: "microphone" as PermissionName }).then(status => {
      if (own.aborted) return
      permission = status
      status.addEventListener("change", permissionChanged)
      permissionChanged()
    }).catch(() => {})

    const recorder = capture = new AudioWorkletNode(context, "codenomad-live-capture", {
      outputChannelCount: [1], processorOptions: { inputRate },
    })
    const player = output = new AudioWorkletNode(context, "codenomad-live-playback", {
      numberOfInputs: 0, outputChannelCount: [1],
      processorOptions: { outputRate, capacity: LIVE_VOICE_PLAYBACK_CAPACITY },
    })
    for (const node of [recorder, player]) node.addEventListener("processorerror", processorError)
    recorder.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | "overrun">) => {
      if (own.aborted) return
      if (data === "overrun") return fail(new Error("Capture overrun"))
      try {
        // 20 ms of PCM16 is at most 960 bytes, well below the websocket budget.
        // OpenAI's VAD still needs silence to finish the turn when muted.
        const pcm = muted ? silence : btoa(String.fromCharCode(...new Uint8Array(data)))
        if (pcm) onInput({ type: "audio", pcm })
        recorder.port.postMessage(null)
      } catch (error) { fail(error) }
    }
    player.port.onmessage = ({ data }: MessageEvent<{ rendered: number; flush?: true } | "overrun">) => {
      if (own.aborted) return
      if (data === "overrun") return fail(new Error("Playback overrun"))
      if (data.flush) flushes.shift()?.settle(data.rendered)
      else {
        (flushes[0]?.playback ?? playback).progress(data.rendered)
        playbackChanged()
      }
    }
    inputMeter = context.createAnalyser()
    outputMeter = context.createAnalyser()
    inputMeter.fftSize = outputMeter.fftSize = 512
    const samples = new Float32Array(inputMeter.fftSize)
    source = context.createMediaStreamSource(stream)
    source.connect(inputMeter).connect(recorder).connect(context.destination) // Capture emits silence.
    player.connect(outputMeter).connect(context.destination)

    return {
      setMuted(value: boolean) {
        if (own.aborted) return
        muted = value
        for (const track of tracks) track.enabled = !value
      },
      level(fromPlayback: boolean) {
        if (own.aborted || (!fromPlayback && muted)) return 0
        const meter = fromPlayback ? outputMeter! : inputMeter!
        meter.getFloatTimeDomainData(samples)
        let power = 0
        for (const sample of samples) power += sample * sample
        return Math.min(1, Math.sqrt(power / samples.length) * 4)
      },
      play(message: AudioMessage): "overflow" | void {
        if (own.aborted) return
        try {
          if (!message.pcm.length || message.pcm.length > LIVE_VOICE_PROVIDER_BYTES) throw new Error("Invalid PCM length")
          const pcm = Uint8Array.from(atob(message.pcm), character => character.charCodeAt(0)).buffer
          if (!pcm.byteLength || pcm.byteLength % 2 !== 0) throw new Error("Invalid PCM length")
          if (!playback.append(pcm.byteLength / 2, message)) return "overflow"
          player.port.postMessage(pcm, [pcm])
          playbackChanged()
        } catch (error) { fail(error) }
      },
      turnComplete() { playback.turnComplete() },
      interrupt(preserveEarlier = false): Promise<TruncateMessage[]> {
        if (own.aborted) return Promise.resolve([])
        if (flushes.length === 4) {
          fail(new Error("Audio interruption overrun"))
          return Promise.resolve([])
        }
        const old = playback
        const retained = preserveEarlier ? old.retainEarlierReplies() : undefined
        playback = retained?.playback ?? new LiveVoicePlayback()
        playbackChanged()
        return new Promise(resolve => {
          const timeout = window.setTimeout(() => fail(new Error("Audio interruption timed out")), 500)
          flushes.push({ playback: old, settle: rendered => {
            clearTimeout(timeout)
            if (rendered >= 0 && retained) {
              retained.playback.progress(Math.min(rendered, retained.keepThrough))
              playbackChanged()
            }
            resolve(rendered < 0 ? [] : old.interrupt(rendered, preserveEarlier))
          } })
          player.port.postMessage(retained ? { keepThrough: retained.keepThrough } : true)
        })
      },
      close,
    }
  } catch (error) {
    setupDone()
    await close()
    throw error
  } finally {
    setupDone()
  }
}
