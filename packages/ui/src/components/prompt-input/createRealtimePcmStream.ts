export interface RealtimePcmStreamHandle {
  stop(): Promise<void>
}

interface CreateRealtimePcmStreamOptions {
  onChunk: (audioBase64: string) => void | Promise<void>
}

const TARGET_SAMPLE_RATE = 24000
const PROCESSOR_BUFFER_SIZE = 4096

export async function createRealtimePcmStream(
  options: CreateRealtimePcmStreamOptions,
): Promise<RealtimePcmStreamHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error("AudioContext is not supported in this browser.")
  }

  const audioContext = new AudioContextCtor()
  await audioContext.resume()

  const source = audioContext.createMediaStreamSource(stream)
  const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1)
  const sink = audioContext.createGain()
  sink.gain.value = 0

  source.connect(processor)
  processor.connect(sink)
  sink.connect(audioContext.destination)

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const resampled = downsampleBuffer(input, audioContext.sampleRate, TARGET_SAMPLE_RATE)
    if (resampled.length === 0) return
    const pcm16 = floatTo16BitPcm(resampled)
    void options.onChunk(base64EncodePcm16(pcm16))
  }

  let stopped = false
  return {
    async stop() {
      if (stopped) return
      stopped = true
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      sink.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      await audioContext.close()
    },
  }
}

function downsampleBuffer(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return buffer.slice()
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate
  const outputLength = Math.max(1, Math.round(buffer.length / sampleRateRatio))
  const output = new Float32Array(outputLength)
  let outputIndex = 0
  let inputIndex = 0

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.min(buffer.length, Math.round((outputIndex + 1) * sampleRateRatio))
    let sum = 0
    let count = 0
    for (let i = inputIndex; i < nextInputIndex; i += 1) {
      sum += buffer[i]
      count += 1
    }
    output[outputIndex] = count > 0 ? sum / count : buffer[Math.min(buffer.length - 1, inputIndex)]
    outputIndex += 1
    inputIndex = nextInputIndex
  }

  return output
}

function floatTo16BitPcm(buffer: Float32Array): Int16Array {
  const pcm16 = new Int16Array(buffer.length)
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, buffer[i]))
    pcm16[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
  }
  return pcm16
}

function base64EncodePcm16(buffer: Int16Array): string {
  const bytes = new Uint8Array(buffer.buffer)
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
