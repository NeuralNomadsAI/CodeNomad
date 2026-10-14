export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function createMediaRecorder(stream: MediaStream): MediaRecorder {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
  const supported = candidates.find(
    (candidate) => typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(candidate),
  )
  return supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream)
}

export function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

export function createObjectUrlFromBase64(audioBase64: string, mimeType: string): string {
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || "audio/mpeg" }))
}

export async function streamToMediaSource(options: {
  mediaSource: MediaSource
  stream: ReadableStream<Uint8Array>
  mimeType: string
  onPlayable: () => Promise<void>
  onComplete?: () => void
  onError: (error: unknown) => void
  appendErrorMessage: () => string
}) {
  try {
    const sourceBuffer = options.mediaSource.addSourceBuffer(options.mimeType)
    const reader = options.stream.getReader()
    const queue: Uint8Array[] = []
    let processing = false
    let startedPlayback = false

    const flushQueue = async () => {
      if (processing || sourceBuffer.updating || queue.length === 0) return
      processing = true
      const chunk = queue.shift()!
      await appendChunk(sourceBuffer, chunk, options.appendErrorMessage)
      if (!startedPlayback) {
        startedPlayback = true
        await options.onPlayable()
      }
      processing = false
      await flushQueue()
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        queue.push(value)
        await flushQueue()
      }
    }

    while (queue.length > 0 || sourceBuffer.updating) {
      if (queue.length > 0) {
        await flushQueue()
      } else {
        await waitForUpdateEnd(sourceBuffer)
      }
    }

    if (options.mediaSource.readyState === "open") {
      options.mediaSource.endOfStream()
    }
    options.onComplete?.()
  } catch (error) {
    options.onError(error)
  }
}

function appendChunk(sourceBuffer: SourceBuffer, chunk: Uint8Array, errorMessage: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleUpdateEnd = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error(errorMessage()))
    }
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", handleUpdateEnd)
      sourceBuffer.removeEventListener("error", handleError)
    }

    sourceBuffer.addEventListener("updateend", handleUpdateEnd, { once: true })
    sourceBuffer.addEventListener("error", handleError, { once: true })
    sourceBuffer.appendBuffer(new Uint8Array(chunk).buffer)
  })
}

function waitForUpdateEnd(sourceBuffer: SourceBuffer): Promise<void> {
  return new Promise((resolve) => {
    sourceBuffer.addEventListener("updateend", () => resolve(), { once: true })
  })
}
