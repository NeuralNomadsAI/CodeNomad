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

export function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("webm")) return "webm"
  if (normalized.includes("ogg")) return "ogg"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  if (normalized.includes("mp4") || normalized.includes("aac")) return "m4a"
  return "webm"
}

export function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}
