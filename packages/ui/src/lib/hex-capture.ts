import { getMicrophone, stopTracks } from "./microphone"

const TARGET_RATE = 16_000

export function hexCaptureAvailable(): boolean {
  return typeof window !== "undefined" && typeof AudioWorkletNode !== "undefined" &&
    typeof AudioContext !== "undefined" && typeof OfflineAudioContext !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
}

export function pcmWav(samples: Float32Array): ArrayBuffer {
  const wav = new ArrayBuffer(44 + 2 * samples.length)
  const view = new DataView(wav)
  view.setUint32(0, 0x52494646) // RIFF
  view.setUint32(4, wav.byteLength - 8, true)
  view.setUint32(8, 0x57415645) // WAVE
  view.setUint32(12, 0x666d7420) // fmt
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_RATE, true)
  view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(36, 0x64617461) // data
  view.setUint32(40, wav.byteLength - 44, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample * (sample < 0 ? 32768 : 32767), true)
  }
  return wav
}

export async function startPcmCapture(
  signal: AbortSignal, ended: () => void, engine: "api" | "hex", maxSeconds: number, limit: () => void,
  leaseId?: string,
) {
  const stream = await getMicrophone(signal, { channelCount: 1 }, engine, leaseId)
  let context: AudioContext | undefined
  let node: AudioWorkletNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let timer: number | undefined
  let stopped = false
  let micStopped = false
  let atLimit = false
  let flushed: (() => void) | undefined
  let permission: PermissionStatus | undefined
  let onTrackEnded = ended
  const trackEnded = () => onTrackEnded()
  const permissionChanged = () => { if (permission?.state === "denied") ended() }
  const stopMic = () => {
    if (micStopped) return
    micStopped = true
    permission?.removeEventListener("change", permissionChanged)
    for (const track of stream.getAudioTracks()) track.removeEventListener("ended", trackEnded)
    stopTracks(stream)
  }
  const release = () => {
    stopMic()
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    signal.removeEventListener("abort", release)
    source?.disconnect()
    node?.disconnect()
    node?.port.close()
    flushed?.()
    void context?.close().catch(() => {})
  }
  signal.addEventListener("abort", release, { once: true })
  try {
    signal.throwIfAborted()
    for (const track of stream.getAudioTracks()) {
      if (track.readyState !== "live") throw new DOMException("Microphone ended", "NotAllowedError")
      track.addEventListener("ended", trackEnded)
    }
    const audio = context = new AudioContext()
    const max = Math.min(audio.sampleRate, 192_000) * maxSeconds
    const chunks: Float32Array[] = []
    let count = 0
    await audio.audioWorklet.addModule(new URL("/hex-pcm-processor.js", window.location.href))
    signal.throwIfAborted()
    source = audio.createMediaStreamSource(stream)
    const capture = node = new AudioWorkletNode(audio, "codenomad-hex-pcm")
    let draining: Promise<void> | undefined
    const drain = () => {
      stopMic()
      return draining ??= new Promise<void>(resolve => {
        const timeout = window.setTimeout(resolve, 100)
        flushed = () => { clearTimeout(timeout); resolve() }
        capture.port.postMessage(null)
      }).finally(release)
    }
    const onLimit = () => {
      if (atLimit || stopped || draining) return
      atLimit = true
      if (engine === "api") void drain() // Keep the bounded samples, not the capture graph.
      limit()
    }
    if (engine === "api") onTrackEnded = () => { if (count) onLimit(); else ended() }
    capture.port.onmessage = (event: MessageEvent<Float32Array | null>) => {
      if (event.data === null) { flushed?.(); return }
      const chunk = event.data.subarray(0, max - count)
      if (chunk.length) { chunks.push(chunk); count += chunk.length }
      if (count === max) onLimit()
    }
    source.connect(capture).connect(audio.destination) // The worklet writes only silence to the output.
    await audio.resume()
    signal.throwIfAborted()
    void navigator.permissions?.query({ name: "microphone" as PermissionName }).then(status => {
      if (micStopped || signal.aborted) return
      permission = status
      status.addEventListener("change", permissionChanged)
    }).catch(() => {})
    if (!atLimit) timer = window.setTimeout(onLimit, maxSeconds * 1000)
    return {
      async finish() {
        await drain()
        signal.throwIfAborted()
        if (!count) throw new Error("No PCM samples")
        const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(count * TARGET_RATE / audio.sampleRate)), TARGET_RATE)
        const input = offline.createBuffer(1, count, audio.sampleRate)
        const samples = input.getChannelData(0)
        let offset = 0
        for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
        chunks.length = 0
        const reader = offline.createBufferSource()
        reader.buffer = input
        reader.connect(offline.destination)
        reader.start()
        const resampled = await offline.startRendering()
        signal.throwIfAborted()
        return new Blob([pcmWav(resampled.getChannelData(0))], { type: "audio/wav" })
      },
      release,
    }
  } catch (error) { release(); throw error }
}
