export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function supportedRecordingType() {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(
    candidate => typeof MediaRecorder !== "undefined" &&
      (typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(candidate)),
  )
}

export function createMediaRecorder(stream: MediaStream): MediaRecorder {
  const supported = supportedRecordingType()
  return new MediaRecorder(stream, { audioBitsPerSecond: 128_000, ...(supported ? { mimeType: supported } : {}) })
}

export async function streamToMediaSource(
  media: MediaSource, stream: ReadableStream<Uint8Array>, mime: string,
  signal: AbortSignal, play: () => void, error: () => Error,
) {
  if (signal.aborted) throw signal.reason
  const source = media.addSourceBuffer(mime)
  const reader = stream.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    let started = false
    while (true) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw signal.reason
      if (done) break
      if (!value.byteLength) continue
      await appendChunk(source, value, signal, error)
      if (!started) {
        started = true
        play()
      }
    }
    if (media.readyState === "open") media.endOfStream()
  } finally {
    signal.removeEventListener("abort", cancel)
    if (!signal.aborted) cancel()
    reader.releaseLock()
  }
}

function appendChunk(source: SourceBuffer, chunk: Uint8Array, signal: AbortSignal, error: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) throw signal.reason
    const listeners = new AbortController()
    const once = { once: true, signal: listeners.signal }
    const fail = (cause: unknown) => { listeners.abort(); reject(cause) }
    source.addEventListener("updateend", () => { listeners.abort(); resolve() }, once)
    source.addEventListener("error", () => fail(error()), once)
    signal.addEventListener("abort", () => fail(signal.reason), once)
    try { source.appendBuffer(new Uint8Array(chunk).buffer) } catch (cause) { fail(cause) }
  })
}
